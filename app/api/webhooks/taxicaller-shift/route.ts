import { NextResponse } from "next/server";
import { recordShiftEvent, getOnlineDriverCount } from "@/lib/taxicaller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook de TaxiCaller — eventos de TURNO de conductor (Shift started / ended).
 * Mantiene el conteo de "conductores en línea ahora" para el dashboard.
 *
 * Config recomendada en TaxiCaller (Webhooks):
 *   - Event "Shift started" → URL .../api/webhooks/taxicaller-shift?event=start&driver={{ID}}
 *   - Event "Shift ended"   → URL .../api/webhooks/taxicaller-shift?event=end&driver={{ID}}
 * Acepta GET o POST y lee el id/evento del query O del body (robusto a cómo
 * TaxiCaller arme la petición). Loguea todo lo recibido para afinar el parseo.
 */
async function handle(req: Request) {
  const url = new URL(req.url);
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    try {
      const f = await req.formData();
      body = Object.fromEntries(f.entries());
    } catch {
      body = {};
    }
  }
  const query = Object.fromEntries(url.searchParams.entries());
  const all: any = { ...query, ...body };

  console.log("[tc-shift] recibido:", JSON.stringify({ query, body }).slice(0, 700));

  const driverId = String(
    all.driver ?? all.driver_id ?? all.driverId ?? all.driverid ??
    all.user_id ?? all.userId ?? all.uid ?? all.id ??
    (typeof all.driver === "object" ? all.driver?.id : "") ?? ""
  ).trim();

  const evRaw = String(all.event ?? all.type ?? all.status ?? all.action ?? "").toLowerCase();
  const online = /start|begin|login|logon|online|on[_-]?duty|open|available|active/.test(evRaw);
  const offline = /end|finish|stop|logout|logoff|offline|off[_-]?duty|close|unavailable|inactive/.test(evRaw);

  if (driverId && (online || offline)) {
    await recordShiftEvent(driverId, online);
    const count = await getOnlineDriverCount();
    console.log(`[tc-shift] driver ${driverId} → ${online ? "ONLINE" : "OFFLINE"} | en línea=${count}`);
    return NextResponse.json({ ok: true, driverId, online, onlineCount: count });
  }

  console.warn(`[tc-shift] sin driverId o evento no reconocido (driver="${driverId}", ev="${evRaw}")`);
  return NextResponse.json({ ok: true, note: "logged; driverId/evento no reconocido — revisar shape" });
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  // TaxiCaller puede usar GET; si no trae datos, es solo healthcheck.
  const url = new URL(req.url);
  if (![...url.searchParams.keys()].length) {
    return NextResponse.json({ ok: true, endpoint: "taxicaller-shift-webhook" });
  }
  return handle(req);
}
