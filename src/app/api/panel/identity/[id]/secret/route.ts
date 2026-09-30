import { NextResponse } from "next/server";
import { requirePanelAdmin } from "@/lib/panel/auth";
import { requireSameOrigin } from "@/lib/auth/policy";
import { getAuth } from "@/lib/auth/config";
import { getIdentityUser } from "@/lib/auth/directory";
import { getIdentityDb } from "@/lib/auth/database";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!requireSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const actor = await requirePanelAdmin();
  if (!actor) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (
    !session ||
    Date.now() - new Date(session.session.createdAt).getTime() > 15 * 60 * 1000
  )
    return NextResponse.json(
      { error: "Sign out and sign in again before viewing a secret." },
      { status: 403 },
    );
  const body = await request.json().catch(() => null);
  if (typeof body?.key !== "string")
    return NextResponse.json(
      { error: "A key name is required" },
      { status: 400 },
    );
  const { id } = await params;
  const user = await getIdentityUser(id, true);
  await getIdentityDb().query(
    "INSERT INTO identity_audit (actor_id,target_id,action,details) VALUES ($1,$2,$3,$4)",
    [actor, id, "secret.reveal", JSON.stringify({ key: body.key })],
  );
  return NextResponse.json(
    { value: user.privateMetadata[body.key] ?? null },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
