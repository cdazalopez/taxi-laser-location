import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { toE164 } from "@/lib/phone";
import { sendRingCentralSms } from "@/lib/ringcentral";

// Runtime Node.js (no edge) para fetch completo.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook de GoHighLevel — SMS SALIENTE del dispatcher.
 *
 * GHL dispara este webhook cuando un dispatcher envía un SMS desde la
 * conversación. Extraemos destinatario + cuerpo y lo enviamos por RingCentral
 * desde `RC_ACCOUNT_PHONE`. Respondemos 200 al instante; el envío corre en
 * background.
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

  // Solo SMS: si GHL marca el tipo, ignoramos lo que no sea SMS.
  const type: string = String(payload?.type ?? payload?.messageType ?? "SMS");
  if (type && type.toUpperCase() !== "SMS") {
    return NextResponse.json({ ok: true, ignored: true, type });
  }

  const rawTo = extractToPhone(payload);
  const text = extractText(payload);

  if (!rawTo || !text) {
    console.warn("[ghl-outbound] Sin destinatario o sin texto. Payload:", JSON.stringify(payload).slice(0, 500));
    return NextResponse.json({ ok: true, ignored: true, reason: "no_to_or_text" });
  }

  const to = toE164(rawTo);
  if (!to) {
    console.error(`[ghl-outbound] Teléfono inválido: "${rawTo}"`);
    return NextResponse.json({ ok: true, ignored: true, reason: "bad_phone" });
  }

  waitUntil(
    sendRingCentralSms(to, text)
      .then((res) => {
        if (res.ok) {
          console.log(`[ghl-outbound] SMS enviado por RingCentral a ${to}`);
        } else {
          console.error(
            `[ghl-outbound] Envío por RingCentral falló (${res.status}) a ${to}:`,
            JSON.stringify(res.response)
          );
        }
      })
      .catch((err) => {
        console.error(`[ghl-outbound] Error enviando SMS a ${to}:`, err);
      })
  );

  return NextResponse.json({ ok: true, accepted: true, to });
}

/** Extrae el número del destinatario del webhook de GHL. */
function extractToPhone(payload: any): string | null {
  const candidates = [
    payload?.phone,
    payload?.to,
    payload?.number,
    payload?.contact_phone,
    payload?.contact?.phone,
  ];
  for (const c of candidates) {
    if (c && String(c).replace(/\D/g, "").length >= 7) return String(c);
  }
  return null;
}

/** Extrae el cuerpo del mensaje del webhook de GHL. */
function extractText(payload: any): string | null {
  const candidates = [payload?.message, payload?.body, payload?.text];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

// Healthcheck simple.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "ghl-outbound-webhook" });
}
