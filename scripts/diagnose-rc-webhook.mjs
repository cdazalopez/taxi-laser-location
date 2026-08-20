#!/usr/bin/env node
/**
 * Diagnóstico del webhook de SMS entrante de RingCentral.
 *
 * Consulta (JWT auth flow):
 *   1. Extensión autorizada por el JWT (id, número, tipo).
 *   2. Todas las suscripciones + estado de la nuestra.
 *   3. A qué extensión está asignado el número (features SMS).
 *   4. Últimos SMS en el message-store de la extensión.
 *
 * Uso: RC_CLIENT_ID=... RC_CLIENT_SECRET=... RC_JWT=... node scripts/diagnose-rc-webhook.mjs
 */

const SERVER = (process.env.RC_SERVER_URL ?? "https://platform.ringcentral.com").replace(/\/+$/, "");
const TARGET_NUMBER = process.env.RC_ACCOUNT_PHONE ?? "+14045968232";

function req(name) {
  const v = process.env[name];
  if (!v) { console.error(`✖ Falta ${name}`); process.exit(1); }
  return v;
}

async function getToken() {
  const basic = Buffer.from(`${req("RC_CLIENT_ID")}:${req("RC_CLIENT_SECRET")}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: req("RC_JWT"),
  });
  const res = await fetch(`${SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok) { console.error("✖ OAuth falló:", JSON.stringify(data)); process.exit(1); }
  return data.access_token;
}

async function api(token, path) {
  const res = await fetch(`${SERVER}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function todayISO() {
  // ISO de "hace 24h" para dateFrom (evita depender de Date.now formateo raro).
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

async function main() {
  console.log(`• Servidor: ${SERVER}`);
  console.log(`• Número objetivo: ${TARGET_NUMBER}\n`);
  const token = await getToken();
  console.log("✓ Autenticado\n");

  // 1. Extensión autorizada.
  console.log("═══ 1. Extensión autorizada por el JWT ═══");
  const ext = await api(token, "/restapi/v1.0/account/~/extension/~");
  if (ext.ok) {
    console.log(`   id: ${ext.data.id}  ext#: ${ext.data.extensionNumber}  name: ${ext.data.name}`);
    console.log(`   type: ${ext.data.type}  status: ${ext.data.status}`);
  } else {
    console.log(`   ✖ (${ext.status})`, JSON.stringify(ext.data).slice(0, 300));
  }
  const authExtId = ext.data?.id;

  // 2. Suscripciones.
  console.log("\n═══ 2. Suscripciones ═══");
  const subs = await api(token, "/restapi/v1.0/subscription");
  if (subs.ok) {
    const records = subs.data.records ?? [];
    console.log(`   total: ${records.length}`);
    for (const s of records) {
      console.log(`   - ${s.id}`);
      console.log(`       status: ${s.status}   transport: ${s.deliveryMode?.transportType}`);
      console.log(`       address: ${s.deliveryMode?.address}`);
      console.log(`       filters: ${JSON.stringify(s.eventFilters)}`);
      console.log(`       creado:  ${s.creationTime}   expira: ${s.expirationTime}`);
      if (s.disabledFilters?.length) console.log(`       ⚠ disabledFilters: ${JSON.stringify(s.disabledFilters)}`);
    }
  } else {
    console.log(`   ✖ (${subs.status})`, JSON.stringify(subs.data).slice(0, 300));
  }

  // 3. Asignación del número.
  console.log("\n═══ 3. Números de la cuenta (asignación + features SMS) ═══");
  const nums = await api(token, "/restapi/v1.0/account/~/phone-number?perPage=1000");
  if (nums.ok) {
    const records = nums.data.records ?? [];
    console.log(`   total números: ${records.length}`);
    const digits = (s) => String(s ?? "").replace(/\D/g, "");
    const target = records.find((n) => digits(n.phoneNumber) === digits(TARGET_NUMBER));
    if (target) {
      console.log(`   ► ${target.phoneNumber}`);
      console.log(`       usageType: ${target.usageType}`);
      console.log(`       features:  ${JSON.stringify(target.features)}`);
      console.log(`       extension: id=${target.extension?.id} ext#=${target.extension?.extensionNumber} name=${target.extension?.name}`);
      const smsOk = (target.features ?? []).includes("SmsSender");
      const ownedByAuth = String(target.extension?.id) === String(authExtId);
      console.log(`       → SMS habilitado: ${smsOk ? "sí" : "NO"}`);
      console.log(`       → asignado a la extensión autorizada (${authExtId}): ${ownedByAuth ? "sí" : "NO ⚠"}`);
    } else {
      console.log(`   ✖ El número ${TARGET_NUMBER} NO aparece en la cuenta.`);
    }
    // Muestra todos los números con feature SMS para tener el panorama.
    console.log("\n   Números con SmsSender:");
    for (const n of records.filter((n) => (n.features ?? []).includes("SmsSender"))) {
      console.log(`     ${n.phoneNumber}  ext=${n.extension?.id ?? "—"}(${n.extension?.extensionNumber ?? "?"})  ${n.usageType}`);
    }
  } else {
    console.log(`   ✖ (${nums.status})`, JSON.stringify(nums.data).slice(0, 300));
  }

  // 4. Message-store reciente.
  console.log("\n═══ 4. Últimos SMS en el message-store de la extensión autorizada ═══");
  const ms = await api(token, `/restapi/v1.0/account/~/extension/~/message-store?messageType=SMS&dateFrom=${encodeURIComponent(todayISO())}&perPage=10`);
  if (ms.ok) {
    const records = ms.data.records ?? [];
    console.log(`   SMS en las últimas 24h: ${records.length}`);
    for (const m of records) {
      const from = m.from?.phoneNumber ?? "?";
      const to = (m.to ?? []).map((t) => t.phoneNumber).join(",");
      console.log(`   - ${m.creationTime}  ${m.direction}  from ${from} → ${to}  "${String(m.subject ?? "").slice(0, 40)}"`);
    }
    if (!records.length) console.log("   ⚠ Ningún SMS en el message-store de esta extensión → el SMS de prueba llegó a OTRA extensión.");
  } else {
    console.log(`   ✖ (${ms.status})`, JSON.stringify(ms.data).slice(0, 300));
  }
}

main().catch((e) => { console.error("✖", e); process.exit(1); });
