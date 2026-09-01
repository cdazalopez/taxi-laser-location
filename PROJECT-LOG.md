# 📓 Taxi Laser — Bitácora de decisiones y lecciones (para evitar repetir errores)

> Resumen cronológico de lo trabajado, **por qué** se hizo cada cosa, los **incidentes**
> y sus causas raíz, y sobre todo una lista de **errores a NO repetir**. Compañero de
> `HANDOFF.md` (arquitectura/accesos). Última actualización: **2026-09-01**.

---

## ⚠️ ERRORES A EVITAR / LECCIONES CLAVE (lee esto primero)

1. **La cuota/rate-limit de GoHighLevel es el riesgo #1 del proyecto.** Tanto las
   notificaciones a clientes como el registro de SMS entrante hacen **upsert de contacto
   en GHL**. Si GHL empieza a dar **429**, se cae TODO a la vez. → No corras nada que
   **pollee GHL en volumen**.
2. **NO usar polling de GHL para KPIs.** El agregador de KPIs original leía miles de
   conversaciones/mensajes de GHL y **agotó la cuota → tumbó las notificaciones en
   producción** (incidente 2026-08-31). Está apagado (`KPI_DISABLED=on`). Los KPIs se
   deben calcular **por eventos** (capturar cada mensaje cuando pasa, guardarlo en Redis,
   calcular local). Ver roadmap en `HANDOFF.md` §10.
3. **Deploys SIEMPRE con `vercel --prod --yes --scope cdazalopezs-projects`.** Sin
   `--scope` da "Not authorized". Los deploys **no** se disparan por git push.
4. **Verifica `npx tsc --noEmit` LIMPIO antes de desplegar.** Un patrón tipo
   `if tsc; then commit && deploy` puede colar un error de tipos y desplegar igual → el
   build de Vercel falla → el alias NO se actualiza → prod queda en el deploy viejo (te
   crees que desplegaste y no). Tras cada deploy, confirma el alias:
   `vercel inspect taxilaser.neuralpreneur.com --scope cdazalopezs-projects`.
5. **Nunca despliegues desde carpetas viejas.** Existía `~/Desktop/Taxilaser messaging`
   (copia obsoleta de 3 archivos) **linkeada al MISMO proyecto Vercel de producción**;
   desplegar desde ahí habría pisado prod con código viejo. Archivada en
   `~/Desktop/_archive/…` con su `.vercel` desactivado. **Fuente de verdad = este repo.**
6. **Redis (Upstash) es crítico y frágil.** Guarda el **token OAuth de GHL** (refresh
   token **rotativo**), cache y estado. Si Redis falla durante un refresh, el refresh
   token nuevo no se guarda → `invalid_grant` → provider de GHL caído (incidente
   2026-08-24). Mantener Upstash en **pay-as-you-go** (el tier free se agotó). Hay un
   **lock en Redis** alrededor del refresh para evitar carreras.
7. **`ghl-outbound` debe responder rápido (async).** Si espera el envío completo a
   RingCentral antes de responder, GHL **bloquea el campo de escritura** del dispatcher
   (queja real de operadores). Ya está async (responde 200, envía en background).
8. **TaxiCaller `vehicle/list` es PAGINADO** (`offset`+`limit`). Leer solo la página 1
   da un conteo falso (pasó: 39 en vez de 419). Y `active=1` = flota **registrada**, NO
   "en línea ahora". Conductores en línea = **webhooks de turno**, no reportes.
9. **Los reportes de TaxiCaller solo traen sesiones/turnos CERRADOS.** No hay forma de
   sacar "conductores en línea ahora" por reporte → el conteo en vivo viene SOLO de los
   webhooks Shift started/ended; se "siembra" solo en ~1 ciclo de turnos.
10. **GHL custom provider inbound usa `type:"Custom"`** (no "SMS"), + `conversationProviderId`
    (empírico: "SMS"+id → 400; "Custom"+id → 201).
11. **RingCentral:** la suscripción de webhooks debe atarse a la **extensión que RECIBE**
    los SMS (ext 102), no a la del JWT admin. Y **enviar** requiere el JWT de la ext
    **dueña del número** (+14045968232 = ext 102 con feature SmsSender).
12. **Secretos expuestos en Make.com → ROTAR** (ver `HANDOFF.md` §7). No reutilizarlos.
13. **Meta WhatsApp token da 403** ("no permissions") → el fallback a Meta no entrega;
    por eso el fallback ahora es **SMS de RingCentral** (`RC_FALLBACK`).

