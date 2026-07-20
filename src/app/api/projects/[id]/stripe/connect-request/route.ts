/**
 * GET    /api/projects/[id]/stripe/connect-request — returns the project's
 *                                                    current pending Stripe
 *                                                    Connect request (or null).
 *                                                    Workspace UI polls this.
 * DELETE /api/projects/[id]/stripe/connect-request — flips pending → dismissed
 *                                                    so the agent's polling
 *                                                    loop wakes up and resolves.
 *
 * Mirrors the oauth-provider-status / setup-oauth-provider DELETE pattern.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, eq, desc } from 'drizzle-orm';
import { getDb } from '@/db';
import { stripeConnectRequests } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';
import { isAgentWaiting, MODAL_STALE_AFTER_MS } from '@/lib/agent/modal-wait';

export const runtime = 'nodejs';

async function loadProjectForCaller(projectId: string, userId: string) {
  const access = await requireProjectAccess(projectId, userId);
  return access?.project ?? null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { id: projectId } = await params;
  if (!(await loadProjectForCaller(projectId, userId))) {
    return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
  }

  const db = getDb();
  const [pending] = await db
    .select({
      id: stripeConnectRequests.id,
      mode: stripeConnectRequests.mode,
      authorizeUrl: stripeConnectRequests.authorizeUrl,
      createdAt: stripeConnectRequests.createdAt,
      updatedAt: stripeConnectRequests.updatedAt,
    })
    .from(stripeConnectRequests)
    .where(
      and(
        eq(stripeConnectRequests.projectId, projectId),
        eq(stripeConnectRequests.status, 'pending'),
      ),
    )
    // Newest pending first — show the request the agent just created, not a
    // stale older one if two ever coexist.
    .orderBy(desc(stripeConnectRequests.createdAt))
    .limit(1);

  // Lazy stale-expiry: agent pollers no longer dismiss rows on timeout, so
  // long-abandoned requests are retired here — never while an agent is
  // actively waiting on them.
  if (
    pending &&
    Date.now() - pending.updatedAt.getTime() > MODAL_STALE_AFTER_MS &&
    !(await isAgentWaiting('stripe-connect', pending.id))
  ) {
    await db
      .update(stripeConnectRequests)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(
        and(
          eq(stripeConnectRequests.id, pending.id),
          eq(stripeConnectRequests.status, 'pending'),
        ),
      );
    return NextResponse.json({ ok: true, pending: null });
  }

  // No pending request: surface a JUST-COMPLETED one so the workspace can
  // fire the late-completion system-note. Stripe's completion happens in a
  // server-side OAuth callback redirect (no modal POST like the OAuth/env-var
  // flows), so this poll is the only place the workspace can observe it. The
  // agentWaiting flag mirrors the other modals: an active agent poller will
  // deliver the result in-band, so the workspace stays quiet; when the agent
  // has stopped waiting (marker cleared by the stopWaiting handshake or
  // expired), the workspace sends the note. The 2-minute window plus a
  // client-side per-request dedupe keeps this once-only.
  let justCompleted: { id: string; agentWaiting: boolean } | null = null;
  if (!pending) {
    const [recent] = await db
      .select({
        id: stripeConnectRequests.id,
        status: stripeConnectRequests.status,
        updatedAt: stripeConnectRequests.updatedAt,
      })
      .from(stripeConnectRequests)
      .where(eq(stripeConnectRequests.projectId, projectId))
      .orderBy(desc(stripeConnectRequests.updatedAt))
      .limit(1);
    if (
      recent &&
      recent.status === 'completed' &&
      Date.now() - recent.updatedAt.getTime() < 2 * 60 * 1000
    ) {
      justCompleted = {
        id: recent.id,
        agentWaiting: await isAgentWaiting('stripe-connect', recent.id),
      };
    }
  }

  return NextResponse.json({
    ok: true,
    pending: pending
      ? {
          id: pending.id,
          mode: pending.mode,
          authorizeUrl: pending.authorizeUrl,
          createdAt: pending.createdAt,
        }
      : null,
    justCompleted,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { id: projectId } = await params;
  if (!(await loadProjectForCaller(projectId, userId))) {
    return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
  }

  const db = getDb();
  await db
    .update(stripeConnectRequests)
    .set({ status: 'dismissed', updatedAt: new Date() })
    .where(
      and(
        eq(stripeConnectRequests.projectId, projectId),
        eq(stripeConnectRequests.status, 'pending'),
      ),
    );

  return NextResponse.json({ ok: true });
}
