import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { buildMessage, buildTemplate } from "@/lib/messages";
import { normalizePhone, toE164 } from "@/lib/phone";
import {
  findGhlContactByPhone,
  upsertGhlContact,
  sendGhlWhatsApp,
  sendGhlTemplate,
  addContactToWorkflow,
  updateContactVehicleFields,
  isWithin24hWindow,
  getLastInbound,
  sendGhlProviderSms,
} from "@/lib/ghl";
import { sendWhatsAppText, sendWhatsAppTemplate } from "@/lib/whatsapp";
import { sendRingCentralSms } from "@/lib/ringcentral";
import {
  cachePhoneForJob,
  getCachedPhoneForJob,
  cacheContactIdForPhone,
  getCachedContactIdForPhone,
  getInboundChannel,
} from "@/lib/cache";
import { recordEvent, bumpCounters, bumpTripDay, type EventRecord } from "@/lib/events";
import { reportDeliveryOutcome, isGhlCircuitOpen } from "@/lib/health";

// Runtime Node.js (no edge) para fetch completo.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_EVENTS = new Set([
  "waiting_for_passenger",
  "job_marked_as_delivered",
  "cancelled_by_company",
]);

/**
 * Webhook de TaxiCaller — reemplazo del scenario TL_04 de Make.com.
 *
 * Toda la data (evento, teléfono del pasajero, datos del vehículo, tarifa) viene
 * en el propio webhook — NO se consulta la API de TaxiCaller (el TL_04 original
 * tampoco la usaba para el teléfono).
 *
 * Canal de envío (SEND_CHANNEL):
 *   - "ghl" (default): WhatsApp vía GoHighLevel Conversations (como el TL_04).
 *   - "meta": WhatsApp vía Meta Graph API directo (plantilla o texto).
 */
export async function POST(req: Request) {
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    try {
      const form = await req.formData();
      payload = Object.fromEntries(form.entries());
    } catch {
      payload = {};
    }
  }

  const event: string = payload.event ?? payload.type ?? "";
  const jobId: string = String(
    payload.job_id ?? payload.jobId ?? payload.order_id ?? payload.id ?? ""
  );

  if (!SUPPORTED_EVENTS.has(event)) {
    console.log(`[taxicaller] Evento ignorado: "${event}" (job ${jobId || "?"})`);
    return NextResponse.json({ ok: true, ignored: true, event });
  }

  waitUntil(
    processEvent(event, jobId, payload).catch((err) => {
      console.error(`[taxicaller] Error procesando job ${jobId} (${event}):`, err);
    })
  );

  return NextResponse.json({ ok: true, accepted: true, event, job_id: jobId });
}

async function processEvent(event: string, jobId: string, payload: any) {
  const vehicleData = {
    vehicle_make: payload.vehicle_make ?? null,
    vehicle_color: payload.vehicle_color ?? null,
    vehicle_plate: payload.vehicle_plate ?? null,
    fare: payload.fare ?? null,
  };

  // Teléfono del pasajero desde el webhook. Se aceptan varias claves porque el
  // emisor del webhook ha variado (passenger_phone, phone, phone1..phone6).
  // `waiting_for_passenger` lo trae; `delivered`/`cancelled` NO → se recupera
  // del caché por job_id (lo guardó el waiting_for_passenger del mismo viaje).
  let rawPhone = extractPassengerPhone(payload);
  const phoneFromWebhook = !!rawPhone;

  if (!rawPhone && jobId) {
    const cached = await getCachedPhoneForJob(jobId);
    if (cached) {
      rawPhone = cached;
      console.log(`[taxicaller] Teléfono recuperado de caché (job ${jobId}, ${event})`);
    }
  }

  const passengerPhone = normalizePhone(rawPhone);
  const phoneSource: EventRecord["phoneSource"] = phoneFromWebhook
    ? "webhook"
    : passengerPhone
      ? "cache"
      : "none";

  if (!passengerPhone) {
    console.error(`[taxicaller] Sin teléfono de pasajero para job ${jobId} (${event}). Payload:`, payload);
    void recordEvent(baseRecord(event, jobId, null, "none", "no_phone"));
    return;
  }

  // Si el teléfono vino en el webhook, guárdalo para eventos posteriores del
  // mismo job (no bloquea el envío).
  if (phoneFromWebhook && jobId) {
    void cachePhoneForJob(jobId, passengerPhone).catch((err) =>
      console.error(`[taxicaller] cache SET falló (job ${jobId}):`, err)
    );
  }

  const message = buildMessage(event, vehicleData);
  if (!message) {
    console.error(`[taxicaller] No se generó mensaje para evento "${event}"`);
    void recordEvent(baseRecord(event, jobId, passengerPhone, phoneSource, "error"));
    return;
  }

  const channel = process.env.SEND_CHANNEL ?? "ghl";
  const sent =
    channel === "meta"
      ? await sendViaMeta(event, vehicleData, passengerPhone, message)
      : await sendViaGhl(event, vehicleData, rawPhone ?? passengerPhone, passengerPhone, message, jobId);

  const res = sent.result;
  if (!res) {
    void reportDeliveryOutcome(false); // detección: fallo de entrega
    void recordEvent({
      ...baseRecord(event, jobId, passengerPhone, phoneSource, "error"),
      channel: sent.channel,
      note: sent.note ?? "sin resultado de envío",
    });
    return;
  }
  void reportDeliveryOutcome(res.ok); // detección: éxito/fallo de entrega (incluye fallback)

  if (res.ok) {
    console.log(`[taxicaller] Notificación (${sent.channel}) enviada (job ${jobId}, ${event})`);
    // Contadores acumulados históricos (para total enviados + estimación de costo).
    void bumpCounters(["total", `ch:${sent.channel}`, `ev:${event}`]);
    // Viaje completado → suma al contador diario de viajes.
    if (event === "job_marked_as_delivered") void bumpTripDay();
  } else {
    console.error(
      `[taxicaller] Envío WhatsApp (${sent.channel}) falló (${res.status}) job ${jobId}:`,
      JSON.stringify(res.response)
    );
  }

  void recordEvent({
    ...baseRecord(event, jobId, passengerPhone, phoneSource, res.ok ? "sent" : "error"),
    contactId: sent.contactId,
    channel: sent.channel,
    inWindow: sent.inWindow,
    ghlOk: !!res.ok,
    ghlStatus: res.status ?? null,
    messageId: (res.response as any)?.messageId ?? null,
  });
}

