/**
 * Cliente mínimo de la API de RingCentral para enviar SMS.
 *
 * Auth: OAuth server-to-server. Por defecto usa el grant `client_credentials`
 * con las credenciales de la app (Client ID + Client Secret vía Basic auth). Si
 * se configura `RC_JWT` (JWT credential de la RC Developer Console), se usa el
 * flujo `jwt-bearer` en su lugar.
 *
 * El access token se cachea en memoria del proceso (Fluid Compute reutiliza
 * instancias) hasta ~30s antes de expirar para no pedir uno en cada envío.
 */

const RC_SERVER =
  process.env.RC_SERVER_URL?.replace(/\/+$/, "") ??
  "https://platform.ringcentral.com";

interface CachedToken {
  accessToken: string;
  /** epoch ms en el que deja de ser válido (ya con margen de seguridad). */
  expiresAt: number;
}

let tokenCache: CachedToken | null = null;

/**
 * Obtiene un access token de RingCentral (cacheado en memoria).
 * POST {server}/restapi/oauth/token
 *   Authorization: Basic base64(clientId:clientSecret)
 *   body: grant_type=client_credentials   (o jwt-bearer si hay RC_JWT)
 */
export async function getRingCentralToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.RC_CLIENT_ID;
  const clientSecret = process.env.RC_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("RC_CLIENT_ID / RC_CLIENT_SECRET no configurados");
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const params = new URLSearchParams();
  const jwt = process.env.RC_JWT;
  if (jwt) {
    params.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
    params.set("assertion", jwt);
  } else {
    params.set("grant_type", "client_credentials");
  }

  const res = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RingCentral OAuth falló (${res.status}): ${body}`);
  }

  const data: any = await res.json();
  const accessToken: string = data?.access_token;
  const expiresIn: number = Number(data?.expires_in) || 3600;
  if (!accessToken) throw new Error("RingCentral OAuth: sin access_token");

  // Margen de 30s para no usar un token a punto de expirar.
  tokenCache = {
    accessToken,
    expiresAt: Date.now() + (expiresIn - 30) * 1000,
  };
  return accessToken;
}

/**
 * Envía un SMS vía RingCentral desde `RC_ACCOUNT_PHONE`.
 * POST {server}/restapi/v1.0/account/~/extension/{ext}/sms
 *   body: { from: { phoneNumber }, to: [{ phoneNumber }], text }
 *
 * `ext` = RC_EXTENSION_ID (la extensión DUEÑA del número, ej. la 102 que recibe
 * los SMS del MainCompanyNumber) o `~` (la del JWT) si no se configura. El número
 * `from` debe pertenecer a esa extensión o RC responde 403 MSG-304.
 */
export async function sendRingCentralSms(
  to: string,
  text: string
): Promise<{ ok: boolean; status: number; response: unknown }> {
  const from = process.env.RC_ACCOUNT_PHONE;
  if (!from) throw new Error("RC_ACCOUNT_PHONE no configurado");
  const ext = process.env.RC_EXTENSION_ID ?? "~";

  const token = await getRingCentralToken();

  const res = await fetch(
    `${RC_SERVER}/restapi/v1.0/account/~/extension/${ext}/sms`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        from: { phoneNumber: from },
        to: [{ phoneNumber: to }],
        text,
      }),
      cache: "no-store",
    }
  );

  const response = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, response };
}
