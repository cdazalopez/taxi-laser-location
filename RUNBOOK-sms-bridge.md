# Runbook — Puente SMS RingCentral ↔ GoHighLevel

Guía operativa para diagnosticar y reparar el puente de SMS cuando **los
dispatchers dejan de recibir/responder mensajes en GHL**. Complementa a
[`WEBHOOK_RINGCENTRAL.md`](./WEBHOOK_RINGCENTRAL.md) (arquitectura y setup); este
doc es el "qué hacer cuando se rompe".

> **TL;DR de la arquitectura:** Cliente ↔ RingCentral (`+14045968232`) ↔ GHL
> (location `FmXJ8J0Ccird2AKk8pzQ`) vía un **Conversation Provider custom**
> ("RingCentral SMS"). Entrante: `POST /api/webhooks/ringcentral-sms` → registra
> en GHL con `type:"Custom"` + `conversationProviderId` usando un **token OAuth de
> location**. Saliente: `POST /api/webhooks/ghl-outbound` (firma Ed25519) → envía
> por RingCentral. El token OAuth vive en **Redis (Upstash)**.

---

## Incidente 2026-08-24 (postmortem)

**Síntoma reportado:** los dispatchers no recibían los SMS en GHL.

**Causa raíz: fueron TRES fallas encadenadas, no una.**

### 1. Redis (Upstash) agotó su cuota
- El Redis (integración Vercel `upstash-kv-blue-branch`, vars `KV_REST_API_*`)
  llegó al tope del plan **Free**: `ERR max requests limit exceeded. Limit: 500000`.
- Ese Redis guarda **el token OAuth de GHL** *y* el cache de TaxiCaller/WhatsApp
  → por eso se consumió rápido.
- **Fix:** subir Upstash a **Pay-as-you-go** (consola de Upstash, vía el store en
  Vercel → *Open in Upstash* → cambiar plan). ~$0.20/100K comandos, sin tope.

### 2. El refresh token de GHL quedó inválido (daño colateral de #1)
- El refresh token de GHL **rota en cada uso**. Durante el corte de cuota, GHL
  rotó el token pero el `SET` del valor nuevo a Redis **falló** → quedó guardado
  uno viejo → `invalid_grant: "This refresh token is invalid"`.
- Subir el plan **no** arregla esto solo: hay que **re-autorizar** la app.
- **Fix:** re-autorización OAuth (ver "Cómo re-autorizar" abajo).

### 3. El reinstall desregistró el Conversation Provider
- Para re-autorizar tuvimos que desinstalar/reinstalar la app. **Reinstalar
  DESREGISTRA el provider como canal SMS de la sub-cuenta**: los inbound siguen
  entrando (postean 201 al `providerId`) pero se muestran como "SMS" genérico y
  "RingCentral" desaparece del selector de respuesta.
- **Fix:** en la **sub-cuenta** (no agencia) → **Settings → Phone Numbers →
  Advanced Settings → SMS Provider → seleccionar "RingCentral SMS" → Save**.

**Detalle importante:** el handler entrante responde `200` aunque el POST a GHL
falle (usa `waitUntil`) → **RingCentral no reintenta** → los SMS que fallan se
pierden sin dejar rastro en el tab. Por eso un fallo silencioso se ve como
"dispatchers sin mensajes".

---

## Playbook de diagnóstico

Los `vercel env pull` salen **redactados** en el entorno de Claude → diagnosticar
contra producción con logs.

```bash
# 1. ¿Los endpoints están vivos? (deben dar 200 + {"ok":true})
curl -s https://taxilaser.neuralpreneur.com/api/webhooks/ringcentral-sms
curl -s https://taxilaser.neuralpreneur.com/api/webhooks/ghl-outbound

# 2. Logs de producción (OJO: duplica cada record → de-dup por campo "id")
vercel logs <deployment-url-prod> --json > /tmp/logs.txt

# 3. Buscar los síntomas clave en los logs:
grep -c "max requests limit exceeded" /tmp/logs.txt      # → cuota de Redis
grep -c "refresh token is invalid"   /tmp/logs.txt       # → token OAuth muerto
grep    "SMS entrante registrado en GHL" /tmp/logs.txt   # → éxito inbound
grep    "PROVIDER_NO_ACCESS"         /tmp/logs.txt       # → token sin acceso al provider

# 4. Inyectar un inbound de prueba (el webhook NO valida firma):
curl -s -X POST https://taxilaser.neuralpreneur.com/api/webhooks/ringcentral-sms \
  -H "Content-Type: application/json" \
  -d '{"body":{"from":{"phoneNumber":"+15555550123"},"subject":"[PRUEBA]","direction":"Inbound"}}'
# Luego revisar logs: debe salir "SMS entrante registrado en GHL".

# 5. Diagnóstico de RingCentral (suscripción, número, message-store):
#    (requiere RC_CLIENT_ID/SECRET/JWT — redactados en el entorno de Claude;
#     correr localmente con las credenciales reales)
node scripts/diagnose-rc-webhook.mjs
```

Para leer el `client_id` real de GHL sin secretos (está en el redirect):
```bash
curl -s -D - -o /dev/null https://taxilaser.neuralpreneur.com/oauth/callback | grep -i "^location:"
```

---

## Si los dispatchers dejan de recibir SMS — checklist en orden

