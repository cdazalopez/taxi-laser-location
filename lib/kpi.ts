import { redisCmd } from "@/lib/cache";
import {
  listConversations,
  getConversationMessages,
  listLocationUsers,
  type Platform,
} from "@/lib/ghl";

/**
 * Agregador de KPIs de dispatchers (cadencia de atención) a partir de las
 * conversaciones de GoHighLevel. READ-ONLY sobre GHL.
 *
 * Idea: cada corrida recomputa una ventana móvil de días (por defecto 2) y
 * SOBRESCRIBE el agregado de cada día → idempotente, sin bookkeeping de dedup.
 * El dashboard lee los agregados por día (barato, sin golpear GHL).
 *
 * Un "tiempo de respuesta" es el lapso entre el PRIMER entrante sin contestar de
 * un cliente y la PRIMERA respuesta HUMANA del negocio (outbound con userId real).
 * Las notificaciones automáticas (outbound sin userId) NO cuentan como respuesta.
 */

const TZ = process.env.KPI_TZ ?? "America/New_York";
const DAY_KEY = (d: string) => `kpi:day:${d}`;
const DAY_TTL = 60 * 60 * 24 * 400; // ~13 meses

// Umbral de SLA (respuesta considerada "tardía") en segundos.
const SLA_SECONDS = Number(process.env.KPI_SLA_SECONDS ?? 300);

// Buckets de histograma de tiempo de respuesta (límites superiores, ms).
const BUCKET_MS = [60, 180, 300, 600, 1800, 3600].map((s) => s * 1000);
export const BUCKET_LABELS = ["<1m", "1-3m", "3-5m", "5-10m", "10-30m", "30-60m", ">60m"];

function bucketIndex(ms: number): number {
  for (let i = 0; i < BUCKET_MS.length; i++) if (ms <= BUCKET_MS[i]) return i;
  return BUCKET_MS.length; // >60m
}

/** {day:'YYYY-MM-DD', hour:0..23} en la zona horaria del negocio. */
function partsET(ms: number): { day: string; hour: number } {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0;
  return { day: `${p.year}-${p.month}-${p.day}`, hour };
}

// ── Estructura del agregado diario ────────────────────────────────────────
interface RespStats {
  c: number; // count
  sum: number; // suma de ms
  max: number; // ms máximo
  sla: number; // # sobre el umbral SLA
  hist: number[]; // histograma (len BUCKET_LABELS)
}
function emptyResp(): RespStats {
  return { c: 0, sum: 0, max: 0, sla: 0, hist: new Array(BUCKET_LABELS.length).fill(0) };
}
function addResp(r: RespStats, ms: number) {
  r.c++;
  r.sum += ms;
  if (ms > r.max) r.max = ms;
  if (ms > SLA_SECONDS * 1000) r.sla++;
  r.hist[bucketIndex(ms)]++;
}

export interface DayAgg {
  day: string;
  updatedAt: string;
  inbound: { total: number; byPlatform: Record<string, number>; byHour: number[] };
  outbound: { total: number; byPlatform: Record<string, number> };
  resp: {
    byHour: number[]; // respuestas por hora (del entrante)
    // matriz usuario → plataforma → stats
    users: Record<string, { name?: string; plat: Record<string, RespStats> }>;
  };
}

function emptyDay(day: string): DayAgg {
  return {
    day,
    updatedAt: new Date().toISOString(),
    inbound: { total: 0, byPlatform: {}, byHour: new Array(24).fill(0) },
    outbound: { total: 0, byPlatform: {} },
    resp: { byHour: new Array(24).fill(0), users: {} },
  };
}

