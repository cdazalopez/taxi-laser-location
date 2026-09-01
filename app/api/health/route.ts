import { NextResponse } from "next/server";
import { healthSnapshot, sendTestAlert } from "@/lib/health";
import { authFromRequest } from "@/lib/auth";
import { inboundQueueLen } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Estado de salud del sistema (auto-prevención). Sin clave devuelve un OK básico
 * (sirve para monitores de uptime); con clave (MONITOR_KEY o token) devuelve el
 * detalle: circuito GHL abierto/cerrado y 429/min.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const authed = !!authFromRequest(req);

  // Disparador de prueba de alertas (solo con clave): ?test=alert
  if (authed && url.searchParams.get("test") === "alert") {
    const res = await sendTestAlert();
    return NextResponse.json({ ok: true, testAlert: res });
  }

  const snap = await healthSnapshot();

  const degraded = snap.circuitOpen || snap.deliveryFailLastMin >= snap.deliveryFailThreshold;
  const status = degraded ? "degraded" : "ok";
  if (!authed) {
    // Respuesta pública mínima (200 siempre; los problemas son transitorios y auto-recuperan).
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
    delivery: {
      failuresLastMin: snap.deliveryFailLastMin,
      threshold: snap.deliveryFailThreshold,
    },
    inboundQueue: await inboundQueueLen(),
    note: snap.circuitOpen
      ? "Circuito GHL ABIERTO: load-shedding activo (KPIs pausados, notificaciones por SMS de respaldo). Auto-recupera."
      : degraded
        ? "Tasa de fallos de entrega elevada — revisar GHL/RingCentral."
        : "Todo normal.",
  });
}
