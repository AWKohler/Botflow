/**
 * POST /api/projects/[id]/stripe/account-session
 *
 * Mints a fresh Connect Account Session for the project's connected account.
 * The Stripe.js Connect loader on the client calls this each time it needs a
 * new client_secret (typically once per mount, refreshed before the ~1 hour
 * expiry).
 *
 * Auth: Clerk session, project owner. (Internal — the workspace itself fetches
 * this, not the user's app sandbox, so we don't gate on stripe_webhook_secret.)
 *
 * Returns: { clientSecret, publishableKey, mode, accountId }
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { userStripeIdentity } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';
import { canUseStripeConnect } from '@/lib/tier';
import { getPublishableKey, getStripe, isStripeConfigured, type StripeMode } from '@/lib/stripe';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function POST(
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

  const access = await requireProjectAccess(projectId, userId, "owner");
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
    return NextResponse.json(
      {
        ok: false,
        status: 'needs-connect',
        error: `No Stripe account is linked for ${mode} mode. Run initializeStripePayments first.`,
      },
      { status: 412 },
    );
  }

  const stripe = getStripe(mode);
  try {
    const session = await stripe.accountSessions.create({
      account: accountId,
      components: {
        // Connected account's payments/transactions ledger + dispute UX.
        payments: {
          enabled: true,
          features: {
            refund_management: true,
            dispute_management: true,
            capture_payments: true,
          },
        },
        // Account management (business details, public info, statement descriptor + bank).
        account_management: {
          enabled: true,
          features: { external_account_collection: true },
        },
        // Embedded onboarding (Stripe-hosted KYC inside our UI).
        account_onboarding: { enabled: true },
        // Balances + payouts.
        balances: {
          enabled: true,
          features: {
            instant_payouts: true,
            standard_payouts: true,
            edit_payout_schedule: true,
          },
        },
        // Inline compliance reminder banner shared across views.
        notification_banner: { enabled: true },
      },
    });

    return NextResponse.json({
      ok: true,
      clientSecret: session.client_secret,
      publishableKey: getPublishableKey(mode),
      mode,
      accountId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe/account-session] threw:', err);
    return NextResponse.json(
      { ok: false, error: `Stripe accountSessions.create failed: ${message}` },
      { status: 502 },
    );
  }
}
