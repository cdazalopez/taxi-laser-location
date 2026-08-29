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
  activeVehicles: number | null; // vehículos con active=1 en la flota
  fleetSize: number | null; // total de vehículos registrados
  avgRating: number | null; // pendiente (vía reports)
  tripsToday: number | null; // se cuenta por webhooks; aquí null
  note?: string;
}

/**
 * Snapshot operativo de TaxiCaller.
 *   GET /company/{id}/vehicle/list → { list:[{active,...}] } → activos de la flota.
 * Rating y viajes históricos requieren generar reports (/reports/typed/generate),
 * pendiente de cablear el schema del POST.
 */
export async function getTaxiCallerSnapshot(): Promise<TaxiCallerSnapshot> {
  const base: TaxiCallerSnapshot = {
    ok: false,
    activeVehicles: null,
    fleetSize: null,
    avgRating: null,
    tripsToday: null,
  };
  try {
    const { companyId } = await getTaxiCallerJwt();
    if (!companyId) return { ...base, note: "sin company id" };

    const veh = await taxicallerGet(`company/${companyId}/vehicle/list`);
    if (veh.ok && Array.isArray(veh.data?.list)) {
      const list: any[] = veh.data.list;
      return {
        ok: true,
        activeVehicles: list.filter((v) => v?.active === 1).length,
        fleetSize: list.length,
        avgRating: null,
        tripsToday: null,
        note: `flota (rating/viajes vía reports, pendiente)`,
      };
    }
    return { ...base, ok: true, note: `auth OK (company ${companyId}); vehicle/list ${veh.status}` };
  } catch (err) {
    return { ...base, note: String((err as Error)?.message ?? err).slice(0, 120) };
  }
}
