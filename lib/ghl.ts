import { redisCmd } from "@/lib/cache";
import { getGhlLocationToken } from "@/lib/ghl-oauth";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? "FmXJ8J0Ccird2AKk8pzQ";

/**
 * Token para los llamados que TOCAN el Conversation Provider custom (registrar
 * inbound con `conversationProviderId`, actualizar estado saliente). Con el canal
 * custom activo (GHL_USE_CONVERSATION_PROVIDER=on) usa el token OAuth de la app
 * dueña del provider — el único con acceso (si no, GHL da 401
 * CONVERSATIONS_MSG_PROVIDER_NO_ACCESS). Si el canal custom está off, usa el
 * token estático GHL_TOKEN (canal SMS default).
 */
async function providerAuthToken(): Promise<string> {
  if (process.env.GHL_USE_CONVERSATION_PROVIDER === "on") {
    return getGhlLocationToken();
  }
  const token = process.env.GHL_TOKEN;
  if (!token) throw new Error("GHL_TOKEN no configurado");
  return token;
}

/**
 * fetch a la API de GHL con reintento en 429 (rate-limit) y backoff.
 * Respeta `Retry-After` si viene; si no, backoff exponencial acotado.
 * Corre en el background del webhook (waitUntil), así que un pequeño delay no
 * afecta la respuesta 200 a TaxiCaller. `no-store` evita el Data Cache de Next.
 */
async function ghlFetch(
  input: string,
  init: RequestInit,
  retries = Number(process.env.GHL_MAX_RETRIES ?? 1)
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, { ...init, cache: "no-store" });
    if (res.status !== 429 || attempt >= retries) return res;
    // Si el 429 es por la CUOTA DIARIA agotada (no por ráfaga), reintentar es
    // inútil (no se restaura hasta el reset del día) y solo quema tiempo/función.
    if (res.headers.get("x-ratelimit-daily-remaining") === "0") return res;
    const retryAfter = Number(res.headers.get("Retry-After"));
    const delay =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 4000)
        : Math.min(300 * 2 ** attempt, 4000); // 300ms, 600ms, 1200ms...
    await new Promise((r) => setTimeout(r, delay));
  }
}

export interface GhlContact {
  id: string;
  phone: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * Busca un contacto en GoHighLevel por teléfono.
 * GET /contacts/?locationId={loc}&query={phone}
 * Devuelve el primer contacto encontrado, o null.
 */
export async function findGhlContactByPhone(
  phone: string
): Promise<GhlContact | null> {
  const token = process.env.GHL_TOKEN;
  if (!token) throw new Error("GHL_TOKEN no configurado");

  const url = new URL(`${GHL_BASE}/contacts/`);
  url.searchParams.set("locationId", GHL_LOCATION_ID);
  url.searchParams.set("query", phone);

  const res = await ghlFetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL búsqueda de contacto falló (${res.status}): ${body}`);
  }

  const data: any = await res.json();
  const contact = data?.contacts?.[0];
  if (!contact) return null;

  return {
    id: contact.id,
    phone: contact.phone ?? null,
    firstName: contact.firstName ?? null,
    lastName: contact.lastName ?? null,
  };
}

/**
 * Crea o actualiza (upsert) un contacto en GHL por teléfono y devuelve su id.
 * Se usa como respaldo cuando la búsqueda no encuentra al pasajero, para
 * garantizar un contactId con el cual enviar el WhatsApp.
 * POST /contacts/upsert  { locationId, phone }
 */
export async function upsertGhlContact(phoneE164: string): Promise<string | null> {
  const token = process.env.GHL_TOKEN;
  if (!token) throw new Error("GHL_TOKEN no configurado");

  const res = await ghlFetch(`${GHL_BASE}/contacts/upsert`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ locationId: GHL_LOCATION_ID, phone: phoneE164 }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL upsert de contacto falló (${res.status}): ${body}`);
  }

  const data: any = await res.json();
  return data?.contact?.id ?? data?.id ?? null;
}

// IDs de los campos personalizados del vehículo en GHL (location FmXJ8J0...).
// Los llena la app antes de disparar el Workflow para que la plantilla pueda
// mapear {{1}} marca, {{2}} color, {{3}} placa.
const VEHICLE_FIELD_IDS = {
  make: "rIGTbruWuog0AqsEtGPQ", // Vehículo Marca
  color: "OmA594UCeSJC7O0unT3f", // Vehículo Color
  plate: "8WtDFIHv9ABtRz9HYJYK", // Vehículo Placa
} as const;