/** Crea un registro base con los campos comunes. */
function baseRecord(
  event: string,
  jobId: string,
  phone: string | null,
  phoneSource: EventRecord["phoneSource"],
  outcome: EventRecord["outcome"]
): EventRecord {
  return {
    ts: new Date().toISOString(),
    event,
    job_id: jobId,
    phone,
    phoneSource,
    contactId: null,
    channel: null,
    inWindow: null,
    outcome,
    ghlOk: null,
    ghlStatus: null,
    messageId: null,
  };
}

/** Mapea cada evento a su templateId interno de GHL por env. */
function templateIdForEvent(event: string): string | undefined {
  const map: Record<string, string | undefined> = {
    waiting_for_passenger: process.env.GHL_TEMPLATE_ARRIVAL_ID,
    job_marked_as_delivered: process.env.GHL_TEMPLATE_DELIVERED_ID,
    cancelled_by_company: process.env.GHL_TEMPLATE_CANCELLED_ID,
  };
  return map[event];
}

/** Mapea cada evento a un Workflow de GHL (que envía la plantilla) por env. */
function workflowIdForEvent(event: string): string | undefined {
  const map: Record<string, string | undefined> = {
    waiting_for_passenger: process.env.GHL_WORKFLOW_ARRIVAL_ID,
    job_marked_as_delivered: process.env.GHL_WORKFLOW_DELIVERED_ID,
    cancelled_by_company: process.env.GHL_WORKFLOW_CANCELLED_ID,
  };
  return map[event];
}

