import { NextResponse } from "next/server";
import { reprocessInboundQueue } from "@/lib/inbound-sms";
import { inboundQueueLen } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Respaldo: drena la cola de SMS entrantes fallidos. El reproceso principal es
 * oportunista (al llegar cada SMS nuevo con GHL sano); este cron es la red por
 * si el flujo de SMS se detiene con la cola aún llena.
 * Auth: header de Vercel Cron `x-vercel-cron`, o `?key=MONITOR_KEY`.
 */
async function handle(req: Request) {
  const url = new URL(req.url);
  const keyOk = process.env.MONITOR_KEY && url.searchParams.get("key") === process.env.MONITOR_KEY;
  if (!keyOk && !req.headers.get("x-vercel-cron")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const before = await inboundQueueLen();
  const res = await reprocessInboundQueue(200);
  const after = await inboundQueueLen();
  console.log(`[cron/reprocess-inbound] cola ${before}→${after}, procesados ${res.done}`);
  return NextResponse.json({ ok: true, queueBefore: before, queueAfter: after, ...res });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
