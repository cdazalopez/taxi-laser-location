#!/usr/bin/env node
/**
 * Prueba el endpoint /api/webhooks/ghl-outbound (Conversation Provider de GHL).
 *
 * Casos:
 *   1. POST sin firma            → espera 401
 *   2. POST con firma inválida   → espera 401
 *   3. POST FIRMADO pero malformado (sin phone) → espera 400
 *
 * El caso 3 usa un par de llaves Ed25519 de PRUEBA (abajo). Para que verifique,
 * el servidor debe correr con la public key de prueba:
 *
 *   GHL_WEBHOOK_PUBLIC_KEY="$(cat <<'EOF'
 *   -----BEGIN PUBLIC KEY-----
 *   MCowBQYDK2VwAyEACcwm9h6pLu3wGbSCoOe/NaNY0v+PvQgGPlL1dUqsGPE=
 *   -----END PUBLIC KEY-----
 *   EOF
 *   )" npm run dev
 *
 * NO se prueba el camino feliz (200) porque enviaría un SMS REAL vía RingCentral.
 *
 * Uso:  node scripts/test-ghl-outbound.mjs [url]
 *   url por defecto: http://localhost:3000/api/webhooks/ghl-outbound
 */

import crypto from "node:crypto";

const URL_TARGET =
  process.argv[2] ?? "http://localhost:3000/api/webhooks/ghl-outbound";

// Par de llaves Ed25519 SOLO PARA PRUEBAS (no es la de producción de GHL).
const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHyRTk0Vf5t1F/7hSGK5owhEaWGc791leN1WigQPC1yg
-----END PRIVATE KEY-----`;

function sign(rawBody) {
  const key = crypto.createPrivateKey(TEST_PRIVATE_KEY_PEM);
  return crypto
    .sign(null, Buffer.from(rawBody, "utf8"), key)
    .toString("base64");
}

async function post(body, { signature } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (signature) headers["X-GHL-Signature"] = signature;
  const res = await fetch(URL_TARGET, { method: "POST", headers, body });
  const text = await res.text();
  return { status: res.status, body: text };
}

function check(name, got, expected) {
  const ok = got.status === expected;
  const mark = ok ? "✓" : "✖";
  console.log(`${mark} ${name}: HTTP ${got.status} (esperado ${expected})`);
  if (!ok) console.log(`    respuesta: ${got.body.slice(0, 200)}`);
  return ok;
}

async function main() {
  console.log(`• Target: ${URL_TARGET}\n`);
  let allOk = true;

  // 1. Sin firma → 401.
  const validPayload = JSON.stringify({
    type: "SMS",
    contactId: "test-contact",
    messageId: "test-msg-1",
    phone: "+14045551234",
    message: "hola desde el test",
  });
  allOk &= check("Sin firma", await post(validPayload), 401);

  // 2. Firma inválida → 401.
  allOk &= check(
    "Firma inválida",
    await post(validPayload, { signature: "ZmFrZS1zaWduYXR1cmU=" }),
    401
  );

  // 3. Firmado pero malformado (sin phone ni message) → 400.
  const badPayload = JSON.stringify({
    type: "SMS",
    contactId: "test-contact",
    messageId: "test-msg-2",
  });
  const res3 = await post(badPayload, { signature: sign(badPayload) });
  const ok3 = check("Firmado + malformado (sin phone)", res3, 400);
  if (!ok3 && res3.status === 401) {
    console.log(
      "    ⚠ Recibió 401: el server no está usando la public key de prueba.\n" +
        "      Reinicia el dev server con GHL_WEBHOOK_PUBLIC_KEY = la test key (ver encabezado del script)."
    );
  }
  allOk &= ok3;

  console.log(`\n${allOk ? "✓ Todos los casos pasaron" : "✖ Hubo fallos"}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("✖ Error inesperado:", err);
  process.exit(1);
});
