import { NextResponse } from "next/server";
import { aggregateWindow } from "@/lib/kpi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Cron del agregador de KPIs de dispatchers. Recomputa la ventana móvil y
 * persiste los agregados por día.
 *
 * Autorización (cualquiera):
 *   - Header de Vercel Cron: Authorization: Bearer ${CRON_SECRET}.
 *   - Trigger manual para pruebas: ?key=${MONITOR_KEY}.
 */
async function handle(req: Request) {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const keyOk = process.env.MONITOR_KEY && url.searchParams.get("key") === process.env.MONITOR_KEY;
  const cronHeader = req.headers.get("x-vercel-cron");
  if (!cronOk && !keyOk && !cronHeader) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  try {
    const windowDays = Number(url.searchParams.get("days")) || undefined;
    const result = await aggregateWindow(windowDays);
    const ms = Date.now() - started;
    console.log(`[cron/kpis] OK en ${ms}ms:`, JSON.stringify(result));
    return NextResponse.json({ ok: true, ms, ...result });
  } catch (err) {
    console.error("[cron/kpis] error:", err);
    return NextResponse.json(
      { ok: false, error: String((err as Error)?.message ?? err) },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
