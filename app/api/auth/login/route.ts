import { NextResponse } from "next/server";
import { getUser, verifyPassword, issueToken } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Login por usuario/contraseña → token de sesión firmado. */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");
  if (!username || !password) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  const user = await getUser(username);
  if (!user || !verifyPassword(password, user.hash)) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const token = issueToken(user.username, user.name, user.role);
  return NextResponse.json({ token, name: user.name, role: user.role });
}
