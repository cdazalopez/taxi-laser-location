const CONTACT = "404-596-8232";

export type TaxiEvent =
  | "waiting_for_passenger"
  | "job_marked_as_delivered"
  | "cancelled_by_company";

export interface MessageData {
  vehicle_make?: string | null;
  vehicle_color?: string | null;
  vehicle_plate?: string | null;
  fare?: string | number | null;
}

/**
 * Construye el texto del mensaje de WhatsApp según el evento del scenario TL_04.
 * Devuelve null si el evento no está soportado (no se envía nada).
 */
export function buildMessage(
  event: string,
  data: MessageData
): string | null {
  const make = (data.vehicle_make ?? "").toString().trim();
  const color = (data.vehicle_color ?? "").toString().trim();
  const plate = (data.vehicle_plate ?? "").toString().trim();
  const fare = formatFare(data.fare);

  switch (event) {
    case "waiting_for_passenger":
      return `Su Taxi ${make} ${color} con placa ${plate} ha llegado / ${CONTACT}`;

    case "job_marked_as_delivered":
      return `Su servicio realizado por la unidad ${make} ha finalizado por $${fare} / ${CONTACT}`;

    case "cancelled_by_company":
      return `Su servicio ha sido cancelado, para solicitarlo nuevamente por favor llame o envie un SMS al ${CONTACT}`;

    default:
      return null;
  }
}

export interface TemplateConfig {
  name: string;
  language: string;
  /** Parámetros para {{1}}, {{2}}... del cuerpo, en orden. */
  params: string[];
}

/**
 * Devuelve la plantilla de WhatsApp aprobada en Meta que corresponde al evento,
 * junto con sus parámetros. Los nombres de plantilla y el idioma son
 * configurables por env para no atarlos al código.
 *
 * IMPORTANTE: el cuerpo de la plantilla aprobada en Meta debe coincidir con el
 * texto de `buildMessage`, con las variables como {{1}}, {{2}}...
 */
export function buildTemplate(
  event: string,
  data: MessageData
): TemplateConfig | null {
  const language = process.env.WHATSAPP_TEMPLATE_LANG ?? "es";
  const make = (data.vehicle_make ?? "").toString().trim();
  const color = (data.vehicle_color ?? "").toString().trim();
  const plate = (data.vehicle_plate ?? "").toString().trim();
  const fare = formatFare(data.fare);

  switch (event) {
    case "waiting_for_passenger":
      // Cuerpo: "Su Taxi {{1}} {{2}} con placa {{3}} ha llegado / 404-596-8232"
      return {
        name: process.env.WHATSAPP_TEMPLATE_ARRIVAL ?? "taxi_ha_llegado",
        language,
        params: [make, color, plate],
      };

    case "job_marked_as_delivered":
      // Cuerpo: "Su servicio realizado por la unidad {{1}} ha finalizado por ${{2}} / 404-596-8232"
      return {
        name: process.env.WHATSAPP_TEMPLATE_DELIVERED ?? "servicio_finalizado",
        language,
        params: [make, fare],
      };

    case "cancelled_by_company":
      // Cuerpo estático, sin variables.
      return {
        name: process.env.WHATSAPP_TEMPLATE_CANCELLED ?? "servicio_cancelado",
        language,
        params: [],
      };

    default:
      return null;
  }
}

function formatFare(fare: string | number | null | undefined): string {
  if (fare === null || fare === undefined || fare === "") return "0.00";
  const n = typeof fare === "number" ? fare : parseFloat(String(fare).replace(/[^0-9.]/g, ""));
  if (Number.isNaN(n)) return String(fare);
  return n.toFixed(2);
}
