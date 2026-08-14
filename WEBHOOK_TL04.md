# Webhook TL_04 — TaxiCaller → WhatsApp

Reemplazo del scenario **TL_04** de Make.com. Vive dentro de este proyecto
(`taxi-laser`, que también sirve la app `/location`).

## Endpoint

`POST /api/webhooks/taxicaller` — responde `200` al instante y procesa en
background (`waitUntil`).

Campos esperados en el webhook (JSON o form): `event`, `job_id`,
`vehicle_make`, `vehicle_color`, `vehicle_plate`, `fare`, `passenger_phone`
(también acepta `phone` / `phone1..phone6`).

### Eventos y mensajes

| `event` | Mensaje |
| --- | --- |
| `waiting_for_passenger` | `Su Taxi {make} {color} con placa {plate} ha llegado / 404-596-8232` |
| `job_marked_as_delivered` | `Su servicio realizado por la unidad {make} ha finalizado por ${fare} / 404-596-8232` |
| `cancelled_by_company` | `Su servicio ha sido cancelado, para solicitarlo nuevamente por favor llame o envie un SMS al 404-596-8232` |

## Canal de envío

`SEND_CHANNEL=ghl` (default): envía por **GoHighLevel Conversations API**
(`POST /conversations/messages`, `type: WhatsApp`, por `contactId`). Es el mismo
canal que usaba el TL_04 original. Toda la data viene del webhook — **no** se
consulta la API de TaxiCaller.

`SEND_CHANNEL=meta`: ruta alternativa por Meta Graph API (plantillas/texto).
⚠️ Actualmente **no usable**: el número de WhatsApp fue migrado a la WABA de GHL,
así que el token/phone-id directos de Meta ya no controlan ese número.

## ⚠️ Limitación conocida: ventana de 24h

WhatsApp bloquea mensajes de **texto libre** iniciados por el negocio si el
cliente no ha respondido en las últimas 24h (error de GHL: *"more than 24 hours
have passed since the customer last replied"*). Como estas notificaciones son
texto libre, **entregan solo dentro de la ventana de 24h**.

En la práctica entrega para la mayoría (el cliente suele escribir para pedir el
taxi → ventana abierta). Falla en silencio para reservas por teléfono/app sin
mensaje previo. La solución definitiva es usar **plantillas aprobadas de
WhatsApp vía GHL** (acción de Workflow) — pendiente si se requiere cobertura
total.

## Variables de entorno (Vercel, production)

`GHL_TOKEN`, `GHL_LOCATION_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_GRAPH_VERSION`, `TAXICALLER_COMPANY_ID`, `SEND_CHANNEL=ghl`.