1. **Endpoints vivos** (`curl` healthchecks → 200). Si no → problema de deploy /
   alias del dominio (`vercel alias set <deployment> taxilaser.neuralpreneur.com`).
2. **¿Cuota de Redis?** `grep "max requests limit exceeded"`. → Subir/confirmar
   plan Upstash Pay-as-you-go.
3. **¿Token OAuth muerto?** `grep "refresh token is invalid"` / `"PROVIDER_NO_ACCESS"`.
   → **Re-autorizar** (abajo). *Ojo: arreglar Redis ANTES de re-autorizar, si no
   el token nuevo tampoco se guarda.*
4. **¿Inbound entra pero se ve como "SMS" y no hay "RingCentral" al responder?**
   → El provider se desregistró (típico tras reinstall). Re-seleccionar el SMS
   Provider en la sub-cuenta (paso en Incidente #3).
5. **¿RingCentral no entrega?** (no llegan POST al webhook) → revisar la
   suscripción RC con `scripts/diagnose-rc-webhook.mjs`; debe estar atada a la
   **ext 102** (`62611342007`), la que recibe los SMS.

---

## Cómo re-autorizar la app GHL (cuando el refresh token muere)

**Pre-requisito:** Redis debe estar aceptando escrituras (plan OK), si no el token
nuevo tampoco persiste.

La app tiene **DOS client keys** (misma app):
- `6a8676513ef7bce3fba0a357-mt1jvzlg` — la que usa el botón **Install** del Marketplace.
- `6a8676513ef7bce3fba0a357-mt23xoqs` — la que tiene su secret en Vercel
  (`GHL_OAUTH_CLIENT_ID`/`GHL_OAUTH_CLIENT_SECRET`). **Usar siempre esta.**

Pasos:
1. En **incógnito**, logueado en la sub-cuenta **Taxi Laser**, abrir:
   ```
   https://marketplace.leadconnectorhq.com/oauth/chooselocation?response_type=code&redirect_uri=https%3A%2F%2Ftaxilaser.neuralpreneur.com%2Foauth%2Fcallback&client_id=6a8676513ef7bce3fba0a357-mt23xoqs&scope=conversations%2Fmessage.write+conversations%2Fmessage.readonly+conversations.write+conversations.readonly+contacts.write+contacts.readonly&loginWindowOpenMode=self
   ```
2. Si la app está instalada rebota a la página del Marketplace; si está
   desinstalada muestra "Install". **En ambos casos hay que darle click a
   Install/Authorize hasta el final** — el code sale bajo `-mt23xoqs` porque la
   URL lo lleva. Seleccionar la **sub-cuenta Taxi Laser** (no "Agency").
3. Aterrizas en `/oauth/callback` con **`{ "ok": true, ... }`**. Listo, el token
   fresco quedó en Redis.
4. Tras reinstalar, **re-registrar el provider**: sub-cuenta → **Settings → Phone
   Numbers → Advanced Settings → SMS Provider → "RingCentral SMS" → Save**.

**Errores comunes al re-autorizar:**
- `401 "Authorization code not found"` en el exchange → el code salió bajo la key
  equivocada (`-mt1jvzlg`, del botón Install del catálogo). Entrar por el link de
  arriba (`-mt23xoqs`), no por el botón "Install" de la página de detalle del app.
- Rebota a la página del Marketplace sin mostrar consentimiento → app ya
  instalada; igual hay que completar el "Install" desde el link `-mt23xoqs`.
- El token vuelve `userType:"Company", locationId:null` → se autorizó a nivel
  **agencia**; el código igual deriva el location token y funciona, pero el menú
  de SMS Provider de la sub-cuenta puede no listar el provider hasta que la app
  esté instalada **en esa sub-cuenta**.

**Gotchas de GHL:**
- URL de authorize: `marketplace.leadconnectorhq.com/oauth/chooselocation` (GHL
  redirige a `marketplace.gohighlevel.com/v2/oauth/chooselocation`). NO llevar `/v2/`
  a mano.
- El checkbox **"Always show this Conversation Provider"** (Dashboard app →
  Advanced Settings → Conversation Provider) da el tab/icono propio en la lista.
  Aun marcado + provider como SMS Provider, GHL puede pintar el icono de la lista
  como "SMS" genérico → es **cosmético**, la respuesta igual sale por RC.
- Redirect URLs de GHL no aceptan `ghl`/`highlevel`/`leadconnector` en la ruta →
  por eso el callback vive en `/oauth/callback`.

---

## Hardening aplicado (2026-08-24)

Para que la falla #2 no se repita, `lib/ghl-oauth.ts` ahora **serializa el refresh
del token con un lock en Redis** (`ghl:oauth:refresh_lock`, `SET NX EX 30`): solo
una invocación refresca el token rotativo; las concurrentes esperan (~4s) y
releen el access token nuevo, en vez de rotar el refresh token en paralelo y
matarlo. Ver `refreshBaseToken()`.

---

## Housekeeping / pendientes conocidos

- Contactos de prueba a borrar en GHL: `+15555550123`, `+15555559988`.
- `GHL_TOKEN` estático se usa para lookup/upsert de contactos y TaxiCaller; el
  **provider** exige el token OAuth (no `GHL_TOKEN`).
- Deploy es por **Vercel CLI** (`vercel --prod`), no por git; el alias del dominio
  a veces hay que re-apuntarlo (`vercel alias set <deployment> taxilaser.neuralpreneur.com`).
