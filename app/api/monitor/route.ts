import { NextResponse } from "next/server";
import { getRecentEvents, getCounters } from "@/lib/events";
import { getMessageStatusCached } from "@/lib/ghl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * API del dashboard de monitoreo. Protegida con MONITOR_KEY (?key=...).
 * Devuelve stats agregadas + eventos recientes, enriqueciendo los más nuevos
 * con el estado de entrega REAL desde GHL (delivered/read/failed).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (!process.env.MONITOR_KEY || key !== process.env.MONITOR_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 300);
  const [events, counters] = await Promise.all([
    getRecentEvents(limit),
    getCounters(),
  ]);

  // Enriquecer los 40 más recientes con estado de entrega real de GHL.
  // Cacheado en Redis: los estados finales no se re-consultan → el auto-refresh
  // del dashboard ya NO golpea la cuota diaria de GHL en cada carga.
  const toEnrich = events.filter((e) => e.messageId).slice(0, 40);
  const statuses = await Promise.all(
    toEnrich.map((e) =>
      getMessageStatusCached(e.messageId!).then((s) => ({ id: e.messageId, ...s }))
    )
  );
  const statusMap = new Map(statuses.map((s) => [s.id, s]));

  const enriched = events.map((e) => {
    const live = e.messageId ? statusMap.get(e.messageId) : undefined;
    return {
      ...e,
      deliveryStatus: live?.status ?? null,
      deliveryError: live?.error ?? null,
    };
  });

  return NextResponse.json({
    stats: computeStats(enriched),
    totals: computeTotals(counters),
    events: enriched,
  });
}

/**
 * Totales acumulados (histórico) + estimación de costo. El costo real está en la
 * facturación de GHL/Twilio; aquí se estima con tarifas configurables por env:
 *   COST_TEMPLATE_USD  (por mensaje de plantilla, default 0.04)
 *   COST_FREETEXT_USD  (por mensaje de texto libre, default 0.01)
 */
function computeTotals(counters: Record<string, number>) {
  const total = counters["total"] ?? 0;
  // Plantillas utility (facturables): envío directo por templateId + envíos vía
  // workflow (el workflow manda una plantilla aprobada).
  const template =
    (counters["ch:ghl-template"] ?? 0) + (counters["ch:ghl-workflow"] ?? 0);
  // Mensajes de servicio (texto libre dentro de 24h): gratis.
  const freetext =
    (counters["ch:ghl-text"] ?? 0) + (counters["ch:meta"] ?? 0);

  const rateTemplate = Number(process.env.COST_TEMPLATE_USD ?? 0.004);
  const rateFreetext = Number(process.env.COST_FREETEXT_USD ?? 0);
  const costTemplate = template * rateTemplate;
  const costFreetext = freetext * rateFreetext;

  const byEvent: Record<string, number> = {};
  for (const [k, v] of Object.entries(counters)) {
    if (k.startsWith("ev:")) byEvent[k.slice(3)] = v;
  }

  return {
    totalSent: total,
    template,
    freetext,
    byEvent,
    cost: {
      rateTemplate,
      rateFreetext,
      costTemplate: round2(costTemplate),
      costFreetext: round2(costFreetext),
      costTotal: round2(costTemplate + costFreetext),
      estimated: true,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeStats(events: any[]) {
  const s = {
    total: events.length,
    byEvent: {} as Record<string, number>,
    byOutcome: {} as Record<string, number>,
    byChannel: {} as Record<string, number>,
    delivered: 0,
    failed: 0,
    failed24h: 0,
    pending: 0,
    noPhone: 0,
    cacheHits: 0,
    enrichedCount: 0,
  };
  for (const e of events) {
    s.byEvent[e.event] = (s.byEvent[e.event] ?? 0) + 1;
    s.byOutcome[e.outcome] = (s.byOutcome[e.outcome] ?? 0) + 1;
    if (e.channel) s.byChannel[e.channel] = (s.byChannel[e.channel] ?? 0) + 1;
    if (e.outcome === "no_phone") s.noPhone++;
    if (e.phoneSource === "cache") s.cacheHits++;
    if (e.deliveryStatus) {
      s.enrichedCount++;
      const st = String(e.deliveryStatus).toLowerCase();
      if (st === "delivered" || st === "read") s.delivered++;
      else if (st === "failed" || st === "undelivered") {
        s.failed++;
        if (e.deliveryError && /24 hours/i.test(e.deliveryError)) s.failed24h++;
      } else s.pending++;
    }
  }
  return s;
}
