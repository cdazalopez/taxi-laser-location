/**
 * OAuth de GoHighLevel para la app de Marketplace dueña del Conversation
 * Provider custom. Los llamados que usan `conversationProviderId` (registrar
 * inbound, actualizar estado saliente) DEBEN autenticarse con un token con
 * acceso a la LOCATION — un Location API Key / Private Integration no tiene
 * acceso al provider (401 CONVERSATIONS_MSG_PROVIDER_NO_ACCESS).
 *
 * Flujo de tokens:
 *   - Bootstrap: /oauth/callback intercambia el authorization code → guarda el
 *     refresh token (rota) + access token base en Redis. El token base puede ser
 *     de Company (agencia) o de Location según cómo se autorizó.
 *   - Para los llamados del provider usamos un token de LOCATION. Si el token
 *     base ya es de la location objetivo, se usa tal cual; si es de Company, se
 *     deriva un location token vía POST /oauth/locationToken (companyId+locationId).
 *
 * Access tokens ~24h; refresh ~1 año (rota). Todo persiste en Redis (Upstash)
 * para sobrevivir entre invocaciones/deployments de Vercel.
 */
import { redisCmd } from "@/lib/cache";

const GHL_BASE = "https://services.leadconnectorhq.com";
const TOKEN_URL = `${GHL_BASE}/oauth/token`;
const LOCATION_TOKEN_URL = `${GHL_BASE}/oauth/locationToken`;

const RT_KEY = "ghl:oauth:refresh_token"; // refresh token (rota en cada uso)
const AT_KEY = "ghl:oauth:access_token"; // access token base (con TTL)
const META_KEY = "ghl:oauth:meta"; // { userType, companyId, locationId }
const LT_KEY = "ghl:oauth:location_token"; // location access token derivado (TTL)

const TARGET_LOCATION_ID = process.env.GHL_LOCATION_ID ?? "FmXJ8J0Ccird2AKk8pzQ";

// Cachés en memoria del proceso (Fluid Compute reutiliza instancias).
let memBase: { token: string; expiresAt: number } | null = null;
let memLoc: { token: string; expiresAt: number } | null = null;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
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
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
    cache: "no-store",
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    throw new Error(`GHL OAuth token falló (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data as TokenResponse;
}

/** Persiste refresh (sin TTL), access base (con TTL) y metadata. */
async function storeBaseTokens(t: TokenResponse): Promise<void> {
  const ttl = Math.max(60, (Number(t.expires_in) || 86399) - 120);
  if (t.refresh_token) await redisCmd(["SET", RT_KEY, t.refresh_token]);
  await redisCmd(["SET", AT_KEY, t.access_token, "EX", ttl]);
  await redisCmd([
    "SET",
    META_KEY,
    JSON.stringify({ userType: t.userType ?? null, companyId: t.companyId ?? null, locationId: t.locationId ?? null }),
  ]);
  memBase = { token: t.access_token, expiresAt: Date.now() + ttl * 1000 };
  // Un token base nuevo invalida el location token derivado.
  memLoc = null;
  await redisCmd(["DEL", LT_KEY]);
}

/** Intercambia el authorization code por tokens (bootstrap) y los persiste. */
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
  await storeBaseTokens(t);
  return t;
}

/** Refresca el access token base usando el refresh token guardado (que rota). */
async function refreshBaseToken(): Promise<string> {
  const refresh = (await redisCmd(["GET", RT_KEY])) as string | null;
  if (!refresh) {
    throw new Error("GHL OAuth sin refresh token: autoriza la app en /oauth/callback");
  }
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    user_type: "Location",
  });
  const t = await postToken(params);
  await storeBaseTokens(t);
  return t.access_token;
}

/** Token base (Company o Location) válido: memoria → Redis → refresh. */
async function getBaseToken(): Promise<string> {
  if (memBase && Date.now() < memBase.expiresAt) return memBase.token;
  const cached = (await redisCmd(["GET", AT_KEY])) as string | null;
  if (cached) {
    memBase = { token: cached, expiresAt: Date.now() + 60_000 };
    return cached;
  }
  return refreshBaseToken();
}

async function readMeta(): Promise<{ userType: string | null; companyId: string | null; locationId: string | null }> {
  const raw = (await redisCmd(["GET", META_KEY])) as string | null;
  if (!raw) return { userType: null, companyId: null, locationId: null };
  try {
    return JSON.parse(raw);
  } catch {
    return { userType: null, companyId: null, locationId: null };
  }
}

/**
 * Token con acceso a la LOCATION objetivo (para los llamados del provider).
 * - Si el token base ya es de esa location → se usa directo.
 * - Si es de Company → se deriva vía POST /oauth/locationToken.
 */
export async function getGhlLocationToken(): Promise<string> {
  if (memLoc && Date.now() < memLoc.expiresAt) return memLoc.token;
  const cached = (await redisCmd(["GET", LT_KEY])) as string | null;
  if (cached) {
    memLoc = { token: cached, expiresAt: Date.now() + 60_000 };
    return cached;
  }

  let meta = await readMeta();

  // Auto-reparación: si el meta no tiene companyId ni marca de location (p.ej. se
  // autorizó con una versión previa que no guardaba metadata), forzamos un
  // refresh — la respuesta del refresh trae companyId/userType y repuebla el meta.
  const looksLocation = meta.userType === "Location" && meta.locationId === TARGET_LOCATION_ID;
  if (!meta.companyId && !looksLocation) {
    await refreshBaseToken();
    meta = await readMeta();
  }

  const base = await getBaseToken();

  // El token base ya sirve si es de la location objetivo.
  if (meta.userType === "Location" && meta.locationId === TARGET_LOCATION_ID) {
    return base;
  }

  // Derivar un location token desde el token de Company.
  if (!meta.companyId) {
    throw new Error("GHL OAuth: token base sin companyId; re-autoriza en /oauth/callback");
  }
  const params = new URLSearchParams({ companyId: meta.companyId, locationId: TARGET_LOCATION_ID });
  const res = await fetch(LOCATION_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${base}`,
      Version: "2021-07-28",
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
    cache: "no-store",
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    throw new Error(`GHL locationToken falló (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  const ttl = Math.max(60, (Number(data.expires_in) || 86399) - 120);
  await redisCmd(["SET", LT_KEY, data.access_token, "EX", ttl]);
  memLoc = { token: data.access_token, expiresAt: Date.now() + ttl * 1000 };
  return data.access_token;
}

/** ¿Ya está autorizada la app (hay refresh token)? */
export async function ghlOAuthReady(): Promise<boolean> {
  const refresh = (await redisCmd(["GET", RT_KEY])) as string | null;
  return !!refresh;
}
