/**
 * Caché job_id → teléfono sobre Redis (Upstash REST API).
 *
 * `waiting_for_passenger` trae el teléfono en el webhook y lo guarda; los
 * eventos posteriores del mismo job (`job_marked_as_delivered`,
 * `cancelled_by_company`) llegan SIN teléfono y lo recuperan de aquí.
 *
 * Soporta los nombres de env de la integración de Vercel (KV_REST_API_*) y los
 * de Upstash directo (UPSTASH_REDIS_REST_*). Si no hay KV configurado, todas
 * las funciones hacen no-op silencioso (no rompen el flujo principal).
 */
const REST_URL =
  process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

/** TTL por defecto: 48h (un viaje se completa mucho antes). */
const DEFAULT_TTL = 60 * 60 * 48;

export async function redisCmd(args: (string | number)[]): Promise<unknown> {
  if (!REST_URL || !REST_TOKEN) return null;
  try {
    const res = await fetch(REST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      // Evita que el Data Cache de Next.js congele las respuestas de Redis.
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`[cache] comando falló (${res.status}):`, await res.text());
      notifyRedisError();
      return null;
    }
    const data: any = await res.json();
    return data?.result ?? null;
  } catch (err) {
    console.error("[cache] error:", err);
    notifyRedisError();
    return null;
  }
}

// Alerta de Redis caído (import dinámico para evitar ciclo cache↔health;
// reportRedisError NO usa Redis, así que no recursiona). Fire-and-forget.
function notifyRedisError(): void {
  import("@/lib/health")
    .then((h) => h.reportRedisError())
    .catch(() => {});
}

/** Guarda el teléfono del pasajero para un job (con TTL). */
export async function cachePhoneForJob(
  jobId: string,
  phone: string,
  ttlSeconds: number = DEFAULT_TTL
): Promise<void> {
  if (!jobId || !phone) return;
  await redisCmd(["SET", `job:${jobId}`, phone, "EX", ttlSeconds]);
}

/** Recupera el teléfono cacheado para un job, o null si no existe. */
export async function getCachedPhoneForJob(
  jobId: string
): Promise<string | null> {
  if (!jobId) return null;
  const result = await redisCmd(["GET", `job:${jobId}`]);
  return typeof result === "string" && result.length ? result : null;
}

// ───────────────────────────────────────────────────────────────────────────
// Caché teléfono → contactId de GHL.
//
// Resolver el contacto en GHL cuesta 1-2 llamadas (búsqueda + upsert de
// respaldo) por CADA evento. Un mismo pasajero repite viajes y un mismo viaje
// dispara varios eventos (arrival → delivered → cancelled): todos apuntan al
// mismo contactId. Cachearlo elimina esas llamadas y evita agotar la cuota
// diaria de la API de GHL (la causa de los 429 que tumbaban los envíos).
// ───────────────────────────────────────────────────────────────────────────

/** TTL del contactId: 30 días (el id de un contacto de GHL no cambia). */
const CONTACT_TTL = 60 * 60 * 24 * 30;

/** Guarda el contactId de GHL para un teléfono normalizado. */
export async function cacheContactIdForPhone(
  phone: string,
  contactId: string,
  ttlSeconds: number = CONTACT_TTL
): Promise<void> {
  if (!phone || !contactId) return;
  await redisCmd(["SET", `ghlcontact:${phone}`, contactId, "EX", ttlSeconds]);
}

/** Recupera el contactId cacheado para un teléfono, o null si no existe. */
export async function getCachedContactIdForPhone(
  phone: string
): Promise<string | null> {
  if (!phone) return null;
  const result = await redisCmd(["GET", `ghlcontact:${phone}`]);
  return typeof result === "string" && result.length ? result : null;
}

/** Invalida el contactId cacheado (p.ej. si un envío falla con 404 stale). */
export async function invalidateContactIdForPhone(phone: string): Promise<void> {
  if (!phone) return;
  await redisCmd(["DEL", `ghlcontact:${phone}`]);
}

// ───────────────────────────────────────────────────────────────────────────
// Cola de SMS entrantes fallidos (dead-letter). Si GHL rechaza el registro de
// un SMS entrante (típicamente 429), en vez de PERDER el mensaje del cliente lo
// encolamos aquí y se reprocesa cuando GHL está sano. Evita el "desaparecen /
// no se encuentran en la búsqueda" de los entrantes.
// ───────────────────────────────────────────────────────────────────────────
const INBOUND_DLQ = "tl:inbound:dlq";
const INBOUND_DLQ_MAX = 2000;

export interface InboundSms {
  phone: string;
  text: string;
  ts: number;
  attempts?: number;
}

/** Encola un SMS entrante que no se pudo registrar (LPUSH, recortado). */
export async function enqueueInboundSms(item: InboundSms): Promise<void> {
  try {
    await redisCmd(["LPUSH", INBOUND_DLQ, JSON.stringify(item)]);
    await redisCmd(["LTRIM", INBOUND_DLQ, 0, INBOUND_DLQ_MAX - 1]);
  } catch (err) {
    console.error("[cache] enqueueInboundSms falló:", err);
  }
}

/** Saca el SMS entrante más antiguo de la cola (RPOP), o null si está vacía. */
export async function dequeueInboundSms(): Promise<InboundSms | null> {
  try {
    const raw = await redisCmd(["RPOP", INBOUND_DLQ]);
    if (typeof raw === "string" && raw.length) return JSON.parse(raw) as InboundSms;
  } catch {
    /* vacío o error → null */
  }
  return null;
}

/** Cuántos SMS entrantes hay en la cola (para /api/health y diagnóstico). */
export async function inboundQueueLen(): Promise<number> {
  try {
    return Number(await redisCmd(["LLEN", INBOUND_DLQ])) || 0;
  } catch {
    return 0;
  }
}

/** Indica si el KV está configurado (para logging/diagnóstico). */
export function cacheEnabled(): boolean {
  return !!(REST_URL && REST_TOKEN);
}
