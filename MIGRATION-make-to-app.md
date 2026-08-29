# Migración Make.com → app Next.js (Taxi Laser)

Objetivo: sacar los flujos de automatización de Make.com (costo por operación alto
a ~5.000 viajes/día) y manejarlos en nuestra app Next.js, que ya opera webhooks de
TaxiCaller, GoHighLevel y RingCentral. Valeria = **Conversation AI + Voice AI nativos
de GHL** (capa de conversación); nuestra app = el "cerebro" de automatización.

Fecha del mapeo: 2026-08-29. Org Make: Neuralpreneur AI (team 1851143, plan Pro 40k ops/mes).

## 🔴 Seguridad — rotar TODO esto (expuesto en texto plano en Make)
| Credencial | Prefijo | Dónde |
|---|---|---|
| GHL Private Integration Token | `pit-522b3f89…` | TL_02, TL_03, TL_06, TL_09, Auto_Assign, TL_01 |
| Google Maps API key | `AIzaSyDrun0…` | TL_07, datastore |
| TaxiCaller API key (A) | `517401d9…` | datastore |
| TaxiCaller API key (B) | `2b48ad5d…` | TL_01, datastore |
| Anthropic API key | `sk-ant-api03-Y1V1pzTN…` | TL_07, datastore |
| Supabase service_role JWT | `eyJhbGci…role:service_role` | Sync Pool (**máximo privilegio, urgente**) |

Al migrar, todo va a **env vars de Vercel** (nunca en código/blueprints).

## Discrepancias a resolver antes de construir
1. **Dominio/empresa TaxiCaller inconsistente:** nuestro dashboard usa `api.taxicaller.net` (`/api/v1`, company **28658**). Los flujos Make usan `api-rc.taxicaller.net` (`/AdminService/v1`) con company **57928** (live) y **8354** (rc/booker). Hay que confirmar cuál es producción real para reservas/booker.
2. **Valeria → datos estructurados:** ¿GHL Conversation AI entrega el viaje ya estructurado (pickup, destino, teléfono) o seguimos necesitando NLP? TL_07 hoy usa **Claude** para extraer destino del texto de la conversación. Si Valeria lo entrega estructurado, TL_07 se simplifica muchísimo (sin Claude).
3. **Supabase existente:** hay una BD Supabase con `pool_activo` + `dispatchers` (round-robin de despachadores). Definir si integramos o reemplazamos.
4. **job→contact mapping:** los flujos guardan el `contactId` de GHL en el key-value store de TaxiCaller (`company/{id}/store/key/job_{job_id}`) para ligar el job de vuelta al cliente. Podemos mantener ese patrón o usar nuestro Redis.

## Mapa de flujos

### Per-evento (cost drivers — prioridad de ahorro)
| Flujo | Trigger | Sistemas | Complejidad | Destino en la app |
|---|---|---|---|---|
| **TL_07_CrearViaje** (5531575) | webhook (texto o GPS) → crea viaje | GHL, TaxiCaller booker, Google Maps, Claude | **Alta** | `/api/webhooks/crear-viaje` (ramas gps/texto; NLP quizá lo hace Valeria) |
| **TL_09_Job_Accepted** (5735503) | webhook TaxiCaller (`en_route`) | GHL, TaxiCaller | Baja/Media | `/api/webhooks/job-accepted` (quitar sleep 20s → reintento) |
| **TL_03_ViajeCompletado** (5526276) | webhook TaxiCaller (completado) | GHL | Baja | plegar en `/api/webhooks/taxicaller` (ya recibe delivered) + review request |
| **TL_Auto_Assign_Conversation** (5659410) | webhook GHL (unassigned outbound msg) | GHL | Baja | `/api/webhooks/ghl-assign` (asigna contacto al dispatcher que respondió) |
| **TL_08_Geolocalizacion** (5689430) | webhook GPS | TaxiCaller | Media (**incompleto** en Make) | definir salida con cliente |

### Programados
| Flujo | Cuándo | Sistemas | Complejidad | Destino |
|---|---|---|---|---|
| **TL_01_BriefingMatutino** (5434139) | diario ~mañana | TaxiCaller reports, GHL | Baja | Vercel Cron → briefing WhatsApp |
| **TL_02_LlamadaPerdida** (5491171) | por llamada perdida (RingCentral) | GHL | Baja | `/api/webhooks/missed-call` (search/crea contacto + WhatsApp) |
| **TL_06_Reactivacion** (5493237) | diario 11:00 | GHL | Media | Vercel Cron (arreglar paginación >50 y dedupe; hay ~14k inactive-90d) |
| **Sync Pool → GHL** (5863141) | cada hora | Supabase, GHL | Media (**incompleto**: falta parte GHL) | Vercel Cron (diseñar round-robin GHL) |

### Ya migrado
- **TL_04 SMS→WhatsApp** → `/api/webhooks/taxicaller` (hecho). También el enrutado por canal (`ROUTE_BY_INBOUND_CHANNEL`).

## Plan por fases (propuesto)
- **Fase 0 — Seguridad:** rotar todos los secretos de arriba.
- **Fase 1 — Quick wins de bajo riesgo/alto ahorro:** TL_03, TL_09, TL_Auto_Assign, TL_02 (todos lineales, APIs que ya usamos).
- **Fase 2 — Core de reservas:** TL_07 (depende de la decisión de Valeria/NLP) y TL_08 (definir lógica).
- **Fase 3 — Programados:** TL_01, TL_06, Sync Pool (definir round-robin).

Cada flujo migrado se apaga en Make para dejar de consumir operaciones.