/**
 * Escribe la marca/color/placa del vehículo en los campos personalizados del
 * contacto. Debe completarse ANTES de inscribir al contacto en el Workflow para
 * que la plantilla de WhatsApp tenga los valores que mapear.
 * PUT /contacts/{contactId}  { customFields: [{ id, value }] }
 */
export async function updateContactVehicleFields(
  contactId: string,
  data: { make?: string | null; color?: string | null; plate?: string | null }
): Promise<boolean> {
  const token = process.env.GHL_TOKEN;
  if (!token) throw new Error("GHL_TOKEN no configurado");

  const customFields = [
    { id: VEHICLE_FIELD_IDS.make, value: (data.make ?? "").toString().trim() },
    { id: VEHICLE_FIELD_IDS.color, value: (data.color ?? "").toString().trim() },
    { id: VEHICLE_FIELD_IDS.plate, value: (data.plate ?? "").toString().trim() },
  ];

  const res = await ghlFetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ customFields }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[ghl] update custom fields vehículo falló (${res.status}): ${body}`);
    return false;
  }
  return true;
}

/**
 * Envía un mensaje de WhatsApp a través de GoHighLevel (Conversations API).
 * Es el canal que ya usaba el scenario TL_04 de Make.
 * POST /conversations/messages  { type: "WhatsApp", contactId, message }
 *
 * ⚠️ Texto libre: solo entrega dentro de la ventana de 24h.
 */
export async function sendGhlWhatsApp(
  contactId: string,
  message: string
): Promise<{ ok: boolean; status: number; response: unknown }> {
  return ghlPostMessage({ type: "WhatsApp", contactId, message });
}

/**
 * Envía una PLANTILLA de WhatsApp aprobada vía GHL (Conversations API).
 * Las plantillas SÍ entregan fuera de la ventana de 24h.
 * El WhatsApp de GHL corre sobre Twilio, así que `templateId` es el Content SID
 * (HX...) de la plantilla aprobada.
 *
 * `templateData` es opcional: pares para las variables {{1}},{{2}}... de la
 * plantilla. Se envía en varias claves conocidas para maximizar compatibilidad;
 * si la plantilla es estática (sin variables), se omite.
 */
export async function sendGhlTemplate(
  contactId: string,
  templateId: string,
  variables?: string[]
): Promise<{ ok: boolean; status: number; response: unknown }> {
  const body: Record<string, unknown> = {
    type: "WhatsApp",
    contactId,
    templateId,
  };

  if (variables && variables.length) {
    // Twilio Content API espera un mapa { "1": val, "2": val, ... }.
    const map: Record<string, string> = {};
    variables.forEach((v, i) => (map[String(i + 1)] = v));
    body.templateData = map;
    body.contentVariables = JSON.stringify(map);
  }

  return ghlPostMessage(body);
}

/**
 * Envía un SMS SALIENTE a través del Conversation Provider custom de RingCentral
 * (canal SMS de la sub-cuenta). En vez de llamar a RingCentral directamente, se
 * publica el mensaje saliente al provider en GHL: GHL lo muestra en el hilo del
 * contacto Y dispara nuestro webhook `ghl-outbound`, que hace el envío real por
 * RingCentral UNA sola vez y confirma el estado. Así el dispatcher ve la
 * notificación automática en la conversación (misma vía que un mensaje manual).
 *
 * Requiere el token OAuth de la app dueña del provider (`providerAuthToken`) y
 * `type: "Custom"` + `conversationProviderId` (igual que el inbound).
 */
export async function sendGhlProviderSms(
  contactId: string,
  message: string
): Promise<{ ok: boolean; status: number; response: unknown }> {
  const providerId =
    process.env.GHL_CONVERSATION_PROVIDER_ID ?? process.env.GHL_SMS_PROVIDER_ID;
  const body: Record<string, unknown> = {
    type: "Custom",
    contactId,
    message,
  };
  if (providerId) body.conversationProviderId = providerId;
  const token = await providerAuthToken();
  return ghlPostMessage(body, token);
}

async function ghlPostMessage(
  body: Record<string, unknown>,
  authToken?: string
): Promise<{ ok: boolean; status: number; response: unknown }> {
  const token = authToken ?? process.env.GHL_TOKEN;
  if (!token) throw new Error("GHL_TOKEN no configurado");

  const res = await ghlFetch(`${GHL_BASE}/conversations/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const response = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, response };
}

