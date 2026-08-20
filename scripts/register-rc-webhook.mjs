#!/usr/bin/env node
/**
 * Registra una suscripción webhook en RingCentral para SMS ENTRANTES.
 *
 * Autentica con la app "Message API" vía OAuth JWT flow (server-to-server) con
 * el JWT credential de la RC Developer Console, y crea una suscripción WebHook
 * para:
 *   /restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS
 * apuntando a nuestro endpoint de Vercel.
 *
 * Al crear la suscripción, RingCentral hace un POST de validación con el header
 * `Validation-Token` a la address; el endpoint /api/webhooks/ringcentral-sms ya
 * lo devuelve, así que la suscripción queda activa automáticamente.
 *
 * Uso:
 *   RC_CLIENT_ID=... RC_CLIENT_SECRET=... RC_JWT=... \
 *   node scripts/register-rc-webhook.mjs
 *
 * Flags:
 *   --list    Solo lista las suscripciones existentes y sale (no crea nada).
 *   --force   Crea la suscripción aunque ya exista una igual (misma address).
 */

const SERVER =
  (process.env.RC_SERVER_URL ?? "https://platform.ringcentral.com").replace(
    /\/+$/,
    ""
  );

const WEBHOOK_ADDRESS =
  process.env.RC_WEBHOOK_ADDRESS ??
  "https://taxilaser.neuralpreneur.com/api/webhooks/ringcentral-sms";

// Extensión a la que atar la suscripción. `~` = la del JWT; o un id explícito
// (RC_EXTENSION_ID) para suscribir la extensión que realmente recibe los SMS
// (p.ej. la del número principal de empresa, que no es la del JWT).
const EXT_ID = process.env.RC_EXTENSION_ID ?? "~";
const EVENT_FILTER = `/restapi/v1.0/account/~/extension/${EXT_ID}/message-store/instant?type=SMS`;

const args = new Set(process.argv.slice(2));
const LIST_ONLY = args.has("--list");
const FORCE = args.has("--force");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`✖ Falta la variable de entorno ${name}`);
    process.exit(1);
  }
  return v;
}

/** OAuth JWT flow (server-to-server) → access token. */
async function getToken() {
  const clientId = requireEnv("RC_CLIENT_ID");
  const clientSecret = requireEnv("RC_CLIENT_SECRET");
  const jwt = requireEnv("RC_JWT");

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", jwt);

  const res = await fetch(`${SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`✖ OAuth JWT flow falló (${res.status}):`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  console.log(`✓ Autenticado (token expira en ${data.expires_in}s)`);
  return data.access_token;
}

/** Lista suscripciones existentes. */
async function listSubscriptions(token) {
  const res = await fetch(`${SERVER}/restapi/v1.0/subscription`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`✖ No se pudieron listar suscripciones (${res.status}):`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data.records ?? [];
}

/** Crea la suscripción WebHook para SMS entrantes. */
async function createSubscription(token) {
  const res = await fetch(`${SERVER}/restapi/v1.0/subscription`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      eventFilters: [EVENT_FILTER],
      deliveryMode: {
        transportType: "WebHook",
        address: WEBHOOK_ADDRESS,
      },
      // ~7 años (máximo permitido). RingCentral igual la renueva/expira.
      expiresIn: 630720000,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`✖ Creación de suscripción falló (${res.status}):`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

async function main() {
  console.log(`• Servidor RingCentral: ${SERVER}`);
  console.log(`• Address del webhook:  ${WEBHOOK_ADDRESS}`);
  console.log(`• Event filter:         ${EVENT_FILTER}\n`);

  const token = await getToken();

  const existing = await listSubscriptions(token);
  const matching = existing.filter(
    (s) => s?.deliveryMode?.address === WEBHOOK_ADDRESS
  );

  if (existing.length) {
    console.log(`\n• Suscripciones existentes (${existing.length}):`);
    for (const s of existing) {
      const addr = s?.deliveryMode?.address ?? "—";
      console.log(`   - ${s.id}  [${s.status}]  ${addr}`);
    }
  } else {
    console.log("\n• No hay suscripciones existentes.");
  }

  if (LIST_ONLY) return;

  if (matching.length && !FORCE) {
    console.log(
      `\n⚠ Ya existe una suscripción apuntando a esta address (${matching[0].id}).`
    );
    console.log("  Usa --force para crear otra de todos modos.");
    return;
  }

  console.log("\n→ Creando suscripción...");
  const sub = await createSubscription(token);
  console.log("\n✓ Suscripción creada:");
  console.log(`   id:        ${sub.id}`);
  console.log(`   status:    ${sub.status}`);
  console.log(`   eventos:   ${(sub.eventFilters ?? []).join(", ")}`);
  console.log(`   address:   ${sub.deliveryMode?.address}`);
  console.log(`   expira:    ${sub.expirationTime}`);
}

main().catch((err) => {
  console.error("✖ Error inesperado:", err);
  process.exit(1);
});
