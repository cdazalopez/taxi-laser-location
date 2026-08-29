import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getCounters, getTripDays } from "@/lib/events";
import { getDays, summarize, shouldRefresh, runAggregation } from "@/lib/kpi";
import { getMissedCalls } from "@/lib/ringcentral";
import { getTaxiCallerSnapshot, shouldRefreshTaxiCaller, refreshTaxiCallerSnapshot } from "@/lib/taxicaller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // el refresco en background puede tardar >2min

/**
 * API del dashboard unificado (KPIs). Protegida con MONITOR_KEY (?key=...).
 *
 * Query:
 *   from, to   YYYY-MM-DD (ET). Default: últimos 7 días.
 *   user       filtra KPIs de dispatchers por userId de GHL.
 *   platform   filtra por sms|whatsapp|call|email|other.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (!process.env.MONITOR_KEY || key !== process.env.MONITOR_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const to = url.searchParams.get("to") || todayET();
  const from = url.searchParams.get("from") || addDays(to, -6);
  const user = url.searchParams.get("user");
  const platform = url.searchParams.get("platform");
  const days = enumerateDays(from, to);

  let [aggs, counters, trips, missed, taxicaller] = await Promise.all([
    getDays(days),
    getCounters(),
    getTripDays(days),
    getMissedCalls(Date.now() - 24 * 3600 * 1000),
    getTaxiCallerSnapshot(),
  ]);

  // Refresco throttled y SIEMPRE en background (la corrida completa tarda ~2min
  // y toca mucho la cuota de GHL): la carga nunca se bloquea; el próximo refresco
  // (auto 60s) ya trae los datos nuevos. El lock por `kpi:lastrun` garantiza una
  // sola corrida por intervalo aunque haya varios usuarios mirando.
  if (await shouldRefresh()) waitUntil(runAggregation());
  // El snapshot de TaxiCaller (viajes vía reports, pesado) también se refresca en
  // background con su propio throttle.
  if (await shouldRefreshTaxiCaller()) waitUntil(refreshTaxiCallerSnapshot());

  const kpis = summarize(aggs, { user, platform });

  // Lista de usuarios presentes en el rango (para el filtro del dashboard).
  const usersMap: Record<string, string> = {};
  for (const a of aggs)
    for (const [uid, u] of Object.entries(a.resp.users)) usersMap[uid] = u.name || uid;
  const users = Object.entries(usersMap).map(([id, name]) => ({ id, name }));

  const tripsTotal = Object.values(trips).reduce((a, b) => a + b, 0);

  return NextResponse.json({
    range: { from, to, days: days.length },
    filters: { user: user || null, platform: platform || null },
    users,
    kpis,
    operational: {
      messages: computeTotals(counters),
      trips: { total: tripsTotal, byDay: trips, today: trips[todayET()] ?? 0 },
      missedCalls: missed,
      savings: computeSavings(counters),
      taxicaller,
    },
  });
}

// ── helpers de fecha (solo strings YYYY-MM-DD, enumeración de calendario) ───
function todayET(): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.KPI_TZ ?? "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date())) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}
function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  for (let i = 0; i < 400 && cur <= to; i++) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/** Totales de mensajes + estimación de costo (igual criterio que /api/monitor). */
function computeTotals(counters: Record<string, number>) {
  const total = counters["total"] ?? 0;
  const template = (counters["ch:ghl-template"] ?? 0) + (counters["ch:ghl-workflow"] ?? 0);
  const freetext =
    (counters["ch:ghl-text"] ?? 0) + (counters["ch:meta"] ?? 0) + (counters["ch:ghl-sms"] ?? 0);
  const rateTemplate = Number(process.env.COST_TEMPLATE_USD ?? 0.004);
  const rateFreetext = Number(process.env.COST_FREETEXT_USD ?? 0);
  const costTotal = round2(template * rateTemplate + freetext * rateFreetext);
  const byEvent: Record<string, number> = {};
  for (const [k, v] of Object.entries(counters)) if (k.startsWith("ev:")) byEvent[k.slice(3)] = v;
  return { totalSent: total, template, freetext, byEvent, costTotal };
}

/**
 * Ahorro acumulado estimado vs. el stack anterior (Twilio + RingCentral +
 * Colbell + Power BI). Se estima como (tarifa_vieja - tarifa_nueva) por mensaje.
 * Configurable con SAVINGS_PER_MSG_USD (default 0.03).
 */
function computeSavings(counters: Record<string, number>) {
  const total = counters["total"] ?? 0;
  const perMsg = Number(process.env.SAVINGS_PER_MSG_USD ?? 0.03);
  return { total: round2(total * perMsg), perMsg, basis: total };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
