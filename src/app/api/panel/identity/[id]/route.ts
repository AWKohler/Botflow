import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePanelAdmin } from "@/lib/panel/auth";
import { getIdentityUser, updateIdentityMetadata } from "@/lib/auth/directory";
import { getIdentityDb } from "@/lib/auth/database";
import { requireSameOrigin, ownerIds } from "@/lib/auth/policy";
import { invalidateCredentialsCache } from "@/lib/user-credentials";
import { handlePlanChange } from "@/lib/billing/plan-change";
import { getUserTier } from "@/lib/tier";
import { getAuth } from "@/lib/auth/config";
import { getSubscription } from "@/lib/billing/entitlements";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const actor = await requirePanelAdmin();
  if (!actor) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await context.params;
  const user = await getIdentityUser(id, true);
  const [sessions, accounts, audit, subscription] = await Promise.all([
    getIdentityDb().query(
      'SELECT id,"createdAt","expiresAt","ipAddress","userAgent","impersonatedBy" FROM identity_session WHERE "userId"=$1 AND "expiresAt">now() ORDER BY "createdAt" DESC',
      [id],
    ),
    getIdentityDb().query(
      'SELECT id,"providerId","accountId",scope FROM identity_account WHERE "userId"=$1',
      [id],
    ),
    getIdentityDb().query(
      "SELECT actor_id,action,details,created_at FROM identity_audit WHERE target_id=$1 ORDER BY id DESC LIMIT 50",
      [id],
    ),
    getSubscription(id),
  ]);
  // No credential values or session tokens in this response.
  const privateFields = Object.entries(user.privateMetadata).map(
    ([key, value]) => ({
      key,
      configured: value !== null && value !== undefined && value !== "",
    }),
  );
  return NextResponse.json(
    {
      user: { ...user, privateMetadata: undefined },
      privateFields,
      sessions: sessions.rows,
      accounts: accounts.rows,
      audit: audit.rows,
      subscription,
      isOwner: ownerIds().includes(id),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
const patch = z
  .object({
    publicMetadata: z.record(z.unknown()).optional(),
    privateMetadata: z.record(z.unknown()).optional(),
    unsafeMetadata: z.record(z.unknown()).optional(),
  })
  .strict();
export async function PATCH(request: Request, context: Context) {
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
      { error: "Sign out and sign in again before editing user data." },
      { status: 403 },
    );
  const { id } = await context.params;
  const body = patch.safeParse(await request.json().catch(() => null));
  if (!body.success || JSON.stringify(body.data).length > 65536)
    return NextResponse.json(
      { error: "Invalid metadata (maximum 64 KB)" },
      { status: 400 },
    );
  await getIdentityDb().query(
    "INSERT INTO identity_audit (actor_id,target_id,action,details) VALUES ($1,$2,$3,$4)",
    [
      actor,
      id,
      "metadata.update.requested",
      JSON.stringify({
        publicKeys: Object.keys(body.data.publicMetadata ?? {}),
        privateKeys: Object.keys(body.data.privateMetadata ?? {}),
        unsafeKeys: Object.keys(body.data.unsafeMetadata ?? {}),
      }),
    ],
  );
  await updateIdentityMetadata(
    id,
    body.data,
    body.data.publicMetadata !== undefined,
  );
  await invalidateCredentialsCache(id);
  await handlePlanChange(id, await getUserTier(id));
  return NextResponse.json({ ok: true });
}
