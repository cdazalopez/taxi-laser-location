# 🚕 Taxi Laser — Handoff técnico (para lead developer)

> **Objetivo:** que puedas tomar las riendas de este proyecto como si siempre hubieras
> estado en él. Este doc + el código del repo es todo lo que necesitas. Última
> actualización: **2026-09-01**.
>
> ⚠️ **Este documento contiene credenciales/secretos operativos.** Guárdalo en un lugar
> seguro (gestor de contraseñas), **no lo publiques**, y **rota lo marcado como
> `ROTAR`** cuanto antes.

---

## 0. TL;DR para arrancar en 5 minutos
1. Este repo (`taxi-laser-location`) = **app de MENSAJERÍA/NOTIFICACIONES/DASHBOARD** (Next.js 14, App Router). Corre en Vercel, dominio **`taxilaser.neuralpreneur.com`**.
2. **Deploys NO son por git** → son por **Vercel CLI**: `vercel --prod --yes --scope cdazalopezs-projects`. Un `git push` NO despliega.
3. ⚠️ **GitHub está desactualizado**: hay ~24 commits locales **sin subir** (todo el trabajo reciente), en la rama `fix/ghl-contactid-cache-meta-fallback`. **Primer tarea recomendada: pushear/mergear a `main`** (ver §11).
4. Producción está **sana y estable**. Hay un **sistema de auto-prevención** (circuit breaker + alertas SMS) — ver §8.
5. Hay un **2º proyecto separado**: `taxi-laser-scheduling` (agendamiento/dispatchers + Supabase). Mapa completo en `~/Desktop/TAXI-LASER-MAP.md`.

---

## 1. Qué es el proyecto
Taxi Laser es una operación de despacho de taxis (Atlanta, GA) de **alto volumen (~5.000 viajes/día)**. Usa **GoHighLevel (GHL)** como CRM/inbox de conversaciones, **TaxiCaller** como sistema de despacho, y **RingCentral** para SMS/llamadas. Este repo automatiza la mensajería entre esos sistemas y provee un dashboard de KPIs.

**Hay 2 apps (distintas, cada una su deploy):**
| App / carpeta | Qué hace | Repo | Vercel | Este doc cubre |
|---|---|---|---|---|
| **`taxi-laser-location`** (ESTE) | Mensajería, notificaciones, SMS bridge, dashboard KPIs, auth | github.com/cdazalopez/taxi-laser-location | proyecto `taxi-laser` | ✅ |
| `taxi-laser-scheduling` | Agendamiento, dispatchers, asignaciones, round-robin (+ Supabase) | (sin remoto aún) | proyecto `taxi-laser-scheduling` | ⚠️ solo referencia |

---

## 2. Stack
- **Next.js 14.2.5** (App Router), **React 18**, **TypeScript**, **Tailwind**. Runtime **Node.js** en las rutas (no edge).
- **Vercel** (Fluid Compute) — hosting + Cron. Plan **Hobby** (crons solo diarios; por eso mucha lógica corre on-demand/inline).
- **Upstash Redis** (vía integración Vercel, vars `KV_REST_API_*`) — cache, tokens OAuth, contadores, estado del circuit breaker.
- **Sin base de datos propia** en esta app (la BD Supabase vive en el proyecto de scheduling).
- Dependencias mínimas: `next`, `react`, `react-dom`, `@vercel/functions`.

---

## 3. Arquitectura y flujos principales

### 3.1 Notificaciones de viaje (TaxiCaller → cliente)
`TaxiCaller webhook` → **`POST /api/webhooks/taxicaller`** → busca/crea contacto en GHL → envía notificación ("su taxi llegó", "servicio finalizado", "cancelado").
- Eventos soportados: `waiting_for_passenger`, `job_marked_as_delivered`, `cancelled_by_company`.
- Canal de salida: WhatsApp vía GHL Conversations (default). Dentro de 24h → texto libre; fuera → **plantilla vía GHL Workflow**.
- **Enrutado por canal** (`ROUTE_BY_INBOUND_CHANNEL=on`): si el cliente escribió por SMS, la notificación sale por **SMS de RingCentral** (vía el provider custom de GHL).
- **Fallback:** si GHL falla (429), la notificación sale por **SMS de RingCentral directo** (`RC_FALLBACK`). (Había fallback a Meta pero su token da 403 → deshabilitado.)
- Cachea `phone→contactId` en Redis para reducir llamadas a GHL.

