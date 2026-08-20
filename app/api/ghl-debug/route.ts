import { NextResponse } from "next/server";
import { getGhlLocationToken } from "@/lib/ghl-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Diagnóstico temporal: prueba empírica de la Add Inbound Message API contra un
 * contacto de prueba, variando `type` y con/sin conversationProviderId, para ver
 * qué combinación acepta GHL. Protegido con ?key=GHL_DEBUG_KEY.
 */
const GHL_BASE = "https://services.leadconnectorhq.com";
const LOC = process.env.GHL_LOCATION_ID ?? "FmXJ8J0Ccird2AKk8pzQ";
const PROVIDER = process.env.GHL_CONVERSATION_PROVIDER_ID ?? "";
const TEST_PHONE = "+15005550006"; // número de prueba obviamente falso

async function ghl(token: string, path: string, method: string, body?: any) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  if (!process.env.GHL_DEBUG_KEY || key !== process.env.GHL_DEBUG_KEY) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const out: any = { providerId: PROVIDER, locationId: LOC };
  try {
    const token = await getGhlLocationToken();

    // 1. Upsert de un contacto de prueba.
    const up = await ghl(token, "/contacts/upsert", "POST", {
      locationId: LOC,
      phone: TEST_PHONE,
      firstName: "RC Bridge",
      lastName: "Diag",
    });
    const contactId = up.body?.contact?.id ?? up.body?.id ?? null;
    out.upsert = { status: up.status, contactId };
    if (!contactId) return NextResponse.json(out);

    // 2. Probar variantes de la Add Inbound Message API (parar en la 1ª que sirva).
    const variants = [
      { label: "SMS + providerId", body: { type: "SMS", contactId, message: "diag", direction: "inbound", conversationProviderId: PROVIDER } },
      { label: "SMS sin providerId", body: { type: "SMS", contactId, message: "diag", direction: "inbound" } },
      { label: "Custom + providerId", body: { type: "Custom", contactId, message: "diag", direction: "inbound", conversationProviderId: PROVIDER } },
      { label: "Live_Chat + providerId", body: { type: "Live_Chat", contactId, message: "diag", direction: "inbound", conversationProviderId: PROVIDER } },
    ];
    out.attempts = [];
    for (const v of variants) {
      const r = await ghl(token, "/conversations/messages/inbound", "POST", v.body);
      out.attempts.push({ label: v.label, status: r.status, body: r.body });
      if (r.status >= 200 && r.status < 300) {
        out.accepted = v.label;
        break;
      }
    }
  } catch (e) {
    out.error = String((e as Error)?.message ?? e);
  }
  return NextResponse.json(out);
}
