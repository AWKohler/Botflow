import { NextResponse } from "next/server";
import { requirePanelAdmin } from "@/lib/panel/auth";
import { getIdentityDb } from "@/lib/auth/database";
export async function GET(request: Request) {
  if (!(await requirePanelAdmin()))
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const search = new URL(request.url).searchParams;
  const query = (search.get("q") ?? "").slice(0, 100);
  const parsed = Number(search.get("offset") || 0);
  const offset = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  const params = [`%${query.replace(/[\\%_]/g, "\\$&")}%`];
  const where = "(u.email ILIKE $1 OR u.name ILIKE $1 OR u.id ILIKE $1)";
  const [users, count] = await Promise.all([
    getIdentityDb().query(
      `SELECT u.id,u.name,u.email,u.image,u.banned,u."createdAt",u."emailVerified",p.public_metadata,p.last_sign_in_at,s.plan,s.status,s.amount,s.interval FROM identity_user u LEFT JOIN identity_profile p ON p.user_id=u.id LEFT JOIN botflow_subscription s ON s.user_id=u.id WHERE ${where} ORDER BY u."createdAt" DESC LIMIT 50 OFFSET $2`,
      [...params, offset],
    ),
    getIdentityDb().query(
      `SELECT count(*) FROM identity_user u WHERE ${where}`,
      params,
    ),
  ]);
  return NextResponse.json(
    { users: users.rows, total: Number(count.rows[0].count), offset },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
