import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { normalizePhone, toE164 } from "@/lib/phone";
import {
  findGhlContactByPhone,
  upsertGhlContact,
  addGhlInboundSms,
} from "@/lib/ghl";

// Runtime Node.js (no edge) para fetch completo.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook de RingCentral — SMS ENTRANTE del cliente.
 *
 * Flujo:
 *   1. Handshake de validación de RingCentral (header `Validation-Token`): al
 *      crear/renovar la subscripción, RC hace un POST con ese header y espera
 *      un 200 que lo devuelva en el mismo header.
 *   2. En cada SMS entrante: extrae número del remitente y cuerpo del mensaje,
 *      busca (o crea) el contacto en GHL por teléfono y registra el mensaje
 *      entrante en la conversación de GHL.
 *   3. Responde 200 al instante; el trabajo con GHL corre en background.
 */
export async function POST(req: Request) {
  // 1. Handshake de validación de RingCentral.
  const validationToken = req.headers.get("Validation-Token");
  if (validationToken) {
    console.log("[rc-sms] Handshake de validación recibido");
    return new NextResponse(null, {
      status: 200,
      headers: { "Validation-Token": validationToken },
    });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  // La notificación de RingCentral trae el mensaje en `body` (message-store).
  const msg = payload?.body ?? payload;

  // Solo nos interesan SMS entrantes; ignoramos salientes/otros tipos.
  const direction: string = String(msg?.direction ?? "").toLowerCase();
  const type: string = String(msg?.type ?? "SMS");
  if (direction && direction !== "inbound") {
    return NextResponse.json({ ok: true, ignored: true, direction });
  }

  const fromPhone = extractFromPhone(msg);
  const text = extractText(msg);

  if (!fromPhone || !text) {
    console.warn("[rc-sms] SMS sin remitente o sin texto. Payload:", JSON.stringify(payload).slice(0, 500));
    return NextResponse.json({ ok: true, ignored: true, reason: "no_from_or_text" });
  }

  waitUntil(
    processInboundSms(fromPhone, text).catch((err) => {
      console.error(`[rc-sms] Error procesando SMS de ${fromPhone}:`, err);
    })
  );

  return NextResponse.json({ ok: true, accepted: true, type });
}

async function processInboundSms(rawPhone: string, text: string) {
  const normalized = normalizePhone(rawPhone);
  if (!normalized) {
    console.error(`[rc-sms] Teléfono inválido: "${rawPhone}"`);
    return;
  }

  // 1. Busca el contacto (crudo y normalizado para maximizar coincidencias).
  let contactId: string | null = null;
  try {
    const contact =
      (await findGhlContactByPhone(rawPhone)) ??
      (await findGhlContactByPhone(toE164(normalized)!));
    if (contact?.id) {
      contactId = contact.id;
      console.log(`[rc-sms] Contacto GHL ${contactId} para ${normalized}`);
    }
  } catch (err) {
    console.error(`[rc-sms] Búsqueda GHL falló (${normalized}):`, err);
  }

  // 2. Si no existe, lo creamos.
  if (!contactId) {
    try {
      contactId = await upsertGhlContact(toE164(normalized)!);
      console.log(`[rc-sms] Contacto GHL creado ${contactId} para ${normalized}`);
    } catch (err) {
      console.error(`[rc-sms] Upsert GHL falló (${normalized}):`, err);
    }
  }

  if (!contactId) {
    console.error(`[rc-sms] Sin contactId; no se registra el SMS (${normalized})`);
    return;
  }

  // 3. Registra el SMS entrante en la conversación de GHL.
  const res = await addGhlInboundSms(contactId, text);
  if (res.ok) {
    console.log(`[rc-sms] SMS entrante registrado en GHL (contacto ${contactId})`);
  } else {
    console.error(
      `[rc-sms] Registro de SMS entrante falló (${res.status}) contacto ${contactId}:`,
      JSON.stringify(res.response)
    );
  }
}

/** Extrae el número del remitente del payload de RingCentral. */
function extractFromPhone(msg: any): string | null {
  const candidates = [
    msg?.from?.phoneNumber,
    msg?.from,
    msg?.fromNumber,
    msg?.phoneNumber,
  ];
  for (const c of candidates) {
    if (c && String(c).replace(/\D/g, "").length >= 7) return String(c);
  }
  return null;
}

/** Extrae el cuerpo del SMS (RingCentral lo pone en `subject`). */
function extractText(msg: any): string | null {
  const candidates = [msg?.subject, msg?.text, msg?.body, msg?.message];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

// Healthcheck simple.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "ringcentral-sms-webhook" });
}