### 3.2 Puente SMS bidireccional RingCentral ↔ GHL
- **Entrante** (cliente→negocio): `RingCentral webhook` → **`POST /api/webhooks/ringcentral-sms`** → registra el SMS en la conversación de GHL (como `type:"Custom"` con el Conversation Provider custom).
- **Saliente** (dispatcher→cliente): dispatcher escribe en GHL → GHL llama (firmado Ed25519) a **`POST /api/webhooks/ghl-outbound`** → envía el SMS real por RingCentral. **Responde 200 al instante y envía en background** (para no bloquear el compose de GHL).
- Doc detallada: **`WEBHOOK_RINGCENTRAL.md`** y **`RUNBOOK-sms-bridge.md`** en el repo.

### 3.3 Conductores en línea (en vivo)
`TaxiCaller "Shift started/ended" webhook` → **`POST /api/webhooks/taxicaller-shift`** → mantiene un set en Redis (sorted set `tc:online`) → el dashboard muestra el conteo en vivo. Auto-reconciliación contra el report de sesiones de TaxiCaller.

### 3.4 Dashboard de KPIs
**`/dashboard`** (login por usuario) consume **`/api/dashboard`** → KPIs de dispatchers (tiempos de respuesta, por usuario/plataforma/rango) + tiles operativas (viajes, vehículos, llamadas perdidas, mensajes, ahorro).
- ⚠️ **KPIs de dispatchers DESACTIVADOS hoy** (`KPI_DISABLED=on`): el agregador leía miles de conversaciones de GHL y agotó la cuota (causó un incidente). **Se está migrando a un modelo por EVENTOS** (ver §10).

### 3.5 Captura de ubicación
`/location` — página pública donde el cliente comparte su ubicación GPS (usada por el flujo de despacho).

---

## 4. Endpoints

### Webhooks (entrantes de terceros)
| Ruta | Fuente | Qué hace | Auth |
|---|---|---|---|
| `POST /api/webhooks/taxicaller` | TaxiCaller (job events) | Notificaciones de viaje | ninguna (payload) |
| `POST /api/webhooks/taxicaller-shift` | TaxiCaller (shift events) | Conteo conductores en línea | ninguna |
| `POST /api/webhooks/ringcentral-sms` | RingCentral | Registrar SMS entrante en GHL | handshake Validation-Token |
| `POST /api/webhooks/ghl-outbound` | GoHighLevel (provider) | Enviar SMS saliente por RC | **firma Ed25519** |
| `GET/POST /api/cron/kpis` | Vercel Cron / manual | Agregador KPIs (hoy no-op) | `x-vercel-cron` o `?key=MONITOR_KEY` |

### APIs internas
| Ruta | Qué hace | Auth |
|---|---|---|
| `GET /api/dashboard` | Datos del dashboard | Bearer token o `?key=MONITOR_KEY` |
| `GET /api/monitor` | Monitor técnico de mensajes | `?key=MONITOR_KEY` |
| `GET /api/health` | Estado del sistema (circuito, 429, entregas) | público=básico; `?key=` = detalle. `?test=alert` prueba alertas |
| `POST /api/auth/login` | Login del dashboard | usuario/contraseña |
| `GET/POST/DELETE /api/auth/users` | Gestión de usuarios | admin (MONITOR_KEY o token admin) |
| `GET /oauth/callback` | Bootstrap OAuth de la app GHL | code de GHL |

### Páginas
`/` · `/dashboard` (KPIs, login) · `/monitor` (monitor técnico) · `/location` (captura GPS)

---

## 5. Estructura del repo (`lib/`)
| Archivo | Responsabilidad |
|---|---|
| `ghl.ts` | Cliente GHL: contactos, mensajes, plantillas, workflows, conversaciones, usuarios. `ghlFetch` = choke point con retry + **reporte de 429 al circuit breaker**. |
| `ghl-oauth.ts` | OAuth de la app GHL (token base rotativo + location token). Detecta `invalid_grant` → alerta. |
| `ringcentral.ts` | Cliente RingCentral: `sendRingCentralSms`, token JWT, `getMissedCalls`. |
| `taxicaller.ts` | Cliente TaxiCaller: JWT, snapshot (vehículos, viajes vía reports, conductores hoy), conteo en línea + reconciliación. |
| `health.ts` | **Sistema de auto-prevención**: circuit breaker + detección (429, auth GHL, Redis, entregas) + alertas SMS. |
| `kpi.ts` | Agregador de KPIs de dispatchers (hoy desactivado; se reescribe a eventos). |
| `cache.ts` | Redis (Upstash) helpers. |
| `events.ts` | Telemetría de mensajes + contadores + viajes/día. |
| `auth.ts` | Auth del dashboard: scrypt + tokens HMAC, usuarios en Redis. |
| `messages.ts` | Plantillas de texto de las notificaciones. |
| `phone.ts` | Normalización de teléfonos (E.164). |
| `whatsapp.ts` | Cliente Meta WhatsApp Graph API (fallback, hoy con token 403). |