/**
 * Registra un mensaje SMS ENTRANTE (cliente → negocio) en la conversación del
 * contacto en GHL. Se usa cuando el SMS llega por RingCentral y solo queremos
 * que quede reflejado en la bandeja de GHL (NO reenviarlo por el proveedor de
 * GHL).
 *
 * Endpoint correcto para inbound: POST /conversations/messages/inbound
 * (el POST /conversations/messages "a secas" es para SALIENTES y dispararía un
 * envío real por el proveedor SMS de GHL).
 *
 * Canal custom (Conversation Provider) DESHABILITADO por defecto: el `GHL_TOKEN`
 * actual no tiene acceso al provider `6a870e6d202787fbd6fb7ccc` (GHL responde
 * 401 `CONVERSATIONS_MSG_PROVIDER_NO_ACCESS`), así que sin `conversationProviderId`
 * el mensaje entrante cae en el canal SMS default de GHL (sí aparece en el inbox).
 *
 * Para RE-ACTIVAR el canal custom (una vez el token tenga acceso al provider):
 * poner `GHL_USE_CONVERSATION_PROVIDER=on`; entonces se adjunta el
 * `conversationProviderId` (de GHL_CONVERSATION_PROVIDER_ID, o el antiguo
 * GHL_SMS_PROVIDER_ID).
 */
export async function addGhlInboundSms(
  contactId: string,
  message: string
): Promise<{ ok: boolean; status: number; response: unknown }> {
  const token = await providerAuthToken();
  const useProvider = process.env.GHL_USE_CONVERSATION_PROVIDER === "on";

  // Con el canal custom, GHL exige type "Custom" (aunque el provider se muestre
  // como "SMS" en el Marketplace) + el conversationProviderId — comprobado
  // empíricamente: "SMS"+id → 400 mismatch, "Custom"+id → 201. Sin canal custom,
  // type "SMS" al canal default.
  const body: Record<string, unknown> = {
    type: useProvider ? "Custom" : "SMS",
    contactId,
    message,
    direction: "inbound",
  };
  if (useProvider) {
    const providerId =
      process.env.GHL_CONVERSATION_PROVIDER_ID ?? process.env.GHL_SMS_PROVIDER_ID;
    if (providerId) body.conversationProviderId = providerId;
  }

  const res = await ghlFetch(`${GHL_BASE}/conversations/messages/inbound`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const response = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, response };
}

/**
 * Actualiza el estado de entrega de un mensaje SALIENTE en GHL. Lo usa el
 * Conversation Provider custom para confirmar a GHL si el SMS real (enviado por
 * RingCentral) se entregó o falló, y así el dispatcher ve el estado correcto en
 * el inbox.
 * PUT /conversations/messages/{messageId}/status  { status }
 *
 * `status`: "delivered" | "failed" | "read" | "pending" (GHL). Nunca lanza:
 * devuelve ok/status como los demás helpers para no tumbar el flujo del webhook.
 */
export async function updateGhlMessageStatus(
  messageId: string,
  status: "delivered" | "failed" | "read" | "pending",
  extra?: Record<string, unknown>
): Promise<{ ok: boolean; status: number; response: unknown }> {
  const token = await providerAuthToken();

  const res = await ghlFetch(
    `${GHL_BASE}/conversations/messages/${messageId}/status`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ status, ...extra }),
    }
  );

  const response = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, response };
}

/**
 * Agrega un contacto a un Workflow de GHL (lo inscribe y ejecuta sus acciones).
 * Se usa para enviar la plantilla de WhatsApp vía la acción nativa "Send WhatsApp"
 * del workflow, evitando necesitar el templateId interno por API.
 * POST /contacts/{contactId}/workflow/{workflowId}
 */
