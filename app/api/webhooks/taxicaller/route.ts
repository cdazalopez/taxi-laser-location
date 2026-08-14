import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { buildMessage, buildTemplate } from "@/lib/messages";
import { normalizePhone, toE164 } from "@/lib/phone";
import {
  findGhlContactByPhone,
  upsertGhlContact,
  sendGhlWhatsApp,
} from "@/lib/ghl";
import { sendWhatsAppText, sendWhatsAppTemplate } from "@/lib/whatsapp";

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
  const rawPhone = extractPassengerPhone(payload);
  const passengerPhone = normalizePhone(rawPhone);

  if (!passengerPhone) {
    console.error(`[taxicaller] Sin teléfono de pasajero para job ${jobId}. Payload:`, payload);
    return;
  }

  const message = buildMessage(event, vehicleData);
  if (!message) {
    console.error(`[taxicaller] No se generó mensaje para evento "${event}"`);
    return;
  }

  const channel = process.env.SEND_CHANNEL ?? "ghl";
  const result =
    channel === "meta"
      ? await sendViaMeta(event, vehicleData, passengerPhone, message)
      : await sendViaGhl(rawPhone ?? passengerPhone, passengerPhone, message, jobId);

  if (!result) return;

  if (result.ok) {
    console.log(`[taxicaller] WhatsApp (${channel}) enviado (job ${jobId}, ${event})`);
  } else {
    console.error(
      `[taxicaller] Envío WhatsApp (${channel}) falló (${result.status}) job ${jobId}:`,
      JSON.stringify(result.response)
    );
  }
}

/** Canal GHL: busca/crea el contacto y envía por Conversations (type WhatsApp). */
async function sendViaGhl(
  rawPhone: string,
  normalizedPhone: string,
  message: string,
  jobId: string
) {
  // 1. Contacto por teléfono (igual que el TL_04). Se prueba con el valor crudo
  //    y con el normalizado para maximizar coincidencias.
  let contactId: string | null = null;
  try {
    const contact =
      (await findGhlContactByPhone(rawPhone)) ??
      (await findGhlContactByPhone(normalizedPhone));
    if (contact?.id) {
      contactId = contact.id;
      console.log(`[taxicaller] Contacto GHL ${contactId} (job ${jobId})`);
    }
  } catch (err) {
    console.error(`[taxicaller] Búsqueda GHL falló (job ${jobId}):`, err);
  }

  // 2. Si no existe, lo creamos (upsert) para tener un contactId con que enviar.
  if (!contactId) {
    try {
      contactId = await upsertGhlContact(toE164(normalizedPhone)!);
      console.log(`[taxicaller] Contacto GHL creado ${contactId} (job ${jobId})`);
    } catch (err) {
      console.error(`[taxicaller] Upsert GHL falló (job ${jobId}):`, err);
    }
  }

  if (!contactId) {
    console.error(`[taxicaller] Sin contactId GHL; no se puede enviar (job ${jobId})`);
    return null;
  }

  return sendGhlWhatsApp(contactId, message);
}

/** Canal Meta directo: plantilla (default) o texto libre según WHATSAPP_MODE. */
async function sendViaMeta(
  event: string,
  data: any,
  normalizedPhone: string,
  message: string
) {
  const mode = process.env.WHATSAPP_MODE ?? "template";
  if (mode === "text") {
    return sendWhatsAppText(normalizedPhone, message);
  }
  const tpl = buildTemplate(event, data);
  if (!tpl) return null;
  return sendWhatsAppTemplate(normalizedPhone, tpl.name, tpl.language, tpl.params);
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
