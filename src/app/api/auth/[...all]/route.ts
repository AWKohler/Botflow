import { getAuth } from "@/lib/auth/config";
import { getIdentityDb } from "@/lib/auth/database";
import { ownerIds, requireSameOrigin } from "@/lib/auth/policy";
import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const adminActions = new Set([
  "list-users",
  "get-user",
  "ban-user",
  "unban-user",
  "list-user-sessions",
  "revoke-user-sessions",
  "revoke-user-session",
  "impersonate-user",
  "stop-impersonating",
]);
async function handler(request: Request) {
  const path = new URL(request.url).pathname;
  if (
    /\/(change-password|change-email|unlink-account|link-social|delete-user|request-email-change)(?:\/callback)?$/.test(
      path,
    )
  ) {
    const session = await getAuth().api.getSession({
      headers: request.headers,
    });
    if (session?.session.impersonatedBy)
      return NextResponse.json(
        {
          error:
            "Account security changes are unavailable while impersonating.",
        },
        { status: 403 },
      );
  }
  if (path.includes("/admin/")) {
    const action = path.split("/").pop()!;
    if (!adminActions.has(action))
      return NextResponse.json(
        { error: "Unavailable admin action" },
        { status: 403 },
      );
    const session = await getAuth().api.getSession({
      headers: request.headers,
    });
    if (!session)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const actor = session.session.impersonatedBy;
    const stopping = action === "stop-impersonating";
    if (
      stopping
        ? !actor || !ownerIds().includes(actor)
        : !!actor || !ownerIds().includes(session.user.id)
    )
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (request.method !== "GET") {
      if (!requireSameOrigin(request))
        return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
      if (
        !stopping &&
        Date.now() - new Date(session.session.createdAt).getTime() >
          15 * 60 * 1000
      )
        return NextResponse.json(
          {
            error:
              "Please sign out and sign in again before this admin action.",
          },
          { status: 403 },
        );
    }
    const body =
      request.method === "POST"
        ? ((await request
            .clone()
            .json()
            .catch(() => ({}))) as { userId?: string })
        : {};
    if (
      ["ban-user", "impersonate-user"].includes(action) &&
      body.userId &&
      ownerIds().includes(body.userId)
    )
      return NextResponse.json(
        { error: "Owner accounts cannot be banned or impersonated" },
        { status: 403 },
      );
    // Record intent before the operation. Audit failure must prevent the action.
    await getIdentityDb().query(
      "INSERT INTO identity_audit (actor_id,target_id,action) VALUES ($1,$2,$3)",
      [
        actor || session.user.id,
        body.userId ?? null,
        `admin.${action}.requested`,
      ],
    );
    const response = await getAuth().handler(request);
    await getIdentityDb().query(
      "INSERT INTO identity_audit (actor_id,target_id,action,details) VALUES ($1,$2,$3,$4)",
      [
        actor || session.user.id,
        body.userId ?? null,
        `admin.${action}.finished`,
        JSON.stringify({ status: response.status }),
      ],
    );
    return response;
  }
  return getAuth().handler(request);
}
export const GET = handler;
export const POST = handler;
