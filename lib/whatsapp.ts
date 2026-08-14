const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION ?? "v20.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "627390057115822";

/**
 * Envía un mensaje de texto libre por la Meta WhatsApp Cloud API.
 *
 * ⚠️ Nota importante: los mensajes de texto libre solo se entregan si el
 * usuario escribió al negocio en las últimas 24h (ventana de servicio).
 * Para notificaciones iniciadas por el negocio (llegada del taxi, etc.) fuera
 * de esa ventana, Meta exige una PLANTILLA aprobada. Ver sendWhatsAppTemplate.
 */
export async function sendWhatsAppText(
  to: string,
  body: string
): Promise<{ ok: boolean; status: number; response: unknown }> {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error("WHATSAPP_TOKEN no configurado");

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    }),
  });

  const response = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, response };
}

/**
 * Envía una plantilla aprobada de WhatsApp. Úsalo para notificaciones fuera de
 * la ventana de 24h. `components` mapea los parámetros {{1}}, {{2}}... de la
 * plantilla en el orden que espera Meta.
 */
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[]
): Promise<{ ok: boolean; status: number; response: unknown }> {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error("WHATSAPP_TOKEN no configurado");

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components: bodyParams.length
          ? [
              {
                type: "body",
                parameters: bodyParams.map((text) => ({ type: "text", text })),
              },
            ]
          : [],
      },
    }),
  });

  const response = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, response };
}
