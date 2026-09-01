import { NextResponse } from "next/server";
import { healthSnapshot } from "@/lib/health";
import { authFromRequest } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Estado de salud del sistema (auto-prevención). Sin clave devuelve un OK básico
 * (sirve para monitores de uptime); con clave (MONITOR_KEY o token) devuelve el
 * detalle: circuito GHL abierto/cerrado y 429/min.
 */
export async function GET(req: Request) {
  const snap = await healthSnapshot();
  const authed = !!authFromRequest(req);

  const status = snap.circuitOpen ? "degraded" : "ok";
  if (!authed) {
    // Respuesta pública mínima (200 siempre; el circuito es transitorio y auto-recupera).
    return NextResponse.json({ ok: true, status });
  }
  return NextResponse.json({
    ok: true,
    status,
    ghl: {
      circuitOpen: snap.circuitOpen,
      requests429LastMin: snap.ghl429LastMin,
      requests429PrevMin: snap.ghl429PrevMin,
      threshold: snap.threshold,
    },
    note: snap.circuitOpen
      ? "Circuito GHL ABIERTO: load-shedding activo (KPIs pausados, notificaciones por SMS de respaldo). Auto-recupera."
      : "Todo normal.",
  });
}
