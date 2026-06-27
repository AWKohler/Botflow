/**
 * POST /api/projects/[id]/convex/setup-oauth-provider
 *
 * Creates a pending OAuth provider request in the DB. The workspace UI polls
 * oauth-provider-status and surfaces a modal when it sees this record. The
 * agent tool then polls the same status endpoint and blocks until the user
 * completes or dismisses the modal.
 *
 * Any prior pending requests for the same project are cancelled first so
 * there's never more than one active modal.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { projects, oauthProviderRequests } from "@/db/schema";
import { isSupportedOAuthProvider } from "@/lib/oauth-providers/registry";

/**
 * DELETE /api/projects/[id]/convex/setup-oauth-provider
 *
 * Cancels all pending OAuth provider requests for this project.
 * Called by the workspace when the user clicks the Stop (X) button while
 * setupOAuthProvider is executing, so the server-side polling loop terminates
 * within its next poll cycle (~3 seconds) instead of running for 5 minutes.
 */
export async function DELETE(
  _req: NextRequest,
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
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);

    if (!project) {
      return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
    }

    await db
      .update(oauthProviderRequests)
      .set({ status: "dismissed", updatedAt: new Date() })
      .where(
        and(
          eq(oauthProviderRequests.projectId, projectId),
          eq(oauthProviderRequests.status, "pending"),
        ),
      );

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[setup-oauth-provider DELETE] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

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
    const body = (await req.json().catch(() => ({}))) as { provider?: string };
    // Require an explicit provider — don't silently default to a real one, or a
    // malformed call would configure the wrong app's AUTH_* vars.
    const provider = (body.provider ?? "").toLowerCase().trim();
    if (!provider) {
      return NextResponse.json(
        { ok: false, error: "provider is required." },
        { status: 400 },
      );
    }
    if (!isSupportedOAuthProvider(provider)) {
      return NextResponse.json(
        { ok: false, error: `Unsupported OAuth provider: ${provider}.` },
        { status: 400 },
      );
    }

    const db = getDb();
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);

    if (!project) {
      return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
    }
    if (!project.authConfigured) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Auth must be set up before adding OAuth providers. Call setupAuth first.",
        },
        { status: 400 },
      );
    }

    // Derive the .convex.site URL for the modal instructions (stable, never changes)
    const deployUrl = project.userConvexUrl ?? project.convexDeployUrl ?? null;
    const convexSiteUrl = deployUrl
      ? deployUrl.replace(".convex.cloud", ".convex.site")
      : null;

    // Cancel any stale pending requests for this project so there's never a
    // phantom modal showing alongside the new one.
    await db
      .update(oauthProviderRequests)
      .set({ status: "dismissed", updatedAt: new Date() })
      .where(
        and(
          eq(oauthProviderRequests.projectId, projectId),
          eq(oauthProviderRequests.status, "pending"),
        ),
      );

    // Insert the new pending request — the workspace modal appears on next poll.
    const [record] = await db
      .insert(oauthProviderRequests)
      .values({ projectId, userId, provider, status: "pending", convexSiteUrl })
      .returning();

    return NextResponse.json({
      ok: true,
      requestId: record.id,
      provider,
      convexSiteUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[setup-oauth-provider] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
