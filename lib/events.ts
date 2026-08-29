import { redisCmd } from "@/lib/cache";

const LIST_KEY = "tl:events";
const MAX_EVENTS = 500;

export interface EventRecord {
  ts: string; // ISO
  event: string;
  job_id: string;
  phone: string | null;
  phoneSource: "webhook" | "cache" | "none";
  contactId: string | null;
  channel: "ghl-text" | "ghl-template" | "ghl-workflow" | "meta" | "ghl-sms" | null;
  inWindow: boolean | null;
  outcome: "sent" | "no_phone" | "ignored" | "error";
  ghlOk: boolean | null;
  ghlStatus: number | null;
  messageId: string | null;
  note?: string | null;
}

/** Registra un evento procesado en Redis (lista recortada a MAX_EVENTS). No lanza. */
export async function recordEvent(rec: EventRecord): Promise<void> {
  try {
    await redisCmd(["LPUSH", LIST_KEY, JSON.stringify(rec)]);
    await redisCmd(["LTRIM", LIST_KEY, 0, MAX_EVENTS - 1]);
  } catch (err) {
    console.error("[events] recordEvent falló:", err);
  }
}

// Contadores como claves string individuales (INCR/GET son confiables en esta
// DB; HGETALL de hash no devolvía datos). Prefijo tl:count:<campo>.
const COUNTER_PREFIX = "tl:count:";
const COUNTER_FIELDS = [
  "total",
  "ch:ghl-text",
  "ch:ghl-template",
  "ch:ghl-workflow",
  "ch:meta",
  "ev:waiting_for_passenger",
  "ev:job_marked_as_delivered",
  "ev:cancelled_by_company",
];

/**
 * Incrementa contadores acumulados (persistentes, no limitados por MAX_EVENTS).
 * Total histórico de mensajes enviados + desglose por canal/evento.
 */
export async function bumpCounters(fields: string[]): Promise<void> {
  try {
    for (const f of fields) {
      await redisCmd(["INCR", COUNTER_PREFIX + f]);
    }
  } catch (err) {
    console.error("[events] bumpCounters falló:", err);
  }
}

/**
 * Lee los contadores acumulados como { campo: número }.
 * Usa GET individual por clave (las lecturas en bloque —MGET/HGETALL— no son
 * confiables en esta DB de Upstash; GET de una sola clave sí lo es).
 */
export async function getCounters(): Promise<Record<string, number>> {
  try {
    const pairs = await Promise.all(
      COUNTER_FIELDS.map(async (f) => {
        const v = await redisCmd(["GET", COUNTER_PREFIX + f]);
        return [f, Number(v ?? 0) || 0] as const;
      })
    );
    return Object.fromEntries(pairs);
  } catch (err) {
    console.error("[events] getCounters falló:", err);
    return {};
  }
}

// Contador de viajes completados por día ET (para "viajes del día" del
// dashboard, mientras se cablea la API de TaxiCaller). Persistente, ~13 meses.
const TRIP_TZ = process.env.KPI_TZ ?? "America/New_York";
function etDay(ms: number): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: TRIP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** Suma 1 al contador de viajes completados de hoy (ET). No lanza. */
export async function bumpTripDay(): Promise<void> {
  const key = `tl:trips:${etDay(Date.now())}`;
  try {
    await redisCmd(["INCR", key]);
    await redisCmd(["EXPIRE", key, 60 * 60 * 24 * 400]);
  } catch (err) {
    console.error("[events] bumpTripDay falló:", err);
  }
}

/** Lee los contadores de viajes de una lista de días ET → { día: número }. */
export async function getTripDays(days: string[]): Promise<Record<string, number>> {
  try {
    const pairs = await Promise.all(
      days.map(async (d) => {
        const v = await redisCmd(["GET", `tl:trips:${d}`]);
        return [d, Number(v ?? 0) || 0] as const;
      })
    );
    return Object.fromEntries(pairs);
  } catch {
    return {};
  }
}

/** Devuelve los últimos `n` eventos (más recientes primero). */
export async function getRecentEvents(n = 200): Promise<EventRecord[]> {
  try {
    const raw = (await redisCmd(["LRANGE", LIST_KEY, 0, n - 1])) as
      | string[]
      | null;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((s) => {
        try {
          return JSON.parse(s) as EventRecord;
        } catch {
          return null;
        }
      })
      .filter((x): x is EventRecord => x !== null);
  } catch (err) {
    console.error("[events] getRecentEvents falló:", err);
    return [];
  }
}