export async function addContactToWorkflow(
  contactId: string,
  workflowId: string
): Promise<{ ok: boolean; status: number; response: unknown }> {
  const token = process.env.GHL_TOKEN;
  if (!token) throw new Error("GHL_TOKEN no configurado");

  const res = await ghlFetch(
    `${GHL_BASE}/contacts/${contactId}/workflow/${workflowId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
    }
  );

  const response = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, response };
}

/** Estado de entrega real de un mensaje en GHL (delivered/read/failed/...). */
export async function getMessageStatus(
  messageId: string
): Promise<{ status: string | null; error: string | null }> {
  const token = process.env.GHL_TOKEN;
  if (!token) return { status: null, error: null };
  try {
    const res = await ghlFetch(`${GHL_BASE}/conversations/messages/${messageId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: "2021-07-28",
        Accept: "application/json",
      },
    });
    if (!res.ok) return { status: null, error: null };
    const data: any = await res.json();
    const m = data?.message ?? {};
    return { status: m.status ?? null, error: m.error ?? null };
  } catch {
    return { status: null, error: null };
  }
}

/**
 * Igual que getMessageStatus pero cacheado en Redis para NO golpear a GHL en
 * cada refresco del dashboard (que era lo que agotaba la cuota diaria de 200k).
 * - Estado FINAL (delivered/read/failed): se cachea 30 días (nunca cambia).
 * - Estado transitorio o nulo: se cachea 5 min (puede evolucionar).
 */
export async function getMessageStatusCached(
  messageId: string
): Promise<{ status: string | null; error: string | null }> {
  const key = `msgstatus:${messageId}`;
  try {
    const hit = await redisCmd(["GET", key]);
    if (typeof hit === "string" && hit.length) return JSON.parse(hit);
  } catch {
    /* si el caché falla, se consulta GHL igual */
  }

  const fresh = await getMessageStatus(messageId);
  const terminal =
    fresh.status === "delivered" ||
    fresh.status === "read" ||
    fresh.status === "failed";
  const ttl = terminal ? 60 * 60 * 24 * 30 : 300;
  // No cachear si GHL no devolvió nada útil (evita fijar "null" por 30 días).
  if (fresh.status || fresh.error) {
    try {
      await redisCmd(["SET", key, JSON.stringify(fresh), "EX", ttl]);
    } catch {
      /* no-op */
    }
  }
  return fresh;
}

/** Canal por el que un contacto se comunicó (para enrutar la respuesta). */
export type InboundChannel = "sms" | "whatsapp" | "other";

export interface LastInbound {
  /** epoch ms del mensaje entrante más reciente. */
  ts: number;
  /** canal por el que llegó ese entrante. */
  channel: InboundChannel;
}

// Provider custom de RingCentral: los inbound que entran por él quedan atados a
// este id (por si el messageType no trae "SMS" explícito).
const RC_PROVIDER_ID =
  process.env.GHL_CONVERSATION_PROVIDER_ID ?? process.env.GHL_SMS_PROVIDER_ID;

/**
 * Clasifica un mensaje de GHL por su canal. GHL usa `messageType` tipo
 * `TYPE_WHATSAPP`, `TYPE_SMS`, `TYPE_CUSTOM_PROVIDER_SMS`, etc. El SMS de
 * RingCentral entra por nuestro Conversation Provider custom (aparece como una
 * variante de SMS o atado a `RC_PROVIDER_ID`).
 */
function classifyInboundChannel(m: any): InboundChannel {
  const t = String(m?.messageType ?? m?.type ?? "").toUpperCase();
  if (t.includes("WHATSAPP")) return "whatsapp";
  if (t.includes("SMS")) return "sms";
  if (RC_PROVIDER_ID && m?.conversationProviderId === RC_PROVIDER_ID) return "sms";
  return "other";
}

/**
 * Trae los mensajes recientes de la conversación del contacto (del más reciente
 * al más antiguo). Base compartida para detectar último entrante y su canal.
 */
