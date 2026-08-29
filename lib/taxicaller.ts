/**
 * Cliente mínimo de la API de TaxiCaller.
 *
 * Auth: la API key emite un JWT de corta vida.
 *   GET /api/v1/jwt/for-key?key={API_KEY}&sub=*
 * El JWT trae `aud` = ID de compañía (28658 para Taxi Laser). Se cachea en
 * memoria del proceso hasta ~60s antes de expirar.
 *
 * NOTA: los endpoints de datos (vehículos activos, viajes, ratings) aún no están
 * confirmados contra la doc oficial. `taxicallerGet` es el helper genérico listo
 * para cablearlos en cuanto tengamos las rutas exactas. Las funciones de datos
 * degradan a `null` (el dashboard muestra "pendiente") si el endpoint no existe.
 */

import { redisCmd } from "@/lib/cache";

const TC_BASE = process.env.TAXICALLER_BASE_URL?.replace(/\/+$/, "") ??
  "https://api.taxicaller.net/api/v1";

interface CachedJwt {
  token: string;
  companyId: string | null;
  expiresAt: number; // epoch ms
}
let jwtCache: CachedJwt | null = null;

function decodeAud(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
    return payload?.aud != null ? String(payload.aud) : null;
  } catch {
    return null;
  }
}

/** JWT de TaxiCaller (cacheado en memoria). Lanza si no hay API key. */
export async function getTaxiCallerJwt(): Promise<{ token: string; companyId: string | null }> {
  if (jwtCache && Date.now() < jwtCache.expiresAt) {
    return { token: jwtCache.token, companyId: jwtCache.companyId };
  }
  const key = process.env.TAXICALLER_API_KEY;
  if (!key) throw new Error("TAXICALLER_API_KEY no configurada");

  const res = await fetch(`${TC_BASE}/jwt/for-key?key=${encodeURIComponent(key)}&sub=*`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`TaxiCaller auth falló (${res.status})`);
  const data: any = await res.json();
  const token: string = data?.token;
  if (!token) throw new Error("TaxiCaller auth: sin token");

  const companyId = decodeAud(token);
  // El JWT dura ~5 min; margen de 60s.
  jwtCache = { token, companyId, expiresAt: Date.now() + 4 * 60 * 1000 };
  return { token, companyId };
}

/** GET genérico autenticado a la API de TaxiCaller. Devuelve {ok,status,data}. */
export async function taxicallerGet(
  path: string
): Promise<{ ok: boolean; status: number; data: any }> {
  const { token } = await getTaxiCallerJwt();
  const res = await fetch(`${TC_BASE}/${path.replace(/^\/+/, "")}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export interface TaxiCallerSnapshot {
  ok: boolean;
  activeVehicles: number | null; // vehículos con active=1 (habilitados en flota)
  fleetSize: number | null; // total de vehículos registrados
  driversToday: number | null; // conductores DISTINTOS con turno hoy (report shift)
  avgRating: number | null; // pendiente (no hay plantilla con rating)
  tripsToday: number | null; // report "Finished jobs"
  tripsYesterday: number | null;
  tripsLastWeek: number | null; // mismo día, semana pasada
  note?: string;
}

const TC_TZ = process.env.KPI_TZ ?? "America/New_York";
const TRIPS_TEMPLATE = Number(process.env.TAXICALLER_TRIPS_TEMPLATE ?? 19); // "Finished jobs"
const SHIFT_TEMPLATE = Number(process.env.TAXICALLER_SHIFT_TEMPLATE ?? 14343); // "Shift"
const SNAP_KEY = "tc:snapshot";
const SNAP_TS = "tc:snapshot:ts";
const SNAP_TTL = 3600;
const SNAP_MIN_MS = Number(process.env.TC_MIN_INTERVAL_SEC ?? 600) * 1000;

/** Fecha ET (YYYY-MM-DD) desplazada `offsetDays` desde hoy. */
function etDateStr(offsetDays: number): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: TC_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of dtf.formatToParts(new Date(Date.now() + offsetDays * 86400000))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Total de viajes en un período vía report. Descarga las filas pero solo usa
 * `results.total`. POST /reports/typed/generate (sub=reports|*).
 */
export async function getTripsTotal(
  companyId: string, start: string, end: string
): Promise<number | null> {
  try {
    const { token } = await getTaxiCallerJwt();
    const body = {
      company_id: Number(companyId),
      report_type: "jobs",
      output_format: "json",
      template_id: TRIPS_TEMPLATE,
      search_query: { period: { "@type": "custom", start, end } },
    };
    const res = await fetch(`${TC_BASE}/reports/typed/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return typeof data?.results?.total === "number" ? data.results.total : null;
  } catch {
    return null;
  }
}

