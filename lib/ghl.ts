const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? "FmXJ8J0Ccird2AKk8pzQ";

export interface GhlContact {
  id: string;
  phone: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * Busca un contacto en GoHighLevel por teléfono.
 * GET /contacts/?locationId={loc}&query={phone}
 * Devuelve el primer contacto encontrado, o null.
 */
export async function findGhlContactByPhone(
  phone: string
): Promise<GhlContact | null> {
  const token = process.env.GHL_TOKEN;
  if (!token) throw new Error("GHL_TOKEN no configurado");

  const url = new URL(`${GHL_BASE}/contacts/`);
  url.searchParams.set("locationId", GHL_LOCATION_ID);
  url.searchParams.set("query", phone);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL búsqueda de contacto falló (${res.status}): ${body}`);
  }

  const data: any = await res.json();
  const contact = data?.contacts?.[0];
  if (!contact) return null;

  return {
    id: contact.id,
    phone: contact.phone ?? null,
    firstName: contact.firstName ?? null,
    lastName: contact.lastName ?? null,
  };
}

/**
 * Crea o actualiza (upsert) un contacto en GHL por teléfono y devuelve su id.
 * Se usa como respaldo cuando la búsqueda no encuentra al pasajero, para
 * garantizar un contactId con el cual enviar el WhatsApp.
 * POST /contacts/upsert  { locationId, phone }
 */
export async function upsertGhlContact(phoneE164: string): Promise<string | null> {
  const token = process.env.GHL_TOKEN;
  if (!token) throw new Error("GHL_TOKEN no configurado");

  const res = await fetch(`${GHL_BASE}/contacts/upsert`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ locationId: GHL_LOCATION_ID, phone: phoneE164 }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL upsert de contacto falló (${res.status}): ${body}`);
  }

  const data: any = await res.json();
  return data?.contact?.id ?? data?.id ?? null;
}

/**
 * Envía un mensaje de WhatsApp a través de GoHighLevel (Conversations API).
 * Es el canal que ya usaba el scenario TL_04 de Make.
 * POST /conversations/messages  { type: "WhatsApp", contactId, message }
 */
export async function sendGhlWhatsApp(
  contactId: string,
  message: string
): Promise<{ ok: boolean; status: number; response: unknown }> {
  const token = process.env.GHL_TOKEN;
  if (!token) throw new Error("GHL_TOKEN no configurado");

  const res = await fetch(`${GHL_BASE}/conversations/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ type: "WhatsApp", contactId, message }),
  });

  const response = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, response };
}
