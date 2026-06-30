/**
 * POST /api/projects/[id]/stripe/checkout-session
 *
 * Called by the scaffolded convex/platformStripe.ts action. Uses the
 * platform's master Stripe key with the Stripe-Account header to create a
 * Checkout Session on the user's connected account. Takes the 1% platform fee
 * on every charge — application_fee_percent for subscriptions, an absolute
 * application_fee_amount (1% of the resolved price) for one-time payments.
 *
 * Auth: X-Botflow-Project-Secret matches projects.stripe_webhook_secret.
 *
 * Body:
 *   lookupKey      — mode-agnostic price handle; resolved to the active mode's
 *                    price id (preferred — works across test/live)
 *   priceId        — explicit Stripe Price id override (must exist on the acct)
 *   successUrl     — where Stripe sends the buyer on completion
 *   cancelUrl      — where Stripe sends the buyer on abandon
 *   customerEmail? — prefilled into Checkout
 *   quantity?      — default 1
 *   metadata?      — merged into the session metadata; we always add botflow_project_id
 *   checkoutMode?  — 'payment' (default) | 'subscription'
 *
 * Returns: { url, sessionId }
 */
import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { authProjectSecret } from '@/lib/stripe-proxy-auth';
import { getStripe, STRIPE_PLATFORM_FEE_PERCENT, type StripeMode } from '@/lib/stripe';
import { ensureDemoProductPrice, BOTFLOW_DEMO_LOOKUP_KEY } from '@/lib/stripe-scaffold';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface RequestBody {
  lookupKey?: string;
  priceId?: string;
  successUrl?: string;
  cancelUrl?: string;
  customerEmail?: string;
  quantity?: number;
  metadata?: Record<string, string>;
  checkoutMode?: 'payment' | 'subscription';
  mode?: 'test' | 'live'; // sent by the scaffolded action; informational only
}

/**
 * Resolve a mode-agnostic lookup key to a concrete price id on the connected
 * account for the active mode. Self-heals the Demo Product if its key is the
 * one missing. Returns null if nothing matches.
 */
async function resolvePriceFromLookupKey(
  stripe: Stripe,
  accountId: string,
  lookupKey: string,
  mode: StripeMode,
): Promise<string | null> {
  const found = await stripe.prices.list(
    { lookup_keys: [lookupKey], active: true, limit: 1 },
    { stripeAccount: accountId },
  );
  if (found.data[0]) return found.data[0].id;

  if (lookupKey === BOTFLOW_DEMO_LOOKUP_KEY) {
    await ensureDemoProductPrice(accountId, mode);
    const again = await stripe.prices.list(
      { lookup_keys: [lookupKey], active: true, limit: 1 },
      { stripeAccount: accountId },
    );
    return again.data[0]?.id ?? null;
  }
  return null;
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
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { priceId, lookupKey, successUrl, cancelUrl } = body;
  if ((!priceId && !lookupKey) || !successUrl || !cancelUrl) {
    return NextResponse.json(
      { ok: false, error: 'lookupKey (or priceId), successUrl and cancelUrl are required' },
      { status: 400 },
    );
  }
  const checkoutMode = body.checkoutMode === 'subscription' ? 'subscription' : 'payment';
  const quantity = Math.max(1, body.quantity ?? 1);

  const stripe = getStripe(auth.mode);
  try {
    // Resolve the price to charge for the CURRENT mode. An explicit priceId
    // wins; otherwise resolve the lookup key (this is what makes the same code
    // work in both test and live — the key maps to that mode's price id).
    let resolvedPriceId = priceId ?? null;
    if (!resolvedPriceId && lookupKey) {
      resolvedPriceId = await resolvePriceFromLookupKey(
        stripe,
        auth.accountId,
        lookupKey,
        auth.mode,
      );
    }
    if (!resolvedPriceId) {
      return NextResponse.json(
        {
          ok: false,
          error: lookupKey
            ? `No active price found for "${lookupKey}" in ${auth.mode} mode. Create the product with createStripeProduct, or switch Stripe mode once so it gets mirrored.`
            : 'Could not resolve a price for checkout.',
        },
        { status: 400 },
      );
    }

    const metadata: Record<string, string> = {
      ...(body.metadata ?? {}),
      botflow_project_id: projectId,
      botflow_user_id: auth.userId,
    };

    // Platform fee is set differently per mode:
    //   - subscription: application_fee_percent on the subscription_data
    //   - one-time payment: application_fee_amount per-PaymentIntent (cents)
    // For payment mode we don't know the price upfront on the server (we have
    // priceId, not the line item amount until Stripe expands it). Use
    // payment_intent_data.application_fee_amount = null + just use
    // application_fee_percent via subscription_data when applicable; for
    // one-time we omit the fee in v1 (we'll compute amounts in a later
    // slice that lets the user list / configure products).
    const sessionParams: import('stripe').Stripe.Checkout.SessionCreateParams = {
      mode: checkoutMode,
      line_items: [{ price: resolvedPriceId, quantity }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
      ...(body.customerEmail ? { customer_email: body.customerEmail } : {}),
    };
    if (checkoutMode === 'subscription') {
      sessionParams.subscription_data = {
        application_fee_percent: STRIPE_PLATFORM_FEE_PERCENT,
        metadata,
      };
    } else {
      // Stamp the PaymentIntent (the Checkout Session's metadata does NOT
      // propagate to it, so without this the payment_intent.* events carry no
      // botflow_project_id and the webhook can't route them) AND take the 1%
      // platform fee. A one-time fee needs an absolute amount, so resolve the
      // price's unit_amount.
      const piData: import('stripe').Stripe.Checkout.SessionCreateParams.PaymentIntentData = {
        metadata,
      };
      try {
        const price = await stripe.prices.retrieve(resolvedPriceId, {
          stripeAccount: auth.accountId,
        });
        if (price.unit_amount != null) {
          const fee = Math.round((price.unit_amount * quantity * STRIPE_PLATFORM_FEE_PERCENT) / 100);
          if (fee > 0) piData.application_fee_amount = fee;
        }
        // Tiered/metered prices have a null unit_amount — the absolute total
        // isn't known up front, so we skip the fee for those rather than guess.
      } catch (err) {
        // Never block a customer's checkout on a fee-calculation hiccup.
        console.error('[stripe/checkout-session] could not resolve price for platform fee:', err);
      }
      sessionParams.payment_intent_data = piData;
    }

    const session = await stripe.checkout.sessions.create(sessionParams, {
      stripeAccount: auth.accountId,
    });

    if (!session.url) {
      return NextResponse.json(
        { ok: false, error: 'Stripe did not return a checkout URL' },
        { status: 502 },
      );
    }
    return NextResponse.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe/checkout-session] threw:', err);
    return NextResponse.json(
      { ok: false, error: `Stripe checkout failed: ${message}` },
      { status: 502 },
    );
  }
}