/** Canal GHL: busca/crea el contacto y envía por Conversations (type WhatsApp). */
async function sendViaGhl(
  event: string,
  data: any,
  rawPhone: string,
  normalizedPhone: string,
  message: string,
  jobId: string
) {
  // 0.a Camino rápido por circuito: si GHL está saturado (circuito abierto), NO
  //     tocar GHL (evita 429 + reintentos + delay) y enviar la notificación
  //     directo por SMS de RingCentral. Kill switch: RC_FALLBACK=off.
  if ((process.env.RC_FALLBACK ?? "on") !== "off" && (await isGhlCircuitOpen())) {
    const to = toE164(normalizedPhone) ?? normalizedPhone;
    try {
      console.log(`[taxicaller] circuito GHL abierto → SMS directo por RingCentral (job ${jobId}, ${event})`);
      const rc = await sendRingCentralSms(to, message);
      return { result: rc, channel: "rc-sms" as const, contactId: null, inWindow: null, note: "circuit-open→rc" };
    } catch (err) {
      console.error(`[taxicaller] RC directo (circuito) falló (job ${jobId}):`, err);
      // si RC falla, sigue el camino normal por si GHL responde
    }
  }

  // 0.b Caché teléfono → contactId. Un mismo pasajero/viaje resuelve siempre el
  //    mismo contacto; evitar la búsqueda+upsert por evento reduce el volumen de
  //    llamadas a GHL (lo que agotaba la cuota diaria → 429 → envíos perdidos).
  let contactId: string | null = null;
  let failReason: string | null = null;
  const contactFromCache = await getCachedContactIdForPhone(normalizedPhone);
  if (contactFromCache) {
    contactId = contactFromCache;
    console.log(`[taxicaller] contactId GHL desde caché ${contactId} (job ${jobId})`);
  }

  // 1. Contacto por teléfono (igual que el TL_04). Se prueba con el valor crudo
  //    y con el normalizado para maximizar coincidencias.
  if (!contactId) {
    try {
      const contact =
        (await findGhlContactByPhone(rawPhone)) ??
        (await findGhlContactByPhone(normalizedPhone));
      if (contact?.id) {
        contactId = contact.id;
        console.log(`[taxicaller] Contacto GHL ${contactId} (job ${jobId})`);
      }
    } catch (err) {
      failReason = `lookup: ${String((err as Error)?.message ?? err).slice(0, 120)}`;
      console.error(`[taxicaller] Búsqueda GHL falló (job ${jobId}):`, err);
    }
  }

  // 2. Si no existe, lo creamos (upsert) para tener un contactId con que enviar.
  if (!contactId) {
    try {
      contactId = await upsertGhlContact(toE164(normalizedPhone)!);
      console.log(`[taxicaller] Contacto GHL creado ${contactId} (job ${jobId})`);
    } catch (err) {
      failReason = `upsert: ${String((err as Error)?.message ?? err).slice(0, 120)}`;
      console.error(`[taxicaller] Upsert GHL falló (job ${jobId}):`, err);
    }
  }

  if (!contactId) {
    console.error(`[taxicaller] Sin contactId GHL; no se puede enviar (job ${jobId})`);
    // FALLBACK cuando GHL rechaza la resolución del contacto (típicamente 429 por
    // cuota). Se envía la notificación por SMS de RingCentral — bypass TOTAL de
    // GHL y Meta, para no perder el aviso al pasajero. Kill switch: RC_FALLBACK=off.
    // (El fallback a Meta quedó deshabilitado: su token da 403 sin permisos.)
    if ((process.env.RC_FALLBACK ?? "on") !== "off") {
      const to = toE164(normalizedPhone) ?? normalizedPhone;
      try {
        console.log(`[taxicaller] Fallback a RingCentral SMS (job ${jobId}, ${event})`);
        const rc = await sendRingCentralSms(to, message);
        return { result: rc, channel: "rc-sms" as const, contactId: null, inWindow: null, note: `ghl-fail→rc: ${failReason ?? "sin contactId"}` };
      } catch (err) {
        console.error(`[taxicaller] Fallback RC SMS falló (job ${jobId}):`, err);
      }
    }
    if ((process.env.META_FALLBACK ?? "off") === "on" && process.env.WHATSAPP_TOKEN) {
      console.log(`[taxicaller] Fallback a Meta directo (job ${jobId}, ${event})`);
      const meta = await sendViaMeta(event, data, normalizedPhone, message);
      return { ...meta, note: `ghl-fail→meta: ${failReason ?? "sin contactId"}` };
    }
    return { result: null, channel: null, contactId: null, inWindow: null, note: failReason };
  }

  // Persistir el mapeo teléfono → contactId para los próximos eventos/viajes
  // (fire-and-forget; no bloquea el envío). Si venía del caché, no re-escribe.
  if (!contactFromCache) {
    void cacheContactIdForPhone(normalizedPhone, contactId).catch((err) =>
      console.error(`[taxicaller] cache SET contactId falló (job ${jobId}):`, err)
    );
  }

  // Guardar marca/color/placa en el contacto (SIEMPRE en el arrival, antes de
  // decidir el canal) para que la plantilla del Workflow tenga los valores que
  // mapear. Se espera (await) a que persistan antes de enviar/inscribir.
  if (event === "waiting_for_passenger") {
    try {
      await updateContactVehicleFields(contactId, {
        make: data.vehicle_make,
        color: data.vehicle_color,
        plate: data.vehicle_plate,
      });
    } catch (err) {
      console.error(`[taxicaller] update campos vehículo falló (job ${jobId}):`, err);
    }
  }

  // 2.5 ENRUTADO POR CANAL DEL CLIENTE (flag ROUTE_BY_INBOUND_CHANNEL=on):
  //     si el último mensaje que ESCRIBIÓ el cliente fue SMS/RingCentral, la
  //     notificación sale por SMS (mismo canal + sin ventana de 24h → entrega
  //     siempre). Se publica al provider custom de GHL, que la muestra en el
  //     hilo Y dispara ghl-outbound → envío real por RingCentral una sola vez.
  //     Si fue WhatsApp o no hay entrante, sigue el flujo de WhatsApp de abajo.
  if (process.env.ROUTE_BY_INBOUND_CHANNEL === "on") {
    let inboundChannel: string | null = null;
    // 1) Fuente CONFIABLE: nuestro registro en Redis (lo grabamos cuando el
    //    cliente escribió por SMS). Sin llamadas a GHL, no se rompe en tormentas.
    try {
      inboundChannel = await getInboundChannel(normalizedPhone);
    } catch { /* seguimos al fallback */ }
    // 2) Fallback: leer GHL SOLO si no tenemos registro propio (clientes cuyo
    //    SMS es anterior a esta feature). Se clasifica por messageType/provider.
    if (!inboundChannel) {
      try {
        const last = await getLastInbound(contactId);
        inboundChannel = last?.channel ?? null;
      } catch (err) {
        console.error(`[taxicaller] No se pudo determinar canal entrante (job ${jobId}):`, err);
      }
    }
    if (inboundChannel === "sms") {
      console.log(`[taxicaller] Último canal del cliente = SMS → provider GHL/RingCentral (job ${jobId}, ${event})`);
      try {
        const result = await sendGhlProviderSms(contactId, message);
        return { result, channel: "ghl-sms" as const, contactId, inWindow: null, note: null };
      } catch (err) {
        const note = `ghl-sms: ${String((err as Error)?.message ?? err).slice(0, 120)}`;
        console.error(`[taxicaller] Envío SMS por provider GHL falló (job ${jobId}):`, err);
        return { result: null, channel: "ghl-sms" as const, contactId, inWindow: null, note };
      }
    }
  }

  // 3. HÍBRIDO: si hay un fallback configurado (workflow o plantilla) para este
  //    evento, decidir por la ventana de 24h:
  //      - DENTRO de 24h  → texto libre RICO (marca/color/placa/tarifa).
  //      - FUERA de 24h   → fallback que SÍ entrega:
  //           · Workflow de GHL (preferido; envía la plantilla nativamente), o
  //           · plantilla vía templateId directo.
  //    Si no hay fallback configurado, siempre texto libre (solo entrega <24h).
  const workflowId = workflowIdForEvent(event);
  const templateId = templateIdForEvent(event);
  if (workflowId || templateId) {
    // El finalizado SIEMPRE va por plantilla UTILITY (workflow), sin importar la
    // ventana: la detección de 24h contaba cualquier entrante (incl. SMS) y
    // producía falsos "dentro de ventana" → el texto libre se caía por >24h.
    const forceTemplate = event === "job_marked_as_delivered";
    const inWindow = !forceTemplate && (await isWithin24hWindow(contactId));
    if (inWindow) {
      console.log(`[taxicaller] En ventana 24h → texto libre rico (job ${jobId}, ${event})`);
      const result = await sendGhlWhatsApp(contactId, message);
      return { result, channel: "ghl-text" as const, contactId, inWindow: true, note: null };
    }
    if (workflowId) {
      console.log(`[taxicaller] Fuera de ventana 24h → workflow ${workflowId} (job ${jobId}, ${event})`);
      const result = await addContactToWorkflow(contactId, workflowId);
      return { result, channel: "ghl-workflow" as const, contactId, inWindow: false, note: null };
    }
    const useVars = process.env.GHL_TEMPLATE_VARS === "on";
    const tpl = useVars ? buildTemplate(event, data) : null;
    console.log(`[taxicaller] Fuera de ventana 24h → plantilla ${templateId} (job ${jobId}, ${event}, vars=${useVars})`);
    const result = await sendGhlTemplate(contactId, templateId!, tpl?.params);
    return { result, channel: "ghl-template" as const, contactId, inWindow: false, note: null };
  }

  const result = await sendGhlWhatsApp(contactId, message);
  return { result, channel: "ghl-text" as const, contactId, inWindow: null, note: null };
}

/** Canal Meta directo: plantilla (default) o texto libre según WHATSAPP_MODE. */
async function sendViaMeta(
  event: string,
  data: any,
  normalizedPhone: string,
  message: string
) {
  const mode = process.env.WHATSAPP_MODE ?? "template";
  let result: { ok: boolean; status: number; response: unknown } | null;
  if (mode === "text") {
    result = await sendWhatsAppText(normalizedPhone, message);
  } else {
    const tpl = buildTemplate(event, data);
    result = tpl
      ? await sendWhatsAppTemplate(normalizedPhone, tpl.name, tpl.language, tpl.params)
      : null;
  }
  return { result, channel: "meta" as const, contactId: null, inWindow: null, note: null };
}

/** Extrae el teléfono del pasajero de las posibles claves del webhook. */
function extractPassengerPhone(payload: any): string | null {
  const candidates = [
    payload.passenger_phone,
    payload.phone,
    payload.phone1,
    payload.phone2,
    payload.phone3,
    payload.phone4,
    payload.phone5,
    payload.phone6,
  ];
  for (const c of candidates) {
    if (c && String(c).replace(/\D/g, "").length >= 7) return String(c);
  }
  return null;
}

// Healthcheck simple.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "taxicaller-webhook" });
}
