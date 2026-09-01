import { normalizePhone, toE164 } from "@/lib/phone";
import { findGhlContactByPhone, upsertGhlContact, addGhlInboundSms } from "@/lib/ghl";
import { enqueueInboundSms, dequeueInboundSms } from "@/lib/cache";
import { isGhlCircuitOpen } from "@/lib/health";

/**
 * Registro resiliente de SMS entrantes en GHL. Si GHL falla (típicamente 429),
 * el mensaje del cliente se ENCOLA en Redis en vez de perderse, y se reprocesa
 * cuando GHL está sano. Usado por el webhook `ringcentral-sms` y por el cron de
 * respaldo `cron/reprocess-inbound`.
 */

/**
 * Procesa un SMS entrante; si falla el registro, lo encola para reintento. Si
 * tuvo éxito (GHL sano), aprovecha para drenar la cola de pendientes.
 */
export async function handleInbound(rawPhone: string, text: string): Promise<void> {
  let ok = false;
  try {
    ok = await registerInboundSms(rawPhone, text);
  } catch (err) {
    console.error(`[rc-sms] Error procesando SMS de ${rawPhone}:`, err);
  }
  if (!ok) {
    await enqueueInboundSms({ phone: rawPhone, text, ts: Date.now() });
    console.warn(`[rc-sms] SMS de ${rawPhone} ENCOLADO para reintento (GHL no disponible)`);
    return;
  }
  await reprocessInboundQueue(15); // GHL respondió bien → drenar pendientes
}

/**
 * Registra un SMS entrante en GHL. true = registrado; false = reintentar
 * (encolar). NO lanza.
 */
export async function registerInboundSms(rawPhone: string, text: string): Promise<boolean> {
  const normalized = normalizePhone(rawPhone);
  if (!normalized) {
    console.error(`[rc-sms] Teléfono inválido: "${rawPhone}" (se descarta, no reintentable)`);
    return true; // no tiene sentido reintentar → no encolar
  }

  let contactId: string | null = null;
  try {
    const contact =
      (await findGhlContactByPhone(rawPhone)) ??
      (await findGhlContactByPhone(toE164(normalized)!));
    if (contact?.id) contactId = contact.id;
  } catch (err) {
    console.error(`[rc-sms] Búsqueda GHL falló (${normalized}):`, err);
    return false;
  }

  if (!contactId) {
    try {
      contactId = await upsertGhlContact(toE164(normalized)!);
    } catch (err) {
      console.error(`[rc-sms] Upsert GHL falló (${normalized}):`, err);
      return false;
    }
  }
  if (!contactId) {
    console.error(`[rc-sms] Sin contactId (${normalized}) → a cola`);
    return false;
  }

  const res = await addGhlInboundSms(contactId, text);
  if (res.ok) {
    console.log(`[rc-sms] SMS entrante registrado en GHL (contacto ${contactId})`);
    return true;
  }
  console.error(`[rc-sms] Registro de SMS entrante falló (${res.status}) contacto ${contactId} → a cola`);
  return false;
}

/**
 * Reprocesa hasta `limit` SMS entrantes en cola. Se salta si el circuito de GHL
 * está abierto. Los que vuelven a fallar se re-encolan y corta (backpressure).
 */
export async function reprocessInboundQueue(limit = 20): Promise<{ done: number; requeued: number }> {
  let done = 0, requeued = 0;
  if (await isGhlCircuitOpen()) return { done, requeued };
  for (let i = 0; i < limit; i++) {
    const item = await dequeueInboundSms();
    if (!item) break;
    let ok = false;
    try {
      ok = await registerInboundSms(item.phone, item.text);
    } catch {
      ok = false;
    }
    if (ok) {
      done++;
    } else {
      await enqueueInboundSms({ ...item, attempts: (item.attempts ?? 0) + 1 });
      requeued++;
      break;
    }
  }
  if (done) console.log(`[rc-sms] reprocesados ${done} SMS entrantes de la cola`);
  return { done, requeued };
}
