# CLAUDE.md — Taxi Laser (hub de las 2 apps)

Este chat es el **hub central** para los DOS proyectos de Taxi Laser. Trabajamos
ambos desde aquí (Claude Code puede editar/desplegar cualquiera de las dos
carpetas). Mapa completo: `~/Desktop/TAXI-LASER-MAP.md`.

## Las 2 apps
| App | Carpeta | Qué hace | Repo GitHub | Proyecto Vercel |
|---|---|---|---|---|
| **Mensajería** (este repo) | `~/Desktop/taxi-laser-location` | SMS bridge RC↔GHL, notificaciones TaxiCaller, dashboard KPIs, auth, auto-prevención | `cdazalopez/taxi-laser-location` | `taxi-laser` → **taxilaser.neuralpreneur.com** |
| **Scheduling** | `~/Desktop/taxi-laser-scheduling` | Agendamiento, dispatchers, round-robin, **asignación/reasignación de conversaciones GHL** (+ Supabase) | `cdazalopez/taxi-laser-scheduling` | `taxi-laser-scheduling` |

## ⚠️ Reglas de deploy (críticas — evitar desplegar al proyecto equivocado)
Los deploys son por **Vercel CLI** (NO por git push). SIEMPRE `cd` a la carpeta
correcta + `--scope cdazalopezs-projects`:
```bash
# Mensajería:
cd ~/Desktop/taxi-laser-location && vercel --prod --yes --scope cdazalopezs-projects
# Scheduling:
cd ~/Desktop/taxi-laser-scheduling && vercel --prod --yes --scope cdazalopezs-projects
```
Verificar alias tras deploy: `vercel inspect <dominio> --scope cdazalopezs-projects`.
Ambos repos SÍ tienen remoto en GitHub → commitear y `git push origin main`.

## 🔗 Están ACOPLADAS — comparten infraestructura
- **Misma cuenta/location de GoHighLevel** (`FmXJ8J0Ccird2AKk8pzQ`) → **mismo rate-limit de GHL.** La carga de UNA app puede tumbar a la otra (ej.: el cron de reasignación de *scheduling* saturaba GHL y causaba 429 en *mensajería*). **Siempre considerar el efecto cruzado en GHL.**
- Comparten RingCentral (+14045968232) y, en parte, Supabase.
- Salud en vivo de mensajería: `GET /api/health?key=<MONITOR_KEY>` (circuito GHL, 429/min, cola de entrantes, fallos de entrega).

## Sistema en producción 24/7 con clientes reales
- **No cambiar nada sin aprobación explícita.** Preferir cambios aditivos, reversibles, con kill switch. Verificar `npx tsc --noEmit` limpio ANTES de desplegar (un error de tipos hace fallar el build de Vercel y el alias NO se actualiza → prod queda en el deploy viejo).
- Auto-prevención activa (mensajería): circuit breaker de GHL + fallback a SMS RingCentral + alertas SMS (`ALERT_PHONE`, con tope global anti-flood + kill switch `ALERTS_ENABLED`).

## Docs de referencia (en `taxi-laser-location`)
- `HANDOFF.md` — handoff técnico completo (endpoints, env vars, credenciales, plataformas).
- `PROJECT-LOG.md` — decisiones, incidentes y **errores a evitar**.
- `MIGRATION-make-to-app.md` — migración de flujos de Make.
- `WEBHOOK_RINGCENTRAL.md`, `RUNBOOK-sms-bridge.md`.

## Síntoma → dónde mirar
| Problema | Dónde |
|---|---|
| Notificaciones (llegada/finalizado) no llegan | mensajería `webhooks/taxicaller` + `/api/health` (¿circuito abierto?) |
| SMS entrante/saliente RC | mensajería `webhooks/ringcentral-sms`, `webhooks/ghl-outbound` |
| Conversaciones se mueven/cierran/desaparecen de "asignadas a mí" | **scheduling** `api/cron/reassign` + `api/ghl/assign` |
| Tormentas de 429 de GHL | carga combinada de AMBAS apps; revisar reasignación (scheduling) + `/api/health` |
| Dashboard KPIs congelados | esperado (`KPI_DISABLED=on`); rediseño por eventos pendiente |
