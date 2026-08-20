import { NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/ghl-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bootstrap del OAuth de la app de Marketplace dueña del Conversation Provider.
 *
 * - GET sin `code`  → redirige a la pantalla de autorización de GHL
 *   (chooselocation). El usuario elige la location y aprueba los scopes.
 * - GET con `code`  → intercambia el code por tokens y los persiste en Redis.
 *   A partir de aquí el token se auto-refresca; no hay que repetir esto salvo
 *   que se revoque la app o se pierda el refresh token.
 *
 * El `redirect_uri` DEBE coincidir exactamente con el registrado en la app de
 * GHL (por defecto esta misma URL en producción; override con
 * GHL_OAUTH_REDIRECT_URI).
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
    new URL("/api/oauth/ghl/callback", new URL(req.url).origin).toString()
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
    const authUrl = new URL("https://marketplace.gohighlevel.com/v2/oauth/chooselocation");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri(req));
    authUrl.searchParams.set("scope", scopes);
    return NextResponse.redirect(authUrl.toString());
  }

  // Con code → intercambiar y guardar.
  try {
    const t = await exchangeCodeForTokens(code, redirectUri(req));
    console.log(`[ghl-oauth] Autorizado. location=${t.locationId} scopes=${t.scope}`);
    return NextResponse.json({
      ok: true,
      message: "GHL OAuth autorizado y tokens guardados. Ya puedes activar GHL_USE_CONVERSATION_PROVIDER=on.",
      locationId: t.locationId ?? null,
      userType: t.userType ?? null,
    });
  } catch (err) {
    console.error("[ghl-oauth] Intercambio de code falló:", err);
    return NextResponse.json(
      { ok: false, error: String((err as Error)?.message ?? err) },
      { status: 500 }
    );
  }
}