async function fetchRecentMessages(contactId: string): Promise<any[]> {
  const token = process.env.GHL_TOKEN;
  if (!token) throw new Error("GHL_TOKEN no configurado");
  const headers = {
    Authorization: `Bearer ${token}`,
    Version: "2021-07-28",
    Accept: "application/json",
  };

  // 1. Conversación del contacto.
  const searchUrl = new URL(`${GHL_BASE}/conversations/search`);
  searchUrl.searchParams.set("locationId", GHL_LOCATION_ID);
  searchUrl.searchParams.set("contactId", contactId);
  const convRes = await ghlFetch(searchUrl.toString(), { headers });
  if (!convRes.ok) return [];
  const convData: any = await convRes.json();
  const conversationId = convData?.conversations?.[0]?.id;
  if (!conversationId) return [];

  // 2. Mensajes (del más reciente al más antiguo).
  const msgRes = await ghlFetch(
    `${GHL_BASE}/conversations/${conversationId}/messages?limit=20`,
    { headers }
  );
  if (!msgRes.ok) return [];
  const msgData: any = await msgRes.json();
  return msgData?.messages?.messages ?? [];
}

/**
 * Devuelve el último mensaje ENTRANTE del contacto (cliente → negocio) con su
 * timestamp y canal, o null si no hay. Sirve para (a) la ventana de 24h de
 * WhatsApp y (b) enrutar la notificación por el mismo canal que usó el cliente.
 */
export async function getLastInbound(
  contactId: string
): Promise<LastInbound | null> {
  const messages = await fetchRecentMessages(contactId);
  for (const m of messages) {
    if (m?.direction === "inbound" && m?.dateAdded) {
      const t = Date.parse(m.dateAdded);
      if (!Number.isNaN(t)) return { ts: t, channel: classifyInboundChannel(m) };
    }
  }
  return null;
}

/**
 * Timestamp (epoch ms) del último entrante del contacto, o null. Wrapper sobre
 * getLastInbound para el chequeo de ventana de 24h.
 */
export async function getLastInboundTime(
  contactId: string
): Promise<number | null> {
  const last = await getLastInbound(contactId);
  return last ? last.ts : null;
}

/**
 * ¿El contacto está dentro de la ventana de servicio de 24h de WhatsApp?
 * (true si respondió en las últimas 24h). Ante cualquier error/incertidumbre
 * devuelve false → se usará plantilla (entrega garantizada).
 */
