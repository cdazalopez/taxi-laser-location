import { NextResponse } from "next/server";
import { getGhlLocationToken } from "@/lib/ghl-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Diagnóstico temporal: consulta a GHL (con el token OAuth de location) para
 * confirmar el provider real. Protegido con ?key=GHL_DEBUG_KEY.
 */
const GHL_BASE = "https://services.leadconnectorhq.com";
const LOC = process.env.GHL_LOCATION_ID ?? "FmXJ8J0Ccird2AKk8pzQ";
const PROVIDER = process.env.GHL_CONVERSATION_PROVIDER_ID ?? "";

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  if (!process.env.GHL_DEBUG_KEY || key !== process.env.GHL_DEBUG_KEY) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const out: any = { providerId: PROVIDER, locationId: LOC };
  try {
    const token = await getGhlLocationToken();
    out.tokenAcquired = true;

    // 1. Lookup del provider por ID.
    const r = await fetch(`${GHL_BASE}/conversations/providers/${PROVIDER}`, {
      headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
      cache: "no-store",
    });
    out.providerById = { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) {
    out.error = String((e as Error)?.message ?? e);
  }
  return NextResponse.json(out);
}
