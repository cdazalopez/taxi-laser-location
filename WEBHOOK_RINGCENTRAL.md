# SMS RingCentral ↔ GoHighLevel

Puente **bidireccional** de SMS entre **RingCentral** (número principal
`+14045968232`) y la bandeja de **GoHighLevel** (location `FmXJ8J0Ccird2AKk8pzQ`),
vía un **Conversation Provider custom** de GHL ("RingCentral SMS" — tab separado).
El número nunca se registra en Phone Numbers de GHL: todo entra/sale por RC.

**Estado: funcionando end-to-end en producción** (inbound → tab RC; outbound desde
el tab RC → cliente por RingCentral; la respuesta del dispatcher arranca en RC).

## URLs de producción

Usa el dominio estable `taxilaser.neuralpreneur.com` (las URLs específicas del
deployment tienen Deployment Protection → 302).

| Qué | URL |
| --- | --- |
| RingCentral — suscripción SMS entrante | `https://taxilaser.neuralpreneur.com/api/webhooks/ringcentral-sms` |
| GHL — Delivery URL del Conversation Provider (saliente) | `https://taxilaser.neuralpreneur.com/api/webhooks/ghl-outbound` |
| GHL OAuth — bootstrap (una vez) | `https://taxilaser.neuralpreneur.com/oauth/callback` |

Los tres webhooks exponen `GET` de healthcheck (`{ "ok": true }`), salvo
`/oauth/callback` que redirige a autorizar.

## Flujo entrante — `POST /api/webhooks/ringcentral-sms`

Cliente → RingCentral → GHL (tab RC).

1. Handshake `Validation-Token` (echo del header → 200) al crear/renovar la suscripción.
2. Extrae remitente (`body.from.phoneNumber`) + cuerpo (`body.subject`), busca/crea
   el contacto en GHL (`findGhlContactByPhone`/`upsertGhlContact`, con `GHL_TOKEN` estático).
3. Registra el mensaje con `addGhlInboundSms` → `POST /conversations/messages/inbound`
   con **`type: "Custom"`** + `conversationProviderId`, autenticado con el **token OAuth
   de location** (ver abajo). Responde 200 al instante (`waitUntil`).

## Flujo saliente — `POST /api/webhooks/ghl-outbound`

Dispatcher escribe en el tab RC → GHL manda POST **firmado** (Ed25519) → RingCentral.

1. Lee el body crudo (`req.text()`) antes de parsear.
2. Verifica la firma Ed25519 de `X-GHL-Signature` (`crypto.verify(null, ...)`). Inválida/ausente → **401**.
3. Valida `phone` + `message` → falta alguno → **400**.
4. Envía por RingCentral (`sendRingCentralSms`, se **await**ea) desde `+14045968232`.
5. Confirma estado a GHL (`updateGhlMessageStatus` → `PUT .../status`, con token OAuth).
6. **200** si el envío salió, **500** si RC falló.

Public key de GHL hardcodeada en el route (override: `GHL_WEBHOOK_PUBLIC_KEY`).

## Auth — dos OAuth distintos

### RingCentral (para enviar y suscribir)
- Flujo **JWT** (`grant_type=jwt-bearer`). `RC_JWT` es el JWT del **usuario de la
  extensión 102** (`62611342007`, "TAXI LASER LLC") — la que **posee `+14045968232`
  con feature SmsSender** y recibe sus SMS. Envía con `/extension/~/sms`.
- App RC "Message Api" (Client ID `8ljY2zqRERFdOnbLEdoKvm`), scopes `SMS`,
  `SubscriptionWebhook`, `ReadAccounts`.

### GoHighLevel (para el Conversation Provider)
- Los llamados que tocan el provider (`addGhlInboundSms`, `updateGhlMessageStatus`)
  usan un **token OAuth de la app de Marketplace dueña del provider** — un API key /
  Private Integration da `401 CONVERSATIONS_MSG_PROVIDER_NO_ACCESS`.
- App "TaxiLaser-RingCentral-Bridge" (OAuth Client ID `6a8676513ef7bce3fba0a357-mt23xoqs`).
- `lib/ghl-oauth.ts`: bootstrap en `/oauth/callback` → guarda refresh token en Redis
  (Upstash) → deriva un **location token** (company→location vía `/oauth/locationToken`)
  → auto-refresca. Los otros llamados (contacto, TaxiCaller WhatsApp) siguen con `GHL_TOKEN`.