---

## 6. Variables de entorno (en Vercel, proyecto `taxi-laser`)
Gestión: `vercel env ls production --scope cdazalopezs-projects` / `vercel env pull`.

**Los valores están en Vercel** (el lead dev necesita acceso al proyecto). Nombres y propósito:

| Var | Propósito |
|---|---|
| `GHL_TOKEN` | Token estático (PIT) de GHL para lecturas/escrituras de contactos/mensajes |
| `GHL_LOCATION_ID` | `FmXJ8J0Ccird2AKk8pzQ` (la sub-cuenta Taxi Laser) |
| `GHL_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | App Marketplace de GHL (dueña del Conversation Provider) |
| `GHL_CONVERSATION_PROVIDER_ID` | `6a870e6d202787fbd6fb7ccc` (provider SMS custom) |
| `GHL_USE_CONVERSATION_PROVIDER` | `on` |
| `GHL_WORKFLOW_ARRIVAL_ID` / `_DELIVERED_ID` / `_CANCELLED_ID` | Workflows GHL que envían las plantillas de WhatsApp |
| `RC_CLIENT_ID` / `RC_CLIENT_SECRET` / `RC_JWT` | Credenciales RingCentral (JWT del usuario ext 102) |
| `RC_ACCOUNT_PHONE` | `+14045968232` (número que envía/recibe SMS) |
| `RC_EXTENSION_ID` | Extensión dueña del número (102) |
| `TAXICALLER_API_KEY` | API key de TaxiCaller (company 28658) |
| `TAXICALLER_COMPANY_ID` | 28658 |
| `KV_REST_API_URL` / `_TOKEN` / `_READ_ONLY_TOKEN` / `KV_URL` / `REDIS_URL` | Upstash Redis (integración Vercel) |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_GRAPH_VERSION` | Meta WhatsApp (fallback; token da 403 → **revisar**) |
| `MONITOR_KEY` | Clave del dashboard/monitor/health |
| `SESSION_SECRET` | Firma de tokens de sesión del dashboard |
| `ALERT_PHONE` | Números para alertas SMS (lista por comas) |
| `SEND_CHANNEL` | `ghl` (canal de notificaciones) |
| `ROUTE_BY_INBOUND_CHANNEL` | `on` (enrutado SMS/WhatsApp por canal del cliente) |
| `KPI_DISABLED` | `on` (agregador KPIs apagado — ver §10) |
| `KPI_MAX_CONVERSATIONS` / `KPI_MIN_INTERVAL_SEC` | Tuning del agregador (legado) |
| `COST_TEMPLATE_USD` / `COST_FREETEXT_USD` | Estimación de costo en el dashboard |

**Flags/env opcionales leídos por el código (defaults en código):** `RC_FALLBACK` (def on), `META_FALLBACK` (def off), `GHL_MAX_RETRIES` (def 1), `HEALTH_429_THRESHOLD` (15), `HEALTH_CIRCUIT_TTL_SEC` (300), `HEALTH_ALERT_DEBOUNCE_SEC` (900), `HEALTH_DELIVERY_FAIL_THRESHOLD` (10), `KPI_TZ` (America/New_York), `KPI_CONCURRENCY`, `KPI_SLA_SECONDS`, `KPI_WINDOW_DAYS`, `TC_ONLINE_TTL_HOURS` (18), `TC_MIN_INTERVAL_SEC` (600), `TAXICALLER_TRIPS_TEMPLATE` (19), `TAXICALLER_SHIFT_TEMPLATE` (14343), `TAXICALLER_SESSION_TEMPLATE` (9980), `SAVINGS_PER_MSG_USD`, `CRON_SECRET`, `GHL_WEBHOOK_PUBLIC_KEY`.

