/**
 * OAuth de GoHighLevel para la app de Marketplace dueña del Conversation
 * Provider custom. Los llamados que usan `conversationProviderId` (registrar
 * inbound, actualizar estado saliente) DEBEN autenticarse con el token OAuth de
 * ESA app — un Location API Key / Private Integration no tiene acceso al provider
 * (GHL responde 401 CONVERSATIONS_MSG_PROVIDER_NO_ACCESS).
 *
 * Los access tokens de GHL duran 24h; los refresh tokens ~1 año y ROTAN en cada
 * refresh. Persistimos el refresh token (y el access token) en Redis para que
 * sobrevivan entre invocaciones/deployments de Vercel.
 *
 * Bootstrap (una vez): visitar /api/oauth/ghl/callback → autoriza la app en la
 * location → guardamos el refresh token. De ahí en adelante se auto-refresca.
 */
import { redisCmd } from "@/lib/cache";

const GHL_BASE = "https://services.leadconnectorhq.com";
const TOKEN_URL = `${GHL_BASE}/oauth/token`;

const RT_KEY = "ghl:oauth:refresh_token"; // refresh token (rota en cada uso)
const AT_KEY = "ghl:oauth:access_token"; // access token (con TTL)

// Caché en memoria del proceso (Fluid Compute reutiliza instancias) para no
// golpear Redis en cada mensaje.
let memAccess: { token: string; expiresAt: number } | null = null;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  locationId?: string;
  companyId?: string;
  userType?: string;
}

async function postToken(params: URLSearchParams): Promise<TokenResponse> {
  const clientId = process.env.GHL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GHL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GHL_OAUTH_CLIENT_ID / GHL_OAUTH_CLIENT_SECRET no configurados");
  }
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
    cache: "no-store",
  });

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    throw new Error(`GHL OAuth token falló (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data as TokenResponse;
}

/** Guarda los tokens: refresh en Redis (sin TTL) y access en Redis + memoria. */
async function storeTokens(t: TokenResponse): Promise<void> {
  const ttl = Math.max(60, (Number(t.expires_in) || 86399) - 120); // margen 2 min
  await redisCmd(["SET", RT_KEY, t.refresh_token]);
  await redisCmd(["SET", AT_KEY, t.access_token, "EX", ttl]);
  memAccess = { token: t.access_token, expiresAt: Date.now() + ttl * 1000 };
}

/**
 * Intercambia el authorization code por tokens (bootstrap del flujo OAuth) y los
 * persiste. Devuelve la location/company para confirmar en el callback.
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    user_type: "Location",
  });
  const t = await postToken(params);
  await storeTokens(t);
  return t;
}

/** Refresca el access token usando el refresh token guardado (que rota). */
async function refreshAccessToken(): Promise<string> {
  const refresh = (await redisCmd(["GET", RT_KEY])) as string | null;
  if (!refresh) {
    throw new Error(
      "GHL OAuth sin refresh token: autoriza la app una vez en /api/oauth/ghl/callback"
    );
  }
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    user_type: "Location",
  });
  const t = await postToken(params);
  await storeTokens(t);
  return t.access_token;
}

/**
 * Devuelve un access token OAuth válido de la app dueña del provider.
 * Orden: memoria → Redis (access con TTL) → refresh.
 */
export async function getGhlOAuthToken(): Promise<string> {
  if (memAccess && Date.now() < memAccess.expiresAt) return memAccess.token;

  const cached = (await redisCmd(["GET", AT_KEY])) as string | null;
  if (cached) {
    // TTL desconocido aquí; refrescamos en memoria por poco tiempo.
    memAccess = { token: cached, expiresAt: Date.now() + 60_000 };
    return cached;
  }
  return refreshAccessToken();
}

/** ¿Ya está autorizada la app (hay refresh token)? */
export async function ghlOAuthReady(): Promise<boolean> {
  const refresh = (await redisCmd(["GET", RT_KEY])) as string | null;
  return !!refresh;
}
