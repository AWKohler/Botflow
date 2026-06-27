/**
 * POST /api/projects/[id]/stripe/subscription-status
 *
 * Pull-based reconcile so a paying customer is recognized WITHOUT depending on
 * webhook delivery. The scaffolded `reconcileSubscription` action calls this
 * (with the project secret) right after Checkout returns and on app load.
 *
 * We use the platform master key + Stripe-Account header to read the truth
 * directly from Stripe for the connected account in the project's current
 * mode, then return a canonical event in the SAME shape the webhook forwarder
 * emits — so billing.ts handles it identically (no duplicate tier logic).
 *
 * Body: { sessionId? } (Checkout Session id) or { subscriptionId? }.
 * Returns: { ok, active, status, event } where `event` is null if nothing
 * was found, or { type, id, data:{ subscriptionId, customerId, status,
 * priceId, metadata } } for a subscription (or a payment.succeeded event for a
 * paid one-time session).
 */
import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { authProjectSecret } from '@/lib/stripe-proxy-auth';
import { getStripe } from '@/lib/stripe';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface RequestBody {
  sessionId?: string;
  subscriptionId?: string;
}

function canonicalFromSubscription(sub: Stripe.Subscription) {
  const status = sub.status;
  const active = status === 'active' || status === 'trialing';
  const type = active
    ? 'subscription.activated'
    : status === 'canceled'
      ? 'subscription.canceled'
      : 'subscription.updated';
  return {
    active,
    status,
    event: {
      type,
      id: `reconcile_${sub.id}`,
      data: {
        subscriptionId: sub.id,
        customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null,
        status,
        // Mirror the webhook shape so the app-load reconcile path can render
        // "cancels on …" identically to the async webhook path.
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        cancelAt: sub.cancel_at ?? null,
        priceId: sub.items.data[0]?.price?.id ?? null,
        metadata: sub.metadata ?? {},
      },
    },
  };
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
  const { id: projectId } = await params;

  const auth = await authProjectSecret({
    projectId,
    headerSecret: req.headers.get('x-botflow-project-secret'),
  });
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    body = {};
  }
  const { sessionId, subscriptionId } = body;
  if (!sessionId && !subscriptionId) {
    return NextResponse.json(
      { ok: false, error: 'sessionId or subscriptionId is required' },
      { status: 400 },
    );
  }

  const stripe = getStripe(auth.mode);
  try {
    if (subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId, {
        stripeAccount: auth.accountId,
      });
      return NextResponse.json({ ok: true, ...canonicalFromSubscription(sub) });
    }

    // sessionId path
    const session = await stripe.checkout.sessions.retrieve(
      sessionId as string,
      { expand: ['subscription'] },
      { stripeAccount: auth.accountId },
    );

    if (session.subscription) {
      const sub =
        typeof session.subscription === 'string'
          ? await stripe.subscriptions.retrieve(session.subscription, {
              stripeAccount: auth.accountId,
            })
          : (session.subscription as Stripe.Subscription);
      return NextResponse.json({ ok: true, ...canonicalFromSubscription(sub) });
    }

    // One-time payment session that's paid → payment.succeeded canonical.
    if (session.mode === 'payment' && session.payment_status === 'paid') {
      return NextResponse.json({
        ok: true,
        active: true,
        status: 'paid',
        event: {
          type: 'payment.succeeded',
          id: `reconcile_${session.id}`,
          data: {
            sessionId: session.id,
            amountTotal: session.amount_total ?? null,
            currency: session.currency ?? null,
            customerEmail: session.customer_details?.email ?? null,
            metadata: session.metadata ?? {},
          },
        },
      });
    }

    // Nothing actionable yet (e.g. unpaid / open session).
    return NextResponse.json({ ok: true, active: false, status: 'none', event: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe/subscription-status] threw:', err);
    return NextResponse.json(
      { ok: false, error: `Failed to read subscription status: ${message}` },
      { status: 502 },
    );
  }
}