---

## 7. 🔐 Credenciales conocidas (rotar tras el handoff)
| Qué | Valor | Nota |
|---|---|---|
| Dashboard/monitor/health `MONITOR_KEY` | `laser-i0hmw390h5` | también acceso admin del dashboard |
| Dashboard user (admin) | `admin` / `TL-5qkcrm` | rol admin |
| Dashboard user | `mariano` / `TL-cdupo3` | rol admin |
| Dashboard user | `juancarlos` / `TL-6d65c8` | rol viewer |
| Alertas SMS (`ALERT_PHONE`) | `+12817339871`, `+19362029970` | |
| TaxiCaller API key | `34d5d6c5c9711d959c0415c70460d163` | company **28658** |
| GHL location id | `FmXJ8J0Ccird2AKk8pzQ` | |
| GHL Conversation Provider id | `6a870e6d202787fbd6fb7ccc` | |
| RingCentral número | `+14045968232` (ext 102) | |

### ⚠️ Secretos EXPUESTOS en los escenarios de Make — **ROTAR YA** (no reutilizar)
Estaban hardcodeados en los blueprints de Make.com; considéralos comprometidos:
- **GHL Private Integration Token** `pit-522b3f89-…`
- **Google Maps API key** `AIzaSyDrun0…`
- **TaxiCaller API keys** `517401d9…` y `2b48ad5d…` (company 57928/8354 — ver discrepancia §10)
- **Anthropic API key** `sk-ant-api03-Y1V1pzTN…`
- **Supabase `service_role` JWT** (privilegio máximo — el más crítico; proyecto `grouaoyefqkvwgsfyghv.supabase.co`)

Los valores de env de Vercel (`GHL_TOKEN`, `RC_*`, etc.) **no están aquí**: se obtienen con acceso al proyecto Vercel (`vercel env pull`).

---

## 8. Sistema de auto-prevención (importante)
`lib/health.ts` — detecta y auto-mitiga incidentes:
1. **GHL rate-limit (429):** `ghlFetch` cuenta 429s; al superar umbral abre un **circuit breaker** (Redis `h:ghl:circuit`) → los consumidores discrecionales de GHL (agregador KPIs, enriquecimiento del monitor) **se auto-pausan** → libera cuota para los webhooks de clientes → cierra solo por TTL.
2. **Token OAuth GHL muerto (`invalid_grant`):** alerta crítica (requiere re-autorizar en `/oauth/callback`).
3. **Redis (Upstash) caído:** alerta (sin usar Redis).
4. **Fallos de entrega (>N/min):** alerta.
Alertas por **SMS a `ALERT_PHONE`** (debounce por tipo). Estado en vivo: `GET /api/health?key=MONITOR_KEY`. Probar: `?test=alert`.

---

## 9. Deploy
- **SIEMPRE:** `vercel --prod --yes --scope cdazalopezs-projects` (sin `--scope` da "Not authorized").
- Los deploys **no** se disparan por git. El dominio `taxilaser.neuralpreneur.com` se re-aliasa solo tras cada deploy `--prod`.
- Verificar: `vercel inspect taxilaser.neuralpreneur.com --scope cdazalopezs-projects`.
- Logs: `vercel logs <deployment-url> --scope cdazalopezs-projects` (ojo: usar la URL del deployment, no el dominio, para logs completos).

---

## 10. Trabajo abierto / roadmap
1. **KPIs por eventos (próxima tarea):** reescribir el agregador para NO pollear GHL. Capturar cada mensaje (in/out) vía webhooks que GHL empuja y guardar en Redis; calcular KPIs localmente (**$0 de cuota GHL**). Fase 1: solo SMS (stream que ya capturamos). Fase 2: WhatsApp vía Workflow de GHL → endpoint nuevo `/api/webhooks/ghl-message`. Mantener `KPI_DISABLED=on` hasta migrar. (Detalle en memoria del proyecto.)
2. **Migración de Make.com → esta app:** sacar los flujos de despacho de Make (costo alto). Mapa completo en **`MIGRATION-make-to-app.md`**. Quick wins: TL_09 Job_Accepted, TL_Auto_Assign, TL_02. TL_04 y TL_03 ya cubiertos.
3. **Discrepancia TaxiCaller:** esta app usa `api.taxicaller.net` company **28658**; los flujos de Make usan `api-rc.taxicaller.net` (staging) company **57928/8354**. Confirmar cuál es producción para reservas/booker.
4. **Meta WhatsApp:** el token da **403** (sin permisos) → arreglar si se quiere Meta como fallback real.
5. **Rotar secretos expuestos** (§7).
6. **GitHub al día:** pushear/mergear la rama a `main` (§11).
7. **Unificación de carpetas / monorepo** (opcional): ver `~/Desktop/TAXI-LASER-MAP.md`.

