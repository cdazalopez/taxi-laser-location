import { redisCmd } from "@/lib/cache";

/**
 * Auto-prevención de incidentes (circuit breaker para GHL).
 *
 * Idea: todas las llamadas a GHL pasan por `ghlFetch`. Cuando GHL empieza a
 * devolver 429 (cuota/rate-limit saturado), contamos los 429 por minuto y, al
 * superar el umbral, ABRIMOS un "circuito" en Redis. Mientras está abierto, los
 * consumidores DISCRECIONALES de GHL (agregador de KPIs, enriquecimiento del
 * monitor) se pausan solos → se libera cuota para los webhooks de clientes →
 * el circuito se cierra solo por TTL cuando pasa la tormenta. Además dispara UNA
 * alerta por SMS (debounced) al admin.
 *
 * Diseño consciente de la cuota de Redis: solo se escribe en Redis en los 429
 * (raros salvo incidente), y una vez abierto el circuito se deja de contar
 * (evita pile-on de escrituras).
 */

const THRESHOLD = Number(process.env.HEALTH_429_THRESHOLD ?? 15); // 429/min para abrir
const CIRCUIT_TTL = Number(process.env.HEALTH_CIRCUIT_TTL_SEC ?? 300); // 5 min abierto
const ALERT_DEBOUNCE = Number(process.env.HEALTH_ALERT_DEBOUNCE_SEC ?? 900); // 15 min

const CIRCUIT_KEY = "h:ghl:circuit";
const ALERT_KEY = "h:ghl:alert";

// Cache en memoria del estado del circuito (Fluid Compute reutiliza instancias)
// para no hacer un GET a Redis en cada llamada a GHL.
let circuitCache = { open: false, at: 0 };
const CACHE_MS = 15000;

/** ¿El circuito de GHL está abierto? (cacheado 15s en memoria). */
export async function isGhlCircuitOpen(): Promise<boolean> {
  if (Date.now() - circuitCache.at < CACHE_MS) return circuitCache.open;
  try {
    const v = await redisCmd(["GET", CIRCUIT_KEY]);
    circuitCache = { open: !!v, at: Date.now() };
  } catch {
    /* si Redis falla, asumir cerrado para no bloquear el flujo */
  }
  return circuitCache.open;
}

/** Reportar un 429 de GHL. Cuenta por minuto y abre el circuito si supera umbral. */
export async function reportGhl429(): Promise<void> {
  // Si ya lo tenemos como abierto en memoria, no seguir escribiendo en Redis.
  if (circuitCache.open && Date.now() - circuitCache.at < CACHE_MS) return;
  try {
    const minute = Math.floor(Date.now() / 60000);
    const key = `h:ghl:429:${minute}`;
    const n = Number(await redisCmd(["INCR", key])) || 0;
    await redisCmd(["EXPIRE", key, 180]);
    if (n >= THRESHOLD) await tripCircuit(n);
  } catch {
    /* no romper el flujo por un fallo de instrumentación */
  }
}

async function tripCircuit(count: number): Promise<void> {
  try {
    await redisCmd(["SET", CIRCUIT_KEY, String(Date.now()), "EX", CIRCUIT_TTL]);
  } catch {
    /* no-op */
  }
  circuitCache = { open: true, at: Date.now() };
  console.warn(`[health] CIRCUITO GHL ABIERTO (${count} 429/min) → load-shedding activado`);
  await maybeAlert(
    `TaxiLaser ALERTA: GHL rate-limit (${count} 429/min). Load-shedding activado (KPIs pausados, notificaciones por SMS de respaldo). Auto-recupera en ${Math.round(CIRCUIT_TTL / 60)} min.`
  );
}

/** Envía UNA alerta por SMS al admin (debounced). Requiere ALERT_PHONE. */
async function maybeAlert(msg: string): Promise<void> {
  try {
    const phone = process.env.ALERT_PHONE;
    if (!phone) return;
    const already = await redisCmd(["GET", ALERT_KEY]);
    if (already) return;
    await redisCmd(["SET", ALERT_KEY, "1", "EX", ALERT_DEBOUNCE]);
    const { sendRingCentralSms } = await import("@/lib/ringcentral");
    await sendRingCentralSms(phone, msg);
    console.log(`[health] alerta enviada a ${phone}`);
  } catch (err) {
    console.error("[health] alerta falló:", err);
  }
}

/** Snapshot para /api/health y el dashboard. */
export async function healthSnapshot(): Promise<{
  circuitOpen: boolean;
  ghl429LastMin: number;
  ghl429PrevMin: number;
  threshold: number;
}> {
  const minute = Math.floor(Date.now() / 60000);
  let cur = 0, prev = 0, open = false;
  try {
    cur = Number(await redisCmd(["GET", `h:ghl:429:${minute}`])) || 0;
    prev = Number(await redisCmd(["GET", `h:ghl:429:${minute - 1}`])) || 0;
    open = !!(await redisCmd(["GET", CIRCUIT_KEY]));
  } catch {
    /* devuelve lo que haya */
  }
  return { circuitOpen: open, ghl429LastMin: cur, ghl429PrevMin: prev, threshold: THRESHOLD };
}