---

## Cronología de lo trabajado

### Base (sesiones previas)
- Puente **SMS bidireccional RingCentral ↔ GHL** (entrante `ringcentral-sms`, saliente
  `ghl-outbound` con firma Ed25519, provider custom de GHL). Doc: `WEBHOOK_RINGCENTRAL.md`.
- Reemplazo del scenario **TL_04 de Make** por `webhooks/taxicaller` (notificaciones de
  viaje). Doc: `WEBHOOK_TL04.md`.
- **Incidente 2026-08-24:** Upstash free agotado → refresh token de GHL murió →
  dispatchers sin SMS. Fix: Upstash pay-as-you-go + lock de refresh + corrección de la
  URL de authorize de OAuth. Runbook: `RUNBOOK-sms-bridge.md`.

### Sesión reciente (2026-08-28 → 09-01)
1. **Enrutado por canal** (`ROUTE_BY_INBOUND_CHANNEL`): notificaciones salen por SMS o
   WhatsApp según el último canal del cliente. Vía provider de GHL → sin doble envío.
2. **Dashboard de KPIs** (`/dashboard`): KPIs de dispatchers (tiempos de respuesta por
   usuario/plataforma/rango) + tiles operativas. **Login por usuario** (scrypt + tokens).
   Diseño pulido. → Luego se descubrió que el agregador **quemaba la cuota de GHL**.
3. **TaxiCaller cableado:** vehículos (paginado), viajes (reports), conductores con turno
   hoy, y **conductores en línea en vivo** vía webhooks de turno + reconciliación.
4. **Migración de Make:** mapeo completo de los 18 escenarios (`MIGRATION-make-to-app.md`);
   detección de secretos expuestos.
5. **Incidente 429 (2026-08-31):** el agregador de KPIs agotó la cuota de GHL → 429 en
   todo → notificaciones y SMS caídos. **Fix:** `KPI_DISABLED=on`, fallback a RC SMS,
   reintentos 3→1, cache phone→contactId.
6. **`ghl-outbound` async** → desbloquea el compose de GHL (queja de operadores).
7. **Sistema de auto-prevención** (`lib/health.ts`): circuit breaker de GHL + load-shedding
   automático + 4 detecciones (429, OAuth GHL muerto, Redis caído, fallos de entrega) +
   **alertas SMS** a `ALERT_PHONE`. Endpoint `/api/health`.
8. **Orden de carpetas:** archivado del duplicado peligroso + mapa `~/Desktop/TAXI-LASER-MAP.md`.
9. **Handoff:** este doc + `HANDOFF.md`.

---

## Decisiones clave y por qué
- **Notificaciones vía provider de GHL (no `sendRingCentralSms` directo):** para que
  aparezcan en el hilo de GHL (visibilidad del dispatcher) y sin doble envío.
- **KPIs desactivados en vez de "optimizados":** el polling de GHL no es viable a este
  volumen a ningún costo → se rediseña a eventos (no se re-enciende el polling).
- **Fallback a RC SMS (no Meta):** el token de Meta da 403; RC funciona y no toca GHL.
- **Circuit breaker con load-shedding:** que el sistema **suelte carga solo** y se
  recupere sin intervención, y avise por SMS. Prioridad: proteger la mensajería a
  clientes por encima de features internas (KPIs).
- **Conteo de conductores en vivo por webhook:** única fuente real (la API no expone
  online-ahora); se acepta el "seeding" de ~1 ciclo de turnos.

---

## Estado actual (2026-09-01)
- Producción **estable**: notificaciones, SMS bridge, dashboard operativo OK; `/api/health`
  en verde; auto-prevención activa; alertas SMS a 2 números.
- **KPIs de dispatchers apagados** (`KPI_DISABLED=on`) — pendiente rediseño por eventos.
- **GitHub:** este push pone `main` al día con todo el trabajo (antes estaba ~25 commits
  atrás; los deploys iban por Vercel CLI, no por git).

---

## Próximos pasos (orden sugerido)
1. **KPIs por eventos** (desbloquea el dashboard sin riesgo de cuota GHL).
2. **Rotar secretos** expuestos (§7 del handoff).
3. **Migración de flujos de Make** (quick wins primero).
4. Confirmar **discrepancia de entorno/empresa de TaxiCaller** (api vs api-rc).
5. Arreglar **token de Meta** (o descartar Meta como fallback).
