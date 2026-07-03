/**
 * POST /api/projects/[id]/stripe/disconnect
 *
 * Disconnects the user's linked Stripe account for a given mode (test/live).
 * Used when someone connected the wrong account and wants to re-link, or just
 * wants to unhook Stripe from a mode.
 *
 * We:
 *   1. OAuth-deauthorize the connected account (best-effort — if Stripe says
 *      it's already deauthorized we proceed anyway).
 *   2. Clear the per-mode account id + publishable key from user_stripe_identity.
 *   3. If the project is currently on the disconnected mode, flip
 *      projects.stripe_enabled off so the workspace re-prompts for connect.
 *
 * Body: { mode: 'test' | 'live' }
 * Auth: Clerk session, project owner.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects, userStripeIdentity } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';
import { canUseStripeConnect } from '@/lib/tier';
import { getConnectClientId, getStripe, type StripeMode } from '@/lib/stripe';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 20;

interface RequestBody {
  mode?: 'test' | 'live';
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!STRIPE_CONNECT_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Stripe Connect is not enabled on this deployment.' },
      { status: 404 },
    );
  }

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id: projectId } = await params;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }
  const mode: StripeMode = body.mode === 'live' ? 'live' : 'test';

  const db = getDb();
  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
  }
  const project = access.project;

  const gate = await canUseStripeConnect(userId);
  if (!gate.allowed) {
    return NextResponse.json({ ok: false, error: gate.reason }, { status: 402 });
  }

  const [identity] = await db
    .select()
    .from(userStripeIdentity)
    .where(eq(userStripeIdentity.userId, userId))
    .limit(1);
  const accountId =
    identity && mode === 'live' ? identity.liveAccountId : identity?.testAccountId;

  if (!accountId) {
    return NextResponse.json(
      { ok: false, error: `No Stripe account is linked for ${mode} mode.` },
      { status: 412 },
    );
  }

  // Best-effort OAuth deauthorize. If Stripe reports the account is already
  // deauthorized (or the connection no longer exists), we still want to clear
  // our local record, so we swallow that specific error.
  try {
    const stripe = getStripe(mode);
    await stripe.oauth.deauthorize({
      client_id: getConnectClientId(mode),
      stripe_user_id: accountId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Stripe throws if the account was already disconnected — treat as success.
    if (!/deauthorized|does not have access|no such/i.test(message)) {
      console.error('[stripe/disconnect] deauthorize failed:', err);
      return NextResponse.json(
        { ok: false, error: `Stripe deauthorize failed: ${message}` },
        { status: 502 },
      );
    }
  }

  const now = new Date();
  const accountField = mode === 'live' ? 'liveAccountId' : 'testAccountId';
  const pkField = mode === 'live' ? 'livePublishableKey' : 'testPublishableKey';
  await db
    .update(userStripeIdentity)
    .set({ [accountField]: null, [pkField]: null, updatedAt: now })
    .where(eq(userStripeIdentity.userId, userId));

  // If this project is currently on the disconnected mode, turn Stripe off so
  // the workspace stops showing the tab and re-prompts for a fresh connect.
  if (project.stripePaymentMode === mode) {
    await db
      .update(projects)
      .set({ stripeEnabled: false, updatedAt: now })
      .where(eq(projects.id, projectId));
  }

  return NextResponse.json({ ok: true, mode, disconnected: accountId });
}