/** Lista de días ET (YYYY-MM-DD) entre dos epoch ms, inclusive. */
export function listDays(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Avanza de día en día usando mediodía para evitar bordes de DST.
  for (let t = fromMs; t <= toMs + 86400000; t += 86400000) {
    const d = partsET(t).day;
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

/**
 * Recomputa y persiste los agregados de la ventana [hoy-(windowDays-1) .. hoy].
 * Devuelve un resumen de la corrida para logging.
 */
export async function aggregateWindow(
  windowDays = Number(process.env.KPI_WINDOW_DAYS ?? 2)
): Promise<{ days: string[]; conversations: number; responses: number; inbound: number }> {
  const now = Date.now();
  const targetDays = new Set<string>();
  for (let i = 0; i < windowDays; i++) targetDays.add(partsET(now - i * 86400000).day);

  // Slack de 6h para cubrir mensajes cerca de medianoche ET.
  const sinceMs = now - windowDays * 86400000 - 6 * 3600000;

  const [users, convs] = await Promise.all([
    listLocationUsers(),
    listConversations({ sinceMs, max: Number(process.env.KPI_MAX_CONVERSATIONS ?? 800) }),
  ]);

  const excluded = new Set(
    (process.env.KPI_EXCLUDE_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const days: Record<string, DayAgg> = {};
  const dayFor = (d: string) => (days[d] ??= emptyDay(d));

  let responses = 0;
  let inbound = 0;

  for (const conv of convs) {
    let msgs;
    try {
      msgs = await getConversationMessages(conv.id, { sinceMs });
    } catch (err) {
      console.error(`[kpi] mensajes de conv ${conv.id} fallaron:`, err);
      continue;
    }

    let pending: { ms: number; platform: Platform; day: string; hour: number } | null = null;
    for (const m of msgs) {
      const { day, hour } = partsET(m.ms);
      if (!targetDays.has(day)) continue;

      if (m.direction === "inbound") {
        const agg = dayFor(day);
        agg.inbound.total++;
        agg.inbound.byPlatform[m.platform] = (agg.inbound.byPlatform[m.platform] ?? 0) + 1;
        agg.inbound.byHour[hour]++;
        inbound++;
        if (!pending) pending = { ms: m.ms, platform: m.platform, day, hour };
      } else {
        const agg = dayFor(day);
        agg.outbound.total++;
        agg.outbound.byPlatform[m.platform] = (agg.outbound.byPlatform[m.platform] ?? 0) + 1;

        const human = m.userId && !excluded.has(m.userId);
        if (human && pending) {
          const respMs = m.ms - pending.ms;
          if (respMs >= 0) {
            const pAgg = dayFor(pending.day);
            pAgg.resp.byHour[pending.hour]++;
            const uid = m.userId!;
            const u = (pAgg.resp.users[uid] ??= { name: users[uid], plat: {} });
            if (!u.name && users[uid]) u.name = users[uid];
            const st = (u.plat[pending.platform] ??= emptyResp());
            addResp(st, respMs);
            responses++;
          }
          pending = null;
        }
      }
    }
  }

  // Persistir solo los días objetivo (idempotente, overwrite).
  for (const d of Array.from(targetDays)) {
    const agg = days[d] ?? emptyDay(d);
    agg.updatedAt = new Date().toISOString();
    try {
      await redisCmd(["SET", DAY_KEY(d), JSON.stringify(agg), "EX", DAY_TTL]);
    } catch (err) {
      console.error(`[kpi] persistir día ${d} falló:`, err);
    }
  }

  return { days: Array.from(targetDays), conversations: convs.length, responses, inbound };
}

// ── Refresco on-demand con throttle (para planes sin cron frecuente) ───────
const LASTRUN_KEY = "kpi:lastrun";
const MIN_INTERVAL_MS = Number(process.env.KPI_MIN_INTERVAL_SEC ?? 300) * 1000;

/** ¿Toca recalcular? (último run hace más de KPI_MIN_INTERVAL_SEC). */
export async function shouldRefresh(): Promise<boolean> {
  try {
    const v = await redisCmd(["GET", LASTRUN_KEY]);
    return Date.now() - (Number(v ?? 0) || 0) > MIN_INTERVAL_MS;
  } catch {
    return true;
  }
}

/** Reclama el slot (marca el run) y recomputa la ventana. */
export async function runAggregation(windowDays?: number) {
  try {
    await redisCmd(["SET", LASTRUN_KEY, String(Date.now())]);
  } catch {
    /* si el marcado falla igual corremos */
  }
  return aggregateWindow(windowDays);
}

/** Lee los agregados de una lista de días (los ausentes se omiten). */
export async function getDays(days: string[]): Promise<DayAgg[]> {
  const out: DayAgg[] = [];
  for (const d of days) {
    try {
      const raw = await redisCmd(["GET", DAY_KEY(d)]);
      if (typeof raw === "string" && raw.length) out.push(JSON.parse(raw) as DayAgg);
    } catch {
      /* omitir día ilegible */
    }
  }
  return out;
}

// ── Resumen para el dashboard (con filtros usuario/plataforma) ─────────────
export interface KpiSummary {
  range: { from: string; to: string; days: number };
  filters: { user: string | null; platform: string | null };
  inbound: { total: number; byPlatform: Record<string, number>; byHour: number[] };
  responses: {
    count: number;
    avgMs: number | null;
    p50Ms: number | null;
    p90Ms: number | null;
    maxMs: number;
    slaBreaches: number;
    slaPct: number | null; // % dentro de SLA
    byHour: number[];
    hist: number[];
    histLabels: string[];
  };
  byUser: Array<{
    userId: string;
    name: string;
    count: number;
    avgMs: number | null;
    slaBreaches: number;
  }>;
  byPlatform: Record<string, { count: number; avgMs: number | null }>;
  slaSeconds: number;
}

/** Percentil aproximado desde el histograma (devuelve el límite superior del bucket). */
function percentileFromHist(hist: number[], p: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = total * p;
  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    cum += hist[i];
    if (cum >= target) return i < BUCKET_MS.length ? BUCKET_MS[i] : BUCKET_MS[BUCKET_MS.length - 1] * 2;
  }
  return null;
}

export function summarize(
  aggs: DayAgg[],
  filter: { user?: string | null; platform?: string | null } = {}
): KpiSummary {
  const fUser = filter.user || null;
  const fPlat = filter.platform || null;

  const inbound = { total: 0, byPlatform: {} as Record<string, number>, byHour: new Array(24).fill(0) };
  const respHist = new Array(BUCKET_LABELS.length).fill(0);
  const respByHour = new Array(24).fill(0);
  let count = 0,
    sum = 0,
    max = 0,
    sla = 0;
  const byUser: Record<string, { name: string; count: number; sum: number; sla: number }> = {};
  const byPlatform: Record<string, { count: number; sum: number }> = {};

  for (const a of aggs) {
    // Inbound (filtrable por plataforma; no por usuario, lo escribe el cliente).
    if (!fPlat) {
      inbound.total += a.inbound.total;
      for (let h = 0; h < 24; h++) inbound.byHour[h] += a.inbound.byHour[h] ?? 0;
      for (const [p, n] of Object.entries(a.inbound.byPlatform))
        inbound.byPlatform[p] = (inbound.byPlatform[p] ?? 0) + n;
    } else {
      const n = a.inbound.byPlatform[fPlat] ?? 0;
      inbound.total += n;
      inbound.byPlatform[fPlat] = (inbound.byPlatform[fPlat] ?? 0) + n;
    }

    // Respuestas: recorrer matriz usuario × plataforma aplicando filtros.
    for (const [uid, u] of Object.entries(a.resp.users)) {
      if (fUser && uid !== fUser) continue;
      for (const [p, st] of Object.entries(u.plat)) {
        if (fPlat && p !== fPlat) continue;
        count += st.c;
        sum += st.sum;
        if (st.max > max) max = st.max;
        sla += st.sla;
        for (let i = 0; i < respHist.length; i++) respHist[i] += st.hist[i] ?? 0;
        const bu = (byUser[uid] ??= { name: u.name || uid, count: 0, sum: 0, sla: 0 });
        bu.count += st.c;
        bu.sum += st.sum;
        bu.sla += st.sla;
        const bp = (byPlatform[p] ??= { count: 0, sum: 0 });
        bp.count += st.c;
        bp.sum += st.sum;
      }
    }
    // Respuestas por hora solo cuando no se filtra por usuario/plataforma
    // (byHour se guarda a nivel día, no desglosado).
    if (!fUser && !fPlat) for (let h = 0; h < 24; h++) respByHour[h] += a.resp.byHour[h] ?? 0;
  }

  const days = aggs.map((a) => a.day).sort();
  return {
    range: { from: days[0] ?? "", to: days[days.length - 1] ?? "", days: aggs.length },
    filters: { user: fUser, platform: fPlat },
    inbound,
    responses: {
      count,
      avgMs: count ? Math.round(sum / count) : null,
      p50Ms: percentileFromHist(respHist, 0.5),
      p90Ms: percentileFromHist(respHist, 0.9),
      maxMs: max,
      slaBreaches: sla,
      slaPct: count ? Math.round(((count - sla) / count) * 100) : null,
      byHour: respByHour,
      hist: respHist,
      histLabels: BUCKET_LABELS,
    },
    byUser: Object.entries(byUser)
      .map(([userId, v]) => ({
        userId,
        name: v.name,
        count: v.count,
        avgMs: v.count ? Math.round(v.sum / v.count) : null,
        slaBreaches: v.sla,
      }))
      .sort((a, b) => b.count - a.count),
    byPlatform: Object.fromEntries(
      Object.entries(byPlatform).map(([p, v]) => [
        p,
        { count: v.count, avgMs: v.count ? Math.round(v.sum / v.count) : null },
      ])
    ),
    slaSeconds: SLA_SECONDS,
  };
}
