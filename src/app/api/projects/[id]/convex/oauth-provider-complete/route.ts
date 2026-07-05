/**
 * POST /api/projects/[id]/convex/oauth-provider-complete
 *
 * Called by the workspace modal when the user either:
 *   a) saves credentials → maps them to the provider's AUTH_* env vars on the
 *      Convex deployment (signing/deriving as needed) and marks 'completed'.
 *   b) dismisses the modal → marks the request as 'dismissed'.
 *
 * The credentials are set server-side and NEVER returned to the client.
 *
 * Body:
 *   { requestId: string, dismissed?: true }          — dismiss
 *   { requestId: string, fields: { ... } }           — save (per-provider fields)
 *   { requestId, clientId, clientSecret }            — legacy save (still accepted)
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { oauthProviderRequests } from "@/db/schema";
import { requireProjectAccess } from "@/lib/project-access";
import { applyOAuthProvider } from "@/lib/convex-auth-setup";
import { isAgentWaiting } from "@/lib/agent/modal-wait";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const { id: projectId } = await params;
    const body = (await req.json()) as {
      requestId: string;
      dismissed?: boolean;
      fields?: Record<string, string>;
      clientId?: string;
      clientSecret?: string;
    };

    const { requestId, dismissed } = body;
    if (!requestId) {
      return NextResponse.json({ ok: false, error: "requestId is required." }, { status: 400 });
    }

    const db = getDb();

    // Ownership check
    const access = await requireProjectAccess(projectId, userId);

    if (!access) {
      return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
    }

    // Find the pending request
    const [oauthReq] = await db
      .select()
      .from(oauthProviderRequests)
      .where(
        and(
          eq(oauthProviderRequests.id, requestId),
          eq(oauthProviderRequests.projectId, projectId),
          eq(oauthProviderRequests.status, "pending"),
        ),
      )
      .limit(1);

    if (!oauthReq) {
      return NextResponse.json(
        { ok: false, error: "No pending OAuth request found with that ID." },
        { status: 404 },
      );
    }

    if (dismissed) {
      await db
        .update(oauthProviderRequests)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(and(eq(oauthProviderRequests.id, requestId), eq(oauthProviderRequests.status, "pending")));
      return NextResponse.json({ ok: true, status: "dismissed" });
    }

    // The new modal posts { fields }; keep back-compat with the legacy
    // { clientId, clientSecret } shape.
    const fields: Record<string, string> =
      body.fields ??
      (body.clientId !== undefined || body.clientSecret !== undefined
        ? { clientId: body.clientId ?? "", clientSecret: body.clientSecret ?? "" }
        : {});

    if (Object.keys(fields).length === 0) {
      return NextResponse.json(
        { ok: false, error: "Credentials are required." },
        { status: 400 },
      );
    }

    // Atomically CLAIM the request (pending → "completing") BEFORE the side
    // effect, so a concurrent dismiss/timeout can't win mid-apply and make the
    // agent observe a transient 'dismissed'. Only one of submit/dismiss can move
    // it out of 'pending'. The agent pollers treat any non-terminal status
    // (including 'completing') as keep-waiting, so they never see a transient.
    const [claimed] = await db
      .update(oauthProviderRequests)
      .set({ status: "completing", updatedAt: new Date() })
      .where(and(eq(oauthProviderRequests.id, requestId), eq(oauthProviderRequests.status, "pending")))
      .returning({ id: oauthProviderRequests.id });
    if (!claimed) {
      // A dismiss already won, or it's already resolved — don't apply.
      return NextResponse.json(
        { ok: false, error: "This request is no longer pending (it was dismissed or already completed)." },
        { status: 409 },
      );
    }

    // Map fields → env vars and apply server-side. Per-provider required-field
    // validation happens inside applyOAuthProvider; surface its message as a 400.
    try {
      await applyOAuthProvider(projectId, oauthReq.provider, fields);
    } catch (e) {
      // Revert to pending so the user can retry (the modal is still watched).
      await db
        .update(oauthProviderRequests)
        .set({ status: "pending", updatedAt: new Date() })
        .where(eq(oauthProviderRequests.id, requestId))
        .catch(() => undefined);
      const msg = e instanceof Error ? e.message : "Failed to save credentials.";
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }

    // Side effect durable → finalize. (We hold the claim, so this can't be raced.)
    await db
      .update(oauthProviderRequests)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(oauthProviderRequests.id, requestId));

    // Tell the modal whether an agent poller is still actively waiting on this
    // request. If not (the agent gave up and moved on), the workspace sends a
    // system-note so the agent learns the credentials arrived.
    const agentWaiting = await isAgentWaiting("oauth-provider", requestId);

    return NextResponse.json({
      ok: true,
      status: "completed",
      provider: oauthReq.provider,
      agentWaiting,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[oauth-provider-complete] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
