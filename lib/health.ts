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
const ALERT_DEBOUNCE = Number(process.env.HEALTH_ALERT_DEBOUNCE_SEC ?? 3600); // 1h por tipo
const GLOBAL_CAP = Number(process.env.HEALTH_ALERT_GLOBAL_SEC ?? 1800); // máx 1 alerta / 30 min (total)
const DELIVERY_FAIL_THRESHOLD = Number(process.env.HEALTH_DELIVERY_FAIL_THRESHOLD ?? 10); // fallos/min

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
  await alert(
    "ghl-429",
    `TaxiLaser ALERTA: GHL rate-limit (${count} 429/min). Load-shedding activado (KPIs pausados, notificaciones por SMS de respaldo). Auto-recupera en ${Math.round(CIRCUIT_TTL / 60)} min.`
  );
}

// Debounce en memoria por-tipo (por instancia). Complementa el debounce en Redis,
// y es el ÚNICO debounce cuando Redis es justamente lo que está fallando.
const memDebounce: Record<string, number> = {};

/**
 * Envía una alerta por SMS a todos los `ALERT_PHONE` (lista por comas), con
 * debounce POR TIPO (para que alertas distintas no se supriman entre sí).
 * `redisless=true` cuando el problema es Redis mismo (no usar Redis para debounce).
 */
async function alert(type: string, msg: string, redisless = false): Promise<void> {
  try {
    if (process.env.ALERTS_ENABLED === "off") return; // kill switch
    const phones = (process.env.ALERT_PHONE ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (!phones.length) return;

    // TOPE GLOBAL anti-flood: como máximo 1 alerta (de cualquier tipo) cada
    // HEALTH_ALERT_GLOBAL_SEC. El sistema ya se auto-mitiga, así que no hace
    // falta un SMS por cada tormenta — basta un aviso ocasional.
    if (Date.now() - (memDebounce.__global ?? 0) < GLOBAL_CAP * 1000) return;

    // Debounce por-tipo en memoria (siempre).
    if (Date.now() - (memDebounce[type] ?? 0) < ALERT_DEBOUNCE * 1000) return;

    // Debounce cross-instancia en Redis (por-tipo + tope global), salvo cuando
    // Redis es lo que falla.
    if (!redisless) {
      try {
        if (await redisCmd(["GET", `${ALERT_KEY}:global`])) return;
        if (await redisCmd(["GET", `${ALERT_KEY}:${type}`])) return;
        await redisCmd(["SET", `${ALERT_KEY}:${type}`, "1", "EX", ALERT_DEBOUNCE]);
        await redisCmd(["SET", `${ALERT_KEY}:global`, "1", "EX", GLOBAL_CAP]);
      } catch {
        /* si Redis falla, seguimos con el debounce en memoria */
      }
    }
    memDebounce[type] = Date.now();
    memDebounce.__global = Date.now();

    const { sendRingCentralSms } = await import("@/lib/ringcentral");
    for (const phone of phones) {
      try {
        await sendRingCentralSms(phone, msg);
        console.log(`[health] alerta '${type}' → ${phone}`);
      } catch (err) {
        console.error(`[health] alerta '${type}' a ${phone} falló:`, err);
      }
    }
  } catch (err) {
    console.error("[health] alert falló:", err);
  }
}

/**
 * Token OAuth de GHL inválido (invalid_grant): el provider de mensajes queda sin
 * auth hasta RE-AUTORIZAR manualmente. No hay auto-fix → solo alerta urgente.
 */
export async function reportGhlAuthFailure(detail: string): Promise<void> {
  console.error(`[health] GHL OAuth inválido: ${detail}`);
  await alert(
    "ghl-auth",
    `TaxiLaser ALERTA CRÍTICA: token OAuth de GHL inválido (invalid_grant). Hay que RE-AUTORIZAR la app en /oauth/callback — mientras tanto los mensajes SMS por el provider de GHL no funcionan.`
  );
}

/**
 * Redis (Upstash) fallando (p.ej. cuota agotada). Afecta tokens/caché/notifs.
 * Alerta SIN usar Redis (es lo que falla) — solo debounce en memoria.
 */
export async function reportRedisError(): Promise<void> {
  await alert(
    "redis",
    `TaxiLaser ALERTA: Redis (Upstash) está fallando — puede afectar tokens de GHL, caché y notificaciones. Revisar la cuota/estado de Upstash.`,
    true
  );
}

/**
 * Resultado de una notificación a cliente. Cuenta fallos por minuto y alerta si
 * superan el umbral (captura fallos NO-429 también: RC caído, Meta 403, etc.).
 */
export async function reportDeliveryOutcome(ok: boolean): Promise<void> {
  if (ok) return; // solo contamos fallos (bajo volumen normal → poca carga a Redis)
  try {
    const minute = Math.floor(Date.now() / 60000);
    const key = `h:deliv:fail:${minute}`;
    const n = Number(await redisCmd(["INCR", key])) || 0;
    await redisCmd(["EXPIRE", key, 180]);
    if (n >= DELIVERY_FAIL_THRESHOLD) {
      await alert(
        "delivery",
        `TaxiLaser ALERTA: ${n} notificaciones fallidas en el último minuto. Revisar GHL/RingCentral (el fallback a SMS sigue intentando).`
      );
    }
  } catch {
    /* no romper el flujo del webhook por instrumentación */
  }
}

/** Envía una alerta de PRUEBA a todos los ALERT_PHONE (sin debounce). */
export async function sendTestAlert(): Promise<{ sent: string[]; failed: string[] }> {
  const phones = (process.env.ALERT_PHONE ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const out = { sent: [] as string[], failed: [] as string[] };
  if (!phones.length) return out;
  const { sendRingCentralSms } = await import("@/lib/ringcentral");
  for (const phone of phones) {
    try {
      const r = await sendRingCentralSms(phone, "TaxiLaser: prueba de alertas ✅ Este número recibirá avisos si el sistema detecta un problema (ej. rate-limit de GHL).");
      (r.ok ? out.sent : out.failed).push(phone);
    } catch {
      out.failed.push(phone);
    }
  }
  return out;
}

/** Snapshot para /api/health y el dashboard. */
export async function healthSnapshot(): Promise<{
  circuitOpen: boolean;
  ghl429LastMin: number;
  ghl429PrevMin: number;
  threshold: number;
  deliveryFailLastMin: number;
  deliveryFailThreshold: number;
}> {
  const minute = Math.floor(Date.now() / 60000);
  let cur = 0, prev = 0, open = false, deliv = 0;
  try {
    cur = Number(await redisCmd(["GET", `h:ghl:429:${minute}`])) || 0;
    prev = Number(await redisCmd(["GET", `h:ghl:429:${minute - 1}`])) || 0;
    open = !!(await redisCmd(["GET", CIRCUIT_KEY]));
    deliv = Number(await redisCmd(["GET", `h:deliv:fail:${minute}`])) || 0;
  } catch {
    /* devuelve lo que haya */
  }
  return {
    circuitOpen: open,
    ghl429LastMin: cur,
    ghl429PrevMin: prev,
    threshold: THRESHOLD,
    deliveryFailLastMin: deliv,
    deliveryFailThreshold: DELIVERY_FAIL_THRESHOLD,
  };
}