export async function isWithin24hWindow(contactId: string): Promise<boolean> {
  try {
    const last = await getLastInboundTime(contactId);
    if (!last) return false;
    return Date.now() - last < 24 * 60 * 60 * 1000;
  } catch (err) {
    console.error(`[ghl] No se pudo determinar ventana 24h (${contactId}):`, err);
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Lecturas para KPIs de dispatchers (agregador). Todo READ-ONLY sobre GHL.
// ───────────────────────────────────────────────────────────────────────────

/** Plataforma de un mensaje de GHL (para KPIs por canal). */
export type Platform = "sms" | "whatsapp" | "call" | "email" | "other";

/** Clasifica cualquier mensaje (in/out) de GHL por plataforma. */
export function classifyPlatform(m: any): Platform {
  const t = String(m?.messageType ?? m?.type ?? "").toUpperCase();
  if (t.includes("WHATSAPP")) return "whatsapp";
  if (t.includes("SMS")) return "sms";
  if (t.includes("CALL")) return "call";
  if (t.includes("EMAIL")) return "email";
  if (RC_PROVIDER_ID && m?.conversationProviderId === RC_PROVIDER_ID) return "sms";
  return "other";
}

function ghlHeaders(): Record<string, string> {
  const token = process.env.GHL_TOKEN;
  if (!token) throw new Error("GHL_TOKEN no configurado");
  return {
    Authorization: `Bearer ${token}`,
    Version: "2021-07-28",
    Accept: "application/json",
  };
}

export interface ConversationRef {
  id: string;
  contactId: string | null;
  lastMessageMs: number | null;
}

/** epoch ms desde un valor que GHL entrega como número (ms) o ISO string. */
function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/**
 * Enumera conversaciones de la location ordenadas por último mensaje (desc),
 * paginando hasta cubrir `sinceMs` o alcanzar `max`. Para el agregador de KPIs.
 * GET /conversations/search?locationId=&sortBy=last_message_date&sort=desc
 */
export async function listConversations(
  opts: { sinceMs?: number; max?: number } = {}
): Promise<ConversationRef[]> {
  const headers = ghlHeaders();
  const max = opts.max ?? 800;
  const sinceMs = opts.sinceMs ?? 0;
  const out: ConversationRef[] = [];
  let startAfterDate: number | undefined;

  for (let page = 0; page < 30 && out.length < max; page++) {
    const url = new URL(`${GHL_BASE}/conversations/search`);
    url.searchParams.set("locationId", GHL_LOCATION_ID);
    url.searchParams.set("sortBy", "last_message_date");
    url.searchParams.set("sort", "desc");
    url.searchParams.set("limit", "100");
    if (startAfterDate) url.searchParams.set("startAfterDate", String(startAfterDate));

    const res = await ghlFetch(url.toString(), { headers });
    if (!res.ok) {
      console.error(`[ghl] listConversations falló (${res.status})`);
      break;
    }
    const data: any = await res.json();
    const convs: any[] = data?.conversations ?? [];
    if (!convs.length) break;

    let oldestMs: number | null = null;
    for (const c of convs) {
      const lm = toMs(c?.lastMessageDate ?? c?.dateUpdated);
      oldestMs = lm;
      out.push({ id: c.id, contactId: c?.contactId ?? null, lastMessageMs: lm });
    }
    // Si la conversación más vieja de la página ya cae antes de la ventana, parar.
    if (oldestMs !== null && oldestMs < sinceMs) break;
    if (oldestMs === null) break;
    startAfterDate = oldestMs;
  }
  return out.slice(0, max);
}

export interface NormMessage {
  id: string;
  direction: "inbound" | "outbound";
  ms: number;
  platform: Platform;
  userId: string | null;
}

/**
 * Mensajes de una conversación dentro de [sinceMs, now], normalizados y
 * ordenados ASC por tiempo. Pagina hacia atrás hasta cubrir la ventana.
 * GET /conversations/{id}/messages?limit=100[&lastMessageId=]
 */
export async function getConversationMessages(
  conversationId: string,
  opts: { sinceMs?: number; maxPages?: number } = {}
): Promise<NormMessage[]> {
  const headers = ghlHeaders();
  const sinceMs = opts.sinceMs ?? 0;
  const maxPages = opts.maxPages ?? 5;
  const acc: NormMessage[] = [];
  let lastMessageId: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${GHL_BASE}/conversations/${conversationId}/messages`);
    url.searchParams.set("limit", "100");
    if (lastMessageId) url.searchParams.set("lastMessageId", lastMessageId);

    const res = await ghlFetch(url.toString(), { headers });
    if (!res.ok) break;
    const data: any = await res.json();
    const box = data?.messages ?? {};
    const arr: any[] = box?.messages ?? [];
    if (!arr.length) break;

    let reachedOld = false;
    for (const m of arr) {
      const ms = toMs(m?.dateAdded);
      if (ms === null) continue;
      if (ms < sinceMs) {
        reachedOld = true;
        continue;
      }
      const dir = String(m?.direction ?? "").toLowerCase();
      acc.push({
        id: String(m?.id ?? ""),
        direction: dir === "outbound" ? "outbound" : "inbound",
        ms,
        platform: classifyPlatform(m),
        userId: m?.userId ? String(m.userId) : null,
      });
    }
    lastMessageId = box?.lastMessageId;
    if (reachedOld || !box?.nextPage || !lastMessageId) break;
  }

  return acc.sort((a, b) => a.ms - b.ms);
}

/**
 * Mapa userId → nombre de los usuarios de la location (para atribuir KPIs a
 * personas). Requiere scope users.readonly; si falla, devuelve {} y el
 * dashboard muestra el userId crudo.
 * GET /users/?locationId=
 */
export async function listLocationUsers(): Promise<Record<string, string>> {
  try {
    const url = new URL(`${GHL_BASE}/users/`);
    url.searchParams.set("locationId", GHL_LOCATION_ID);
    const res = await ghlFetch(url.toString(), { headers: ghlHeaders() });
    if (!res.ok) return {};
    const data: any = await res.json();
    const users: any[] = data?.users ?? [];
    const map: Record<string, string> = {};
    for (const u of users) {
      const name =
        u?.name ||
        [u?.firstName, u?.lastName].filter(Boolean).join(" ") ||
        u?.email ||
        u?.id;
      if (u?.id) map[String(u.id)] = String(name);
    }
    return map;
  } catch {
    return {};
  }
}
