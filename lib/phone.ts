/**
 * Normaliza un teléfono a formato E.164 sin el signo "+", que es lo que
 * espera el campo `to` de la Meta WhatsApp Cloud API (p.ej. "14045551234").
 *
 * - Quita todo lo que no sea dígito.
 * - Si quedan 10 dígitos, asume número de EE.UU. y antepone "1".
 * - Si ya viene con código de país, lo deja tal cual.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  // Quita prefijo internacional "00".
  if (digits.startsWith("00")) digits = digits.slice(2);

  // Número US de 10 dígitos → antepone código de país 1.
  if (digits.length === 10) digits = "1" + digits;

  return digits;
}

/** Igual que normalizePhone pero en formato E.164 con "+" (lo que espera GHL). */
export function toE164(raw: string | null | undefined): string | null {
  const digits = normalizePhone(raw);
  return digits ? "+" + digits : null;
}