---

## 11. ⚠️ Estado de git (leer antes de tocar)
- Rama actual: **`fix/ghl-contactid-cache-meta-fallback`**. `main` (en GitHub) está **~24 commits atrás** (último push: `b13b3c0`).
- Todo el trabajo reciente está commiteado **local** pero **no en GitHub**. Producción sí lo tiene (deploy directo por Vercel CLI).
- **Recomendado antes de continuar:** `git checkout main && git merge fix/ghl-contactid-cache-meta-fallback && git push origin main` (o via PR). Confirmar con el owner.

---

## 12. Plataformas a las que necesitas acceso
| Plataforma | Para qué | Cómo |
|---|---|---|
| **Vercel** (team `cdazalopezs-projects`) | Deploys, env vars, logs | invitación al team; proyectos `taxi-laser` y `taxi-laser-scheduling` |
| **GitHub** (`cdazalopez/taxi-laser-location`) | Código | acceso al repo |
| **GoHighLevel** | Location Taxi Laser + app Marketplace (OAuth) + Conversation Provider + Workflows | sub-cuenta + agencia; app "TaxiLaser-RingCentral-Bridge" |
| **TaxiCaller** | Panel admin (reports, webhooks, plantillas) + API | login del panel + API key |
| **RingCentral** | Developer console (app: JWT, SMS, ReadCallLog, webhooks) | acceso a la app de RC |
| **Upstash** (vía Vercel) | Redis (integración `upstash-kv-…`) | dashboard de Upstash o Vercel Integrations |
| **Meta / WhatsApp Business** | Token/plantillas del fallback | Meta Business Manager |
| **Supabase** | BD del proyecto de scheduling (`pool_activo`, `dispatchers`) | proyecto `grouaoyefqkvwgsfyghv` |
| **Make.com** (org Neuralpreneur AI) | Flujos legacy a migrar/apagar | acceso al team |
| **Anthropic / Claude** | NLP en flujos de Make (TL_07) | API key |

---

## 13. Docs relacionados en el repo
- `WEBHOOK_RINGCENTRAL.md` — puente SMS RC↔GHL (fuente de verdad, gotchas).
- `RUNBOOK-sms-bridge.md` — runbook operativo del bridge (re-autorizar OAuth, etc.).
- `WEBHOOK_TL04.md` — reemplazo del scenario TL_04 de Make.
- `MIGRATION-make-to-app.md` — mapa de migración de Make.
- `~/Desktop/TAXI-LASER-MAP.md` — mapa de las carpetas/proyectos (fuera del repo).

---

## 14. Runbook rápido: síntoma → dónde mirar
| Síntoma | Dónde / qué |
|---|---|
| No llegan notificaciones (llegada/finalizado) | `GET /api/health` (¿circuito abierto?). Logs `[taxicaller]`. Revisar 429 de GHL. |
| SMS entrante/saliente falla | Logs `[rc-sms]` / `[ghl-outbound]`. Verificar RC_JWT, provider GHL. |
| Compose de GHL lento/bloqueado | Ya resuelto (ghl-outbound async). Si vuelve, revisar latencia de RC. |
| Mensajes "desaparecen"/no se buscan en GHL | Casi siempre = saturación 429 de GHL (revisar `/api/health`). Residual: eventual-consistency de GHL + reasignación (scheduling). |
| Dashboard KPIs congelados | Esperado: `KPI_DISABLED=on`. Re-habilitar solo con el modelo por eventos. |
| Conductores en línea mal | Webhook `taxicaller-shift`; el conteo converge en ~1 ciclo de turnos. |
| Alertas SMS no llegan | `ALERT_PHONE` seteado; probar `/api/health?key=...&test=alert`. |

---

*Fin del handoff. El estado detallado y decisiones históricas están en la memoria del
proyecto de Claude Code (local a la máquina); este doc + los `.md` del repo lo resumen
todo lo necesario para continuar.*
