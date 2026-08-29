import { NextResponse } from "next/server";
import { authFromRequest, createUser, deleteUser, listUsers } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Gestión de usuarios del dashboard. Solo admin (MONITOR_KEY o token admin). */
function requireAdmin(req: Request) {
  const ctx = authFromRequest(req);
  return ctx?.admin ? ctx : null;
}

export async function GET(req: Request) {
  if (!requireAdmin(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ users: await listUsers() });
}

export async function POST(req: Request) {
  if (!requireAdmin(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");
  const name = String(body?.name ?? username).trim();
  const role = body?.role === "admin" ? "admin" : "viewer";
  if (!username || !password) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  await createUser(username, password, name, role);
  return NextResponse.json({ ok: true, username: username.toLowerCase(), name, role });
}

export async function DELETE(req: Request) {
  if (!requireAdmin(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const username = new URL(req.url).searchParams.get("username");
  if (!username) return NextResponse.json({ error: "missing_username" }, { status: 400 });
  await deleteUser(username);
  return NextResponse.json({ ok: true });
}
