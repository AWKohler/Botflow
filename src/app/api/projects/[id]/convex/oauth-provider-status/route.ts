/**
 * GET /api/projects/[id]/convex/oauth-provider-status
 *
 * Two usage modes:
 *
 *   ?requestId=<uuid>  — agent polling: returns the status of a specific
 *                        request so the setupOAuthProvider tool can block
 *                        until the user completes or dismisses the modal.
 *
 *   (no params)        — workspace polling: returns the latest pending request
 *                        for this project so the workspace can show the modal.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { oauthProviderRequests } from "@/db/schema";
import { requireProjectAccess } from "@/lib/project-access";
import { isAgentWaiting, MODAL_STALE_AFTER_MS } from "@/lib/agent/modal-wait";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const { id: projectId } = await params;
    const db = getDb();

    // Lightweight ownership check
    const access = await requireProjectAccess(projectId, userId);

    if (!access) {
      return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
    }

    const requestId = req.nextUrl.searchParams.get("requestId");

    if (requestId) {
      // ── Agent polling a specific request ──────────────────────────────
      const [oauthReq] = await db
        .select({ status: oauthProviderRequests.status, provider: oauthProviderRequests.provider })
        .from(oauthProviderRequests)
        .where(
          and(
            eq(oauthProviderRequests.id, requestId),
            eq(oauthProviderRequests.projectId, projectId),
          ),
        )
        .limit(1);

      if (!oauthReq) {
        return NextResponse.json({ ok: true, status: "not_found" });
      }
      return NextResponse.json({ ok: true, status: oauthReq.status, provider: oauthReq.provider });
    } else {
      // ── Workspace polling for any pending request ─────────────────────
      const [pending] = await db
        .select({
          id: oauthProviderRequests.id,
          provider: oauthProviderRequests.provider,
          convexSiteUrl: oauthProviderRequests.convexSiteUrl,
          updatedAt: oauthProviderRequests.updatedAt,
        })
        .from(oauthProviderRequests)
        .where(
          and(
            eq(oauthProviderRequests.projectId, projectId),
            eq(oauthProviderRequests.status, "pending"),
          ),
        )
        .orderBy(desc(oauthProviderRequests.createdAt))
        .limit(1);

      // Lazy stale-expiry: agent pollers no longer dismiss rows on timeout
      // (the modal is meant to survive the agent's wait), so long-abandoned
      // requests are retired here — but never while an agent is actively
      // waiting on them.
      if (
        pending &&
        Date.now() - pending.updatedAt.getTime() > MODAL_STALE_AFTER_MS &&
        !(await isAgentWaiting("oauth-provider", pending.id))
      ) {
        await db
          .update(oauthProviderRequests)
          .set({ status: "dismissed", updatedAt: new Date() })
          .where(
            and(
              eq(oauthProviderRequests.id, pending.id),
              eq(oauthProviderRequests.status, "pending"),
            ),
          );
        return NextResponse.json({ ok: true, pending: null });
      }

      return NextResponse.json({
        ok: true,
        pending: pending
          ? { id: pending.id, provider: pending.provider, convexSiteUrl: pending.convexSiteUrl }
          : null,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[oauth-provider-status] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