// ── Conductores EN LÍNEA ahora (por webhooks de turno) ─────────────────────
// Sorted set: member = driverId, score = epoch ms del último evento "online".
// Un evento offline lo quita; entradas más viejas que TC_ONLINE_TTL_HOURS se
// purgan (protege contra eventos "fin de turno" perdidos → sin fantasmas).
const ONLINE_KEY = "tc:online";
const ONLINE_TTL_H = Number(process.env.TC_ONLINE_TTL_HOURS ?? 18);

/** Registra un evento de turno de un conductor (online=inicio, offline=fin). */
export async function recordShiftEvent(driverId: string, online: boolean): Promise<void> {
  const id = String(driverId ?? "").trim();
  if (!id) return;
  try {
    if (online) await redisCmd(["ZADD", ONLINE_KEY, String(Date.now()), id]);
    else await redisCmd(["ZREM", ONLINE_KEY, id]);
  } catch (err) {
    console.error("[tc-shift] recordShiftEvent falló:", err);
  }
}

/** Conductores en línea ahora (purgando los más viejos que el TTL). */
export async function getOnlineDriverCount(): Promise<number | null> {
  try {
    const cutoff = Date.now() - ONLINE_TTL_H * 3600 * 1000;
    await redisCmd(["ZREMRANGEBYSCORE", ONLINE_KEY, "0", String(cutoff)]);
    const n = await redisCmd(["ZCARD", ONLINE_KEY]);
    return Number(n ?? 0) || 0;
  } catch {
    return null;
  }
}

const SESSION_TEMPLATE = Number(process.env.TAXICALLER_SESSION_TEMPLATE ?? 9980);

/**
 * Reconcilia el set de "en línea" contra el report de sesiones de TaxiCaller:
 * si un conductor del set ya CERRÓ sesión (custom_6 = fin, posterior a su marca
 * de online), lo saca. Auto-sana eventos "Shift ended" perdidos → evita
 * fantasmas / sobreconteo. NO puede sembrar (las sesiones abiertas no salen en
 * el report); el alta la hace el webhook en tiempo real.
 */