## Variables de entorno (Vercel: Production + Preview)

| Var | Valor | Notas |
| --- | --- | --- |
| `RC_CLIENT_ID` | `8ljY2zqRERFdOnbLEdoKvm` | app RC |
| `RC_CLIENT_SECRET` | *(secreto)* | |
| `RC_JWT` | *(JWT del usuario ext 102)* | dueño de `+14045968232` con SmsSender |
| `RC_ACCOUNT_PHONE` | `+14045968232` | número emisor |
| `RC_EXTENSION_ID` | `~` | extensión propia del JWT (ext 102) |
| `GHL_TOKEN` | *(secreto)* | contacto lookup/upsert + TaxiCaller (no provider) |
| `GHL_LOCATION_ID` | `FmXJ8J0Ccird2AKk8pzQ` | |
| `GHL_CONVERSATION_PROVIDER_ID` | `6a870e6d202787fbd6fb7ccc` | |
| `GHL_USE_CONVERSATION_PROVIDER` | `on` | activa token OAuth + `type Custom` + providerId |
| `GHL_OAUTH_CLIENT_ID` | `6a8676513ef7bce3fba0a357-mt23xoqs` | app dueña del provider |
| `GHL_OAUTH_CLIENT_SECRET` | *(secreto)* | |
| `GHL_OAUTH_REDIRECT_URI` | `https://taxilaser.neuralpreneur.com/oauth/callback` | debe coincidir con la app |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | *(Upstash)* | cache + tokens OAuth GHL |

## Scripts

- `scripts/register-rc-webhook.mjs` — registra/lista la suscripción de RC (JWT).
  Usar `RC_EXTENSION_ID=62611342007` para atarla a la ext que recibe los SMS.
- `scripts/diagnose-rc-webhook.mjs` — estado de suscripción + message-store + números.
- `scripts/find-sms-extension.mjs` — escanea extensiones para hallar dónde caen los SMS.

## Suscripción RC entrante activa

| Campo | Valor |
| --- | --- |
| Subscription ID | `58c77df6-950e-4c28-a2fa-70480045b828` |
| Event filter | `.../account/~/extension/62611342007/message-store/instant?type=SMS` |
| Address | `.../api/webhooks/ringcentral-sms` |

## Gotchas (lecciones que costaron sangre)

1. **La suscripción debe atarse a la extensión que RECIBE los SMS**, no a la del JWT.
   `+14045968232` es `MainCompanyNumber`; su SMS entrante cae en la **ext 102**
   (`62611342007`), no en la del JWT admin (`62611333007`). Suscribir la ext equivocada
   deja la suscripción `Active` pero **nunca dispara**.
2. **Enviar requiere el JWT de la extensión que posee el número.** La ext 102 tiene
   `+14045968232` con feature `SmsSender`; la ext admin no. Con el JWT admin: `MSG-304`
   (número no pertenece) o `CMN-419` (OutboundSMS extendido para otra extensión).
   Solución: `RC_JWT` = JWT del usuario ext 102.
3. **El Conversation Provider custom exige el token OAuth de SU app** (no `GHL_TOKEN`).
   Sin él → `401 CONVERSATIONS_MSG_PROVIDER_NO_ACCESS`.
4. **El inbound al provider custom usa `type: "Custom"`, NO `"SMS"`** (aunque el
   provider se muestre como SMS). Con `type SMS` + providerId → `400` mismatch;
   con `type Custom` + providerId → `201` y cae en el tab RC.
5. **El token OAuth de GHL salió a nivel Company**; los mensajes son de location →
   se deriva un location token vía `/oauth/locationToken` (companyId+locationId).
6. **Los Redirect URLs de GHL no aceptan `ghl`/`highlevel`/`leadconnector`** en la
   URL → el callback vive en `/oauth/callback` (neutro).

## Infra / repo

- Repo: `github.com/cdazalopez/taxi-laser-location` (privado). Deploy por **Vercel CLI**
  (`vercel --prod`), NO por integración git. El alias del dominio a veces hay que
  re-apuntarlo: `vercel alias set <deployment-url> taxilaser.neuralpreneur.com`.
- Pendiente menor: borrar `~/Downloads/rc-credentials.json` (secretos en claro; ya en Vercel).
