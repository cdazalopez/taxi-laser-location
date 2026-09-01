import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { handleInbound } from "@/lib/inbound-sms";

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
 *   2. En cada SMS entrante: extrae remitente + cuerpo y lo registra en GHL vía
 *      `handleInbound` (que ENCOLA y reintenta si GHL falla — cero pérdida).
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

  waitUntil(handleInbound(fromPhone, text));

  return NextResponse.json({ ok: true, accepted: true, type });
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
