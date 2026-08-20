# SMS RingCentral ↔ GoHighLevel

Puente bidireccional de SMS entre **RingCentral** (número `+14045968232`) y la
bandeja de conversaciones de **GoHighLevel** (location `FmXJ8J0Ccird2AKk8pzQ`).

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

SMS del dispatcher (en GHL) → RingCentral → cliente.

1. GHL dispara el webhook al enviar un SMS. Extrae destinatario (`phone`) y
   cuerpo (`message`).
2. Envía el SMS por RingCentral desde `RC_ACCOUNT_PHONE`
   (`POST /restapi/v1.0/account/~/extension/~/sms`).
3. Responde `200` al instante; el envío corre en background.

## Auth RingCentral

OAuth server-to-server. Por defecto grant `client_credentials` (Basic auth con
Client ID + Client Secret). El access token se cachea en memoria del proceso
hasta ~30s antes de expirar. Si se configura `RC_JWT` (JWT credential de la RC
Developer Console) se usa el flujo `jwt-bearer` en su lugar.

## Variables de entorno

| Var | Valor | Notas |
| --- | --- | --- |
| `RC_CLIENT_ID` | `8ljY2zqRERFdOnbLEdoKvm` | App de RingCentral |
| `RC_CLIENT_SECRET` | *(secreto)* | **Pendiente**: tomarlo de RC Developer Console y agregarlo en Vercel |
| `RC_ACCOUNT_PHONE` | `+14045968232` | Número emisor (E.164) |
| `RC_SERVER_URL` | *(opcional)* | Default `https://platform.ringcentral.com` (sandbox: `https://platform.devtest.ringcentral.com`) |
| `RC_JWT` | *(opcional)* | Activa el flujo JWT en vez de client_credentials |
| `GHL_TOKEN` | *(ya configurado)* | — |
| `GHL_LOCATION_ID` | `FmXJ8J0Ccird2AKk8pzQ` | — |
| `GHL_SMS_PROVIDER_ID` | *(opcional)* | `conversationProviderId` para el mensaje entrante en GHL |
