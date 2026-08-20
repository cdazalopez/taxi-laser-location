# SMS RingCentral ↔ GoHighLevel

Puente bidireccional de SMS entre **RingCentral** (número `+14045968232`) y la
bandeja de conversaciones de **GoHighLevel** (location `FmXJ8J0Ccird2AKk8pzQ`).

## URLs de producción (registrar en cada proveedor)

Usa el dominio estable `taxilaser.neuralpreneur.com` (NO la URL específica del
deployment, que tiene Deployment Protection y responde 302).

| Proveedor | Registrar esta URL |
| --- | --- |
| **RingCentral** (subscripción SMS entrante) | `https://taxilaser.neuralpreneur.com/api/webhooks/ringcentral-sms` |
| **GoHighLevel** (conversation provider / webhook SMS saliente) | `https://taxilaser.neuralpreneur.com/api/webhooks/ghl-outbound` |

Cada endpoint expone además un `GET` de healthcheck que responde
`{ "ok": true }`.

## Suscripción de RingCentral (SMS entrante)

Registrada con `scripts/register-rc-webhook.mjs` (JWT auth flow).

| Campo | Valor |
| --- | --- |
| Subscription ID | `58c77df6-950e-4c28-a2fa-70480045b828` |
| Status | `Active` |
| Event filter | `/restapi/v1.0/account/~/extension/**62611342007**/message-store/instant?type=SMS` |
| Address | `https://taxilaser.neuralpreneur.com/api/webhooks/ringcentral-sms` |
| Expira | 2036-08-17 |

> **⚠ La suscripción debe atarse a la extensión que RECIBE los SMS, no a la del
> JWT.** El número `+14045968232` es `MainCompanyNumber` y sus SMS entrantes
> aterrizan en la extensión de usuario **102 (`62611342007`, "TAXI LASER LLC")**,
> NO en la extensión del JWT (`62611333007`). La primera suscripción
> (`29ae3c9e…`, atada a `~` = ext del JWT) quedó `Active` pero **nunca disparó**
> porque esa extensión no recibe nada. Por eso se recrea con
> `RC_EXTENSION_ID=62611342007`.
>
> **Requisitos de scopes** en la app (Message API, Client ID
> `8ljY2zqRERFdOnbLEdoKvm`): `SMS`, `SubscriptionWebhook` (sin él → `403 SUB-528`
> al crear), y `ReadAccounts` (para diagnosticar la asignación número→extensión).
>
> Para re-registrar / listar / recrear la suscripción:
> `RC_CLIENT_ID=... RC_CLIENT_SECRET=... RC_JWT=... [RC_EXTENSION_ID=62611342007] node scripts/register-rc-webhook.mjs [--list] [--force]`
>
> Diagnóstico: `scripts/diagnose-rc-webhook.mjs` (estado de suscripción + message-store)
> y `scripts/find-sms-extension.mjs` (escanea todas las extensiones para hallar
> dónde caen los SMS).

## Endpoint 1 — Entrante: `POST /api/webhooks/ringcentral-sms`

SMS del cliente → RingCentral → GHL.

1. **Handshake de validación**: si el request trae el header `Validation-Token`,
   se responde `200` devolviendo ese mismo header (lo exige RingCentral al
   crear/renovar la subscripción).
2. En cada SMS entrante: extrae el número del remitente (`body.from.phoneNumber`)
   y el cuerpo (`body.subject`), busca el contacto en GHL por teléfono y **lo
   crea si no existe** (`/contacts/upsert`).
3. Registra el mensaje como **entrante** en GHL vía
   `POST /conversations/messages/inbound` (`type: SMS`).
4. Responde `200` al instante; el trabajo con GHL corre en background
   (`waitUntil`).

> El endpoint correcto para registrar un mensaje recibido es
> `/conversations/messages/inbound`. El `/conversations/messages` "a secas" es
> para salientes y dispararía un envío real por el proveedor SMS de GHL.

## Endpoint 2 — Saliente: `POST /api/webhooks/ghl-outbound`

SMS del dispatcher (en GHL, tab custom del Conversation Provider) → RingCentral
→ cliente. GHL manda un POST **firmado** (Ed25519) al Delivery URL.

1. Lee el **body crudo** (`req.text()`) ANTES de parsear (necesario para la firma).
2. **Verifica la firma Ed25519** del header `X-GHL-Signature` (base64) con la
   public key de GHL: `crypto.verify(null, bodyBuffer, publicKey, sigBuffer)`.
   Firma inválida/ausente → **401** y no procesa nada.
3. Parsea el payload verificado (loguea el payload completo para debug) y valida
   destinatario (`phone`) + cuerpo (`message`). Falta alguno → **400**.
4. Envía el SMS por RingCentral desde `RC_ACCOUNT_PHONE`
   (`sendRingCentralSms()` en `lib/ringcentral.ts`). Se **await**ea el envío.
5. Confirma el estado a GHL (`updateGhlMessageStatus()` →
   `PUT /conversations/messages/{messageId}/status`, `delivered` | `failed`).
6. Responde **200** si el envío fue exitoso, **500** si el envío real falló.

> La public key de GHL está hardcodeada en el route; se puede sobreescribir con
> `GHL_WEBHOOK_PUBLIC_KEY` para pruebas locales con un par de llaves propio.

