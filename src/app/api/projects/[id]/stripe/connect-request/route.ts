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
import {
  isAgentWaiting,
  wasResultDelivered,
  claimCompletionNote,
  markCompletionNoteServed,
  wasCompletionNoteServed,
  MODAL_STALE_AFTER_MS,
} from '@/lib/agent/modal-wait';

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
  // flows), so this poll is the only place the workspace can observe it.
  // Suppression, in order:
  //   • delivered flag — an agent poller (or finalized stopWaiting) already
  //     returned the result in-band; never re-announce it.
  //   • served flag — a workspace tab dispatched the note and ACKed (POST
  //     below); the note is retired for good.
  //   • agentWaiting marker — a poller is active right now and will deliver.
  //   • short-TTL NX claim — dampens concurrent tabs to one serve per 30s;
  //     if the serving tab dies before dispatching, the claim expires and
  //     the note re-serves. The 60-min window means an idle or hidden
  //     workspace still gets it on its next active poll.
  let justCompleted: { id: string } | null = null;
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
      Date.now() - recent.updatedAt.getTime() < 60 * 60 * 1000 &&
      !(await wasResultDelivered('stripe-connect', recent.id)) &&
      !(await wasCompletionNoteServed('stripe-connect', recent.id)) &&
      !(await isAgentWaiting('stripe-connect', recent.id)) &&
      (await claimCompletionNote('stripe-connect', recent.id))
    ) {
      justCompleted = { id: recent.id };
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

/**
 * POST — phase-2 ack from the workspace: it dispatched the late-completion
 * system-note for this request, so retire the note durably. Body:
 *   { ackCompletedNote: string }   // request id from GET's justCompleted
 */
export async function POST(
  req: NextRequest,
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

  const body = (await req.json().catch(() => null)) as
    | { ackCompletedNote?: string }
    | null;
  const requestId = body?.ackCompletedNote;
  if (typeof requestId !== 'string' || !requestId) {
    return NextResponse.json({ ok: false, error: 'ackCompletedNote is required' }, { status: 400 });
  }

  // Scope the ack to a request that actually belongs to this project.
  const db = getDb();
  const [row] = await db
    .select({ id: stripeConnectRequests.id })
    .from(stripeConnectRequests)
    .where(
      and(
        eq(stripeConnectRequests.id, requestId),
        eq(stripeConnectRequests.projectId, projectId),
      ),
    )
    .limit(1);
  if (row) {
    await markCompletionNoteServed('stripe-connect', requestId);
  }
  return NextResponse.json({ ok: true });
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
