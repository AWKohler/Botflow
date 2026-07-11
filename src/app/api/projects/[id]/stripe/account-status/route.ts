/**
 * GET /api/projects/[id]/stripe/account-status
 *
 * Retrieves the live readiness of the project's connected Stripe account for
 * the current mode. This is the source of truth for whether onboarding is
 * actually finished — the mere presence of an `acct_…` id (which we get the
 * instant the user returns from OAuth) does NOT mean the account can take
 * payments. Stripe Standard accounts finish KYC/activation on their own
 * dashboard; until they do, charges fail with "No valid payment method types".
 *
 * Returns readiness signals straight off the Account object so the workspace
 * can gate the embedded dashboard and show a "finish activating" banner
 * instead of pretending everything is live.
 *
 * Auth: Clerk session, project owner.
 *
 * Returns: {
 *   ok, connected, accountId, mode,
 *   chargesEnabled, payoutsEnabled, detailsSubmitted, ready,
 *   requirements: { currentlyDue[], pastDue[], disabledReason }
 * }
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { userStripeIdentity } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';
import { canUseStripeConnect } from '@/lib/tier';
import { getStripe, isStripeConfigured, type StripeMode } from '@/lib/stripe';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function GET(
  _req: NextRequest,
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

  const mode: StripeMode = project.stripePaymentMode === 'live' ? 'live' : 'test';
  if (!isStripeConfigured(mode)) {
    return NextResponse.json(
      { ok: false, error: `Stripe keys for ${mode} mode are not configured` },
      { status: 500 },
    );
  }

  const [identity] = await db
    .select()
    .from(userStripeIdentity)
    .where(eq(userStripeIdentity.userId, userId))
    .limit(1);
  const accountId =
    identity && mode === 'live' ? identity.liveAccountId : identity?.testAccountId;

  if (!accountId) {
    return NextResponse.json({
      ok: true,
      connected: false,
      mode,
      accountId: null,
      ready: false,
    });
  }

  const stripe = getStripe(mode);
  try {
    const account = await stripe.accounts.retrieve(accountId);
    const chargesEnabled = Boolean(account.charges_enabled);
    const payoutsEnabled = Boolean(account.payouts_enabled);
    const detailsSubmitted = Boolean(account.details_submitted);
    // "Ready" = the account can actually accept charges. details_submitted on
    // its own can be true while charges are still disabled pending review, so
    // we require both.
    const ready = chargesEnabled && detailsSubmitted;

    return NextResponse.json({
      ok: true,
      connected: true,
      mode,
      accountId,
      chargesEnabled,
      payoutsEnabled,
      detailsSubmitted,
      ready,
      requirements: {
        currentlyDue: account.requirements?.currently_due ?? [],
        pastDue: account.requirements?.past_due ?? [],
        disabledReason: account.requirements?.disabled_reason ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe/account-status] threw:', err);
    return NextResponse.json(
      { ok: false, error: `Stripe accounts.retrieve failed: ${message}` },
      { status: 502 },
    );
  }
}