### Conversation Provider (GHL)

Canal custom (aparece como tab separado en la conversación, no reemplaza el SMS
default de GHL). El número `+14045968232` NUNCA se registra en Phone Numbers de
GHL — todo entra/sale por RingCentral.

- `conversationProviderId`: `6a870e6d202787fbd6fb7ccc`
- **⚠ Actualmente DESHABILITADO en el inbound.** El `GHL_TOKEN` no tiene acceso a
  ese provider → GHL respondía `401 CONVERSATIONS_MSG_PROVIDER_NO_ACCESS` y el
  mensaje entrante no se registraba. Por eso el inbound va al **canal SMS default
  de GHL** (sin `conversationProviderId`). El adjuntar el id está detrás del flag
  `GHL_USE_CONVERSATION_PROVIDER=on` en `lib/ghl.ts` → `addGhlInboundSms`.
  Para re-activar el canal custom hay que primero darle acceso al token
  (token OAuth de la app dueña del provider, scope `conversations/message.write`).

## Auth RingCentral

OAuth server-to-server. **En producción se usa el flujo JWT** (`RC_JWT` está
configurado). Si `RC_JWT` no estuviera, cae a `client_credentials` (Basic auth
con Client ID + Client Secret). El access token se cachea en memoria del proceso
hasta ~30s antes de expirar.

## Variables de entorno (en Vercel: Production + Preview salvo nota)

| Var | Valor | Estado |
| --- | --- | --- |
| `RC_CLIENT_ID` | `8ljY2zqRERFdOnbLEdoKvm` | ✅ |
| `RC_CLIENT_SECRET` | *(secreto RC Developer Console)* | ✅ |
| `RC_ACCOUNT_PHONE` | `+14045968232` | ✅ |
| `RC_JWT` | *(JWT credential)* | ✅ (fuerza flujo JWT) |
| `RC_SERVER_URL` | *(opcional)* | Default `https://platform.ringcentral.com` |
| `GHL_TOKEN` | *(secreto)* | ✅ |
| `GHL_LOCATION_ID` | `FmXJ8J0Ccird2AKk8pzQ` | default en código |
| `GHL_CONVERSATION_PROVIDER_ID` | `6a870e6d202787fbd6fb7ccc` | ✅ (solo se usa si el flag está on) |
| `GHL_USE_CONVERSATION_PROVIDER` | `on` para adjuntar el provider al inbound | ⚠ OFF (token sin acceso al provider) |
| `GHL_WEBHOOK_PUBLIC_KEY` | *(opcional)* | override de la public key (pruebas) |

## Testing

- `scripts/test-ghl-outbound.mjs` — prueba el endpoint saliente: sin firma → 401,
  firma inválida → 401, firmado + malformado → 400. NO prueba el camino feliz
  (enviaría SMS real). Para el caso firmado, correr el dev server con
  `GHL_WEBHOOK_PUBLIC_KEY` = la test key del encabezado del script.
- `scripts/register-rc-webhook.mjs` — registra/lista la suscripción de RC (JWT).

## Estado actual y pendientes

**Hecho (todo en `main`, desplegado en prod, healthchecks 200):**
- Endpoints entrante + saliente implementados y verificados.
- Suscripción de RingCentral entrante **activa**, atada a la ext 102 (ver arriba).
- **Inbound end-to-end REAL confirmado**: SMS real al `+14045968232` → webhook
  disparó (visible en logs de Vercel) → mensaje registrado en GHL (canal default).
- Env vars configuradas en Vercel (Production + Preview).
- Verificación de firma 401 (saliente) confirmada en producción.

**Diagnóstico clave (causa raíz del webhook que no llegaba):** la 1ª suscripción
se ató a la extensión del JWT (`62611333007`), que no recibe tráfico. Los SMS del
`MainCompanyNumber` caen en la ext de usuario **102 (`62611342007`)**. Fix: recrear
la suscripción con `RC_EXTENSION_ID=62611342007`.

**Pendiente (manual, del lado de las plataformas):**
1. **Acceso del token al Conversation Provider** (para re-activar el canal custom):
   dar al `GHL_TOKEN` acceso al provider `6a870e6d202787fbd6fb7ccc` (token OAuth de
   la app dueña del provider, scope `conversations/message.write`), luego poner
   `GHL_USE_CONVERSATION_PROVIDER=on` y redeploy. Hoy el inbound usa el canal SMS
   default (funciona, pero no en el tab custom).
2. **Probar el saliente end-to-end**: responder desde GHL y ver que el SMS llegue
   al cliente vía RingCentral + estado `delivered`. En el 1er mensaje real revisar
   `[ghl-outbound] Payload verificado: ...` en Vercel y ajustar
   `extractToPhone`/`extractText`/`messageId` si los campos de GHL difieren.
3. Borrar `~/Downloads/rc-credentials.json` (clientSecret + jwt en claro; ya en Vercel).

## Infra / repo

- Repo: `github.com/cdazalopez/taxi-laser-location` (privado). `main` es la rama
  de trabajo; deploy por **Vercel CLI** (`vercel --prod`), NO por integración git.
- Dominio de producción: `taxilaser.neuralpreneur.com` (deployment-specific URLs
  tienen Deployment Protection → 302; usar siempre el dominio estable).