export async function reconcileOnlineDrivers(): Promise<{ removed: number; checked: number }> {
  try {
    const { companyId, token } = await getTaxiCallerJwt();
    if (!companyId) return { removed: 0, checked: 0 };

    const body = {
      company_id: Number(companyId),
      report_type: "user_session",
      output_format: "json",
      template_id: SESSION_TEMPLATE,
      search_query: { period: { "@type": "custom", start: `${etDateStr(-1)}T00:00:00`, end: `${etDateStr(1)}T00:00:00` } },
    };
    const res = await fetch(`${TC_BASE}/reports/typed/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) return { removed: 0, checked: 0 };
    const data: any = await res.json();
    const rows: any[] = data?.rows ?? [];

    // driverId → fin de sesión más reciente (ms)
    const maxEnd: Record<string, number> = {};
    for (const r of rows) {
      const id = String(r?.custom_2 ?? "").trim();
      const end = Number(r?.custom_6) || 0;
      if (id && end) maxEnd[id] = Math.max(maxEnd[id] ?? 0, end);
    }

    const arr = (await redisCmd(["ZRANGE", ONLINE_KEY, "0", "-1", "WITHSCORES"])) as string[] | null;
    if (!Array.isArray(arr)) return { removed: 0, checked: 0 };

    let removed = 0, checked = 0;
    for (let i = 0; i < arr.length; i += 2) {
      const id = arr[i];
      const score = Number(arr[i + 1]) || 0;
      checked++;
      // Cerró DESPUÉS de su marca de online → ya no está en línea.
      if (maxEnd[id] && maxEnd[id] > score) {
        await redisCmd(["ZREM", ONLINE_KEY, id]);
        removed++;
      }
    }
    return { removed, checked };
  } catch {
    return { removed: 0, checked: 0 };
  }
}

/** Conductores DISTINTOS con al menos un turno hoy (report shift). */
export async function getDriversWithShiftToday(companyId: string): Promise<number | null> {
  try {
    const { token } = await getTaxiCallerJwt();
    const body = {
      company_id: Number(companyId),
      report_type: "shift",
      output_format: "json",
      template_id: SHIFT_TEMPLATE,
      search_query: { period: { "@type": "custom", start: `${etDateStr(0)}T00:00:00`, end: `${etDateStr(1)}T00:00:00` } },
    };
    const res = await fetch(`${TC_BASE}/reports/typed/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const rows: any[] = data?.rows ?? [];
    const names = new Set(rows.map((r) => String(r?.["driver.name_name"] ?? "").trim()).filter(Boolean));
    return names.size;
  } catch {
    return null;
  }
}

const EMPTY_SNAP: TaxiCallerSnapshot = {
  ok: false, activeVehicles: null, fleetSize: null, driversToday: null, avgRating: null,
  tripsToday: null, tripsYesterday: null, tripsLastWeek: null,
};

/** Trae TODOS los vehículos (vehicle/list es paginado: requiere offset+limit). */
async function getAllVehicles(companyId: string): Promise<any[] | null> {
  const out: any[] = [];
  const limit = 200;
  for (let i = 0, offset = 0; i < 20; i++, offset += limit) {
    const r = await taxicallerGet(`company/${companyId}/vehicle/list?offset=${offset}&limit=${limit}`);
    if (!r.ok || !Array.isArray(r.data?.list)) return out.length ? out : null;
    out.push(...r.data.list);
    if (r.data.list.length < limit) break;
  }
  return out;
}

/** Construye el snapshot desde la API (flota + conductores hoy + viajes). */
async function buildSnapshot(): Promise<TaxiCallerSnapshot> {
  try {
    const { companyId } = await getTaxiCallerJwt();
    if (!companyId) return { ...EMPTY_SNAP, note: "sin company id" };

    const [vehicles, driversToday, tToday, tYest, tLastWk] = await Promise.all([
      getAllVehicles(companyId),
      getDriversWithShiftToday(companyId),
      getTripsTotal(companyId, `${etDateStr(0)}T00:00:00`, `${etDateStr(1)}T00:00:00`),
      getTripsTotal(companyId, `${etDateStr(-1)}T00:00:00`, `${etDateStr(0)}T00:00:00`),
      getTripsTotal(companyId, `${etDateStr(-7)}T00:00:00`, `${etDateStr(-6)}T00:00:00`),
    ]);

    let activeVehicles: number | null = null;
    let fleetSize: number | null = null;
    if (Array.isArray(vehicles)) {
      fleetSize = vehicles.length;
      activeVehicles = vehicles.filter((v) => v?.active === 1).length;
    }
    return {
      ok: true, activeVehicles, fleetSize, driversToday, avgRating: null,
      tripsToday: tToday, tripsYesterday: tYest, tripsLastWeek: tLastWk, note: "live",
    };
  } catch (err) {
    return { ...EMPTY_SNAP, note: String((err as Error)?.message ?? err).slice(0, 120) };
  }
}

/** Reconstruye y cachea el snapshot (Redis) + reconcilia el set de en-línea. */
export async function refreshTaxiCallerSnapshot(): Promise<TaxiCallerSnapshot> {
  const snap = await buildSnapshot();
  try {
    await redisCmd(["SET", SNAP_KEY, JSON.stringify(snap), "EX", SNAP_TTL]);
    await redisCmd(["SET", SNAP_TS, String(Date.now()), "EX", SNAP_TTL]);
  } catch {
    /* no-op */
  }
  // Auto-sana el conteo en vivo (quita conductores que ya cerraron sesión).
  try {
    const rec = await reconcileOnlineDrivers();
    if (rec.removed) console.log(`[tc-online] reconcile: -${rec.removed} de ${rec.checked}`);
  } catch {
    /* no-op */
  }
  return snap;
}

/** ¿El snapshot cacheado ya está viejo (> TC_MIN_INTERVAL_SEC)? */
export async function shouldRefreshTaxiCaller(): Promise<boolean> {
  try {
    const v = await redisCmd(["GET", SNAP_TS]);
    return Date.now() - (Number(v ?? 0) || 0) > SNAP_MIN_MS;
  } catch {
    return true;
  }
}

/**
 * Snapshot cacheado (rápido). Si no hay caché aún, lo construye una vez (bloquea
 * ~15s la primera vez; se pre-calienta tras el deploy). El refresco periódico lo
 * dispara el dashboard en background vía refreshTaxiCallerSnapshot().
 */
export async function getTaxiCallerSnapshot(): Promise<TaxiCallerSnapshot> {
  try {
    const raw = await redisCmd(["GET", SNAP_KEY]);
    if (typeof raw === "string" && raw.length) return JSON.parse(raw) as TaxiCallerSnapshot;
  } catch {
    /* si falla el caché, construir */
  }
  return refreshTaxiCallerSnapshot();
}
