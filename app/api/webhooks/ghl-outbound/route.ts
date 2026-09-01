import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import crypto from "node:crypto";
import { toE164 } from "@/lib/phone";
import { sendRingCentralSms } from "@/lib/ringcentral";
import { updateGhlMessageStatus } from "@/lib/ghl";

// Runtime Node.js (no edge): necesitamos el módulo `crypto` para verificar la
// firma Ed25519 y leer el body crudo sin que nada lo parsee antes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Conversation Provider custom de GoHighLevel — SMS SALIENTE del dispatcher.
 *
 * Cuando un dispatcher escribe en el tab custom del provider dentro de GHL, GHL
 * hace un POST FIRMADO (Ed25519) a este Delivery URL. Nosotros:
 *   1. Leemos el body crudo (antes de parsear) para verificar la firma.
 *   2. Verificamos `X-GHL-Signature` (Ed25519, base64) con la public key de GHL.
 *      Firma inválida/ausente → 401 y no se procesa nada.
 *   3. Parseamos el payload, enviamos el SMS real vía RingCentral (desde
 *      RC_ACCOUNT_PHONE) y confirmamos el estado de vuelta a GHL.
 */

// Public key de GHL para verificar la firma de los webhooks. Se puede sobre-
// escribir con GHL_WEBHOOK_PUBLIC_KEY (útil para pruebas locales con un par de
// llaves propio). Es una llave PÚBLICA: no es secreto.
const GHL_PUBLIC_KEY_PEM =
  process.env.GHL_WEBHOOK_PUBLIC_KEY ??
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

let publicKey: crypto.KeyObject | null = null;
function getPublicKey(): crypto.KeyObject {
  if (!publicKey) publicKey = crypto.createPublicKey(GHL_PUBLIC_KEY_PEM);
  return publicKey;
}

/**
 * Verifica la firma Ed25519 del body crudo. GHL firma los bytes del body y
 * manda la firma en base64 en `X-GHL-Signature`. Ed25519 no lleva hash
 * intermedio → algoritmo `null` en crypto.verify.
 */
function verifySignature(rawBody: string, signatureB64: string | null): boolean {
  if (!signatureB64) return false;
  try {
    const signature = Buffer.from(signatureB64, "base64");
    return crypto.verify(
      null,
      Buffer.from(rawBody, "utf8"),
      getPublicKey(),
      signature
    );
  } catch (err) {
    console.error("[ghl-outbound] Error verificando firma:", err);
    return false;
  }
}

export async function POST(req: Request) {
  // 1. Body CRUDO antes de cualquier parseo (necesario para la firma).
  const raw = await req.text();
  const signature = req.headers.get("x-ghl-signature");

  // 2. Verificar la firma. Sin firma válida no se procesa nada.
  if (!verifySignature(raw, signature)) {
    console.warn(
      `[ghl-outbound] Firma inválida o ausente → 401 (sig ${signature ? "presente" : "ausente"})`
    );
    return NextResponse.json(
      { ok: false, error: "invalid_signature" },
      { status: 401 }
    );
  }

  // 3. Parsear el payload ya verificado.
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.warn("[ghl-outbound] Body no es JSON válido → 400");
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 }
    );
  }

  // Log del payload completo para debuggear los primeros mensajes reales.
  console.log("[ghl-outbound] Payload verificado:", JSON.stringify(payload));

  // Solo SMS: si GHL marca otro tipo, lo ignoramos (200, no es error).
  const type: string = String(payload?.type ?? payload?.messageType ?? "SMS");
  if (type && type.toUpperCase() !== "SMS") {
    return NextResponse.json({ ok: true, ignored: true, type });
  }

  const messageId: string | undefined =
    payload?.messageId ?? payload?.messageID ?? payload?.id;
  const rawTo = extractToPhone(payload);
  const text = extractText(payload);

  // 4. Payload malformado (sin destinatario o sin texto) → 400.
  if (!rawTo || !text) {
    console.warn(
      "[ghl-outbound] Sin destinatario o sin texto → 400. Payload:",
      JSON.stringify(payload).slice(0, 500)
    );
    return NextResponse.json(
      { ok: false, error: "missing_phone_or_message" },
      { status: 400 }
    );
  }

  const to = toE164(rawTo);
  if (!to) {
    console.error(`[ghl-outbound] Teléfono inválido: "${rawTo}" → 400`);
    return NextResponse.json({ ok: false, error: "bad_phone" }, { status: 400 });
  }

  // 5 + 6. Responder a GHL de INMEDIATO (200) para NO bloquear el campo de
  // escritura del dispatcher. El envío real por RingCentral y la confirmación de
  // estado (delivered/failed) corren en background con waitUntil; el estado se
  // reporta después vía la API de estado del provider, así que la UI de GHL
  // muestra el ✓ un instante más tarde sin trabar el compose.
  waitUntil(
    (async () => {
      try {
        const res = await sendRingCentralSms(to, text);
        if (res.ok) {
          console.log(
            `[ghl-outbound] SMS enviado por RingCentral a ${to} (msg ${messageId ?? "?"})`
          );
          await confirmStatus(messageId, "delivered");
        } else {
          console.error(
            `[ghl-outbound] Envío RingCentral falló (${res.status}) a ${to}:`,
            JSON.stringify(res.response)
          );
          await confirmStatus(messageId, "failed");
        }
      } catch (err) {
        console.error(`[ghl-outbound] Error enviando SMS a ${to}:`, err);
        await confirmStatus(messageId, "failed");
      }
    })()
  );

  return NextResponse.json({ ok: true, accepted: true, to, messageId: messageId ?? null });
}

/**
 * Confirma el estado del mensaje a GHL. Nunca propaga errores: un fallo al
 * actualizar el estado no debe cambiar la respuesta al envío real.
 */
async function confirmStatus(
  messageId: string | undefined,
  status: "delivered" | "failed"
): Promise<void> {
  if (!messageId) return;
  try {
    const res = await updateGhlMessageStatus(messageId, status);
    if (!res.ok) {
      console.error(
        `[ghl-outbound] No se pudo marcar msg ${messageId} como ${status} (${res.status}):`,
        JSON.stringify(res.response)
      );
    }
  } catch (err) {
    console.error(`[ghl-outbound] Error confirmando estado a GHL (${messageId}):`, err);
  }
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
