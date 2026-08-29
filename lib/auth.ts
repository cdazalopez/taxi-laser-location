import crypto from "node:crypto";
import { redisCmd } from "@/lib/cache";

/**
 * Auth ligera para el dashboard: usuarios en Redis (password con scrypt) y
 * tokens de sesión firmados con HMAC (sin cookies ni DB). La MONITOR_KEY sigue
 * siendo un acceso admin de respaldo.
 */

const USER_KEY = (u: string) => `dash:user:${u.toLowerCase().trim()}`;
const USER_SET = "dash:users";
const SESSION_TTL_S = Number(process.env.DASH_SESSION_TTL_SEC ?? 60 * 60 * 24 * 30); // 30 días

function secret(): string {
  return process.env.SESSION_SECRET || process.env.MONITOR_KEY || "dev-secret-change-me";
}

export type Role = "admin" | "viewer";
export interface DashUser {
  username: string;
  name: string;
  role: Role;
  hash: string;
}

// ── Password (scrypt) ──────────────────────────────────────────────────────
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [algo, salt, hash] = (stored ?? "").split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 32).toString("hex");
  const a = Buffer.from(test);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── CRUD de usuarios (Redis) ───────────────────────────────────────────────
export async function createUser(
  username: string, password: string, name: string, role: Role = "viewer"
): Promise<void> {
  const u = username.toLowerCase().trim();
  if (!u) throw new Error("username vacío");
  const rec: DashUser = { username: u, name: name || u, role, hash: hashPassword(password) };
  await redisCmd(["SET", USER_KEY(u), JSON.stringify(rec)]);
  await redisCmd(["SADD", USER_SET, u]);
}
export async function getUser(username: string): Promise<DashUser | null> {
  const raw = await redisCmd(["GET", USER_KEY(username)]);
  return typeof raw === "string" && raw ? (JSON.parse(raw) as DashUser) : null;
}
export async function deleteUser(username: string): Promise<void> {
  const u = username.toLowerCase().trim();
  await redisCmd(["DEL", USER_KEY(u)]);
  await redisCmd(["SREM", USER_SET, u]);
}
export async function listUsers(): Promise<Array<{ username: string; name: string; role: Role }>> {
  const members = (await redisCmd(["SMEMBERS", USER_SET])) as string[] | null;
  if (!Array.isArray(members)) return [];
  const out: Array<{ username: string; name: string; role: Role }> = [];
  for (const m of members) {
    const u = await getUser(m);
    if (u) out.push({ username: u.username, name: u.name, role: u.role });
  }
  return out.sort((a, b) => a.username.localeCompare(b.username));
}

// ── Tokens de sesión (HMAC) ────────────────────────────────────────────────
export function issueToken(username: string, name: string, role: Role): string {
  const payload = { u: username, n: name, r: role, exp: Date.now() + SESSION_TTL_S * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}
export function verifyToken(token: string | null | undefined): { u: string; n: string; r: Role } | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof p.exp !== "number" || Date.now() > p.exp) return null;
    return { u: p.u, n: p.n, r: p.r };
  } catch {
    return null;
  }
}

// ── Autorización desde un Request (token de sesión o MONITOR_KEY admin) ─────
export interface AuthCtx {
  username: string;
  name: string;
  role: Role;
  admin: boolean;
}
export function authFromRequest(req: Request): AuthCtx | null {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (process.env.MONITOR_KEY && key === process.env.MONITOR_KEY) {
    return { username: "admin", name: "Admin", role: "admin", admin: true };
  }
  const bearer =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("token");
  const t = verifyToken(bearer);
  if (t) return { username: t.u, name: t.n, role: t.r, admin: t.r === "admin" };
  return null;
}
