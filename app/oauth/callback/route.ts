import { NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/ghl-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bootstrap del OAuth de la app de Marketplace dueña del Conversation Provider.
 *
 * Vive en `/oauth/callback` para coincidir con el Redirect URL DEFAULT de la app
 * en GHL (el mismo que usa el Install link). Ruta neutra (sin referencias a la
 * marca, que GHL rechaza en Redirect URLs).
 *
 * - GET sin `code`  → redirige a la pantalla de autorización de GHL
 *   (chooselocation) usando NUESTRA client key (GHL_OAUTH_CLIENT_ID).
 * - GET con `code`  → intercambia el code por tokens y los persiste en Redis.
 *
 * IMPORTANTE: hay que entrar por ESTA URL (no por el Install link del
 * marketplace), porque el Install link usa otra client key (`-mt1jvzlg`) cuyo
 * secret no tenemos; el intercambio del code debe usar la MISMA client key que
 * inició el flujo (`-mt23xoqs`, la que está en GHL_OAUTH_CLIENT_ID/SECRET).
 */

const DEFAULT_SCOPES = [
  "conversations/message.write",
  "conversations/message.readonly",
  "conversations.write",
  "conversations.readonly",
  "contacts.write",
  "contacts.readonly",
].join(" ");

function redirectUri(req: Request): string {
  return (
    process.env.GHL_OAUTH_REDIRECT_URI ??
    new URL("/oauth/callback", new URL(req.url).origin).toString()
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.json({ ok: false, error, description: url.searchParams.get("error_description") }, { status: 400 });
  }

  // Sin code → mandar a autorizar.
  if (!code) {
    const clientId = process.env.GHL_OAUTH_CLIENT_ID;
    if (!clientId) {
      return NextResponse.json({ ok: false, error: "GHL_OAUTH_CLIENT_ID no configurado" }, { status: 500 });
    }
    const scopes = process.env.GHL_OAUTH_SCOPES ?? DEFAULT_SCOPES;
    const authUrl = new URL("https://marketplace.leadconnectorhq.com/oauth/chooselocation");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri(req));
    authUrl.searchParams.set("scope", scopes);
    return NextResponse.redirect(authUrl.toString());
  }

  // Con code → intercambiar y guardar.
  try {
    const t = await exchangeCodeForTokens(code, redirectUri(req));
    console.log(`[crm-oauth] Autorizado. location=${t.locationId} scopes=${t.scope}`);
    return NextResponse.json({
      ok: true,
      message: "GHL OAuth autorizado y tokens guardados. Ya puedes activar GHL_USE_CONVERSATION_PROVIDER=on.",
      locationId: t.locationId ?? null,
      userType: t.userType ?? null,
    });
  } catch (err) {
    console.error("[crm-oauth] Intercambio de code falló:", err);
    return NextResponse.json(
      { ok: false, error: String((err as Error)?.message ?? err) },
      { status: 500 }
    );
  }
}
