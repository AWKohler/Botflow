/**
 * POST /api/webhooks/stripe
 *
 * Platform-level Stripe Connect webhook receiver. Stripe sends ALL events
 * for all connected accounts here (one endpoint per mode in Stripe dashboard;
 * we verify against whichever secret matches). We then:
 *
 *   1. Verify Stripe-Signature against the configured/managed secrets. The
 *      first one that verifies wins (and tells us the mode).
 *   2. Normalize to canonical types.
 *   3. ROUTE: payment/subscription events go ONLY to the single project that
 *      created them (metadata.botflow_project_id), never broadcast across a
 *      user's other apps that share the same connected account. Account-level
 *      events (account.updated) broadcast to the user's same-mode projects.
 *   4. Record each (event, project) target in the durable stripe_webhook_deliveries
 *      outbox and attempt delivery inline once. Failures are retried by
 *      /api/cron/retry-stripe-deliveries — so a paid event is never lost.
 *
 * We ALWAYS return 200 (once the signature verifies) so the shared platform
 * Connect endpoint is never disabled by one user's down Convex backend. Only a
 * failed signature returns 400 (so Stripe retries a transient platform-side
 * secret misconfig).
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { getDb } from '@/db';
import { projects, stripeWebhookDeliveries, stripeObjectProjectMap, userStripeIdentity } from '@/db/schema';
import { getStripe, type StripeMode } from '@/lib/stripe';
import { getManagedWebhookSecrets } from '@/lib/stripe-webhook-provisioning';
import {
  backoffMs,
  convexSiteUrlFor,
  deliverStripeEventOnce,
  DELIVERY_LEASE_MS,
} from '@/lib/stripe-webhook-delivery';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface CanonicalEvent {
  type:
    | 'subscription.activated'
    | 'subscription.canceled'
    | 'subscription.updated'
    | 'payment.succeeded'
    | 'payment.failed'
    | 'account.updated';
  id: string;
  accountId: string | null;
  mode: StripeMode;
  data: Record<string, unknown>;
}

// account.updated is the only account-level (non-project-scoped) event we emit.
const ACCOUNT_LEVEL_TYPES = new Set<CanonicalEvent['type']>(['account.updated']);

// ─── Signature verification (try each mode's secret) ─────────────────────

function configuredWebhookSecrets(): Array<{ mode: StripeMode; secret: string }> {
  const out: Array<{ mode: StripeMode; secret: string }> = [];
  const test = process.env.STRIPE_WEBHOOK_SECRET_TEST;
  if (test) out.push({ mode: 'test', secret: test });
  const live = process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET;
  if (live) out.push({ mode: 'live', secret: live });
  return out;
}

async function verifyAny(
  rawBody: string,
  signatureHeader: string,
): Promise<{ event: Stripe.Event; mode: StripeMode } | null> {
  // Env-configured secrets first (manual/legacy), then DB-stored secrets from
  // programmatically-provisioned endpoints. The first that verifies wins.
  const secrets = [...configuredWebhookSecrets(), ...(await getManagedWebhookSecrets())];
  for (const { mode, secret } of secrets) {
    try {
      // Pick a Stripe client for constructEvent — any will do; this is local
      // crypto only.
      const stripe = getStripe(mode);
      const event = stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
      return { event, mode };
    } catch {
      // Wrong secret for this mode — try the next.
    }
  }
  return null;
}

// ─── Normalization ────────────────────────────────────────────────────────

function normalize(event: Stripe.Event, mode: StripeMode): CanonicalEvent | null {
  const accountId = event.account ?? null;
  const id = event.id;
  switch (event.type) {
    case 'customer.subscription.created': {
      const sub = event.data.object as Stripe.Subscription;
      // A brand-new sub may be 'trialing' or 'active'. We treat 'active' or
      // 'trialing' as activation; anything else falls through to updated.
      if (sub.status === 'active' || sub.status === 'trialing') {
        return {
          type: 'subscription.activated',
          id,
          accountId,
          mode,
          data: {
            subscriptionId: sub.id,
            customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
            status: sub.status,
            priceId: sub.items.data[0]?.price?.id ?? null,
            metadata: sub.metadata,
          },
        };
      }
      return {
        type: 'subscription.updated',
        id,
        accountId,
        mode,
        data: {
          subscriptionId: sub.id,
          customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
          status: sub.status,
          metadata: sub.metadata,
        },
      };
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      return {
        type: 'subscription.canceled',
        id,
        accountId,
        mode,
        data: {
          subscriptionId: sub.id,
          customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
          metadata: sub.metadata,
        },
      };
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      // Only a TERMINAL status emits canceled. `cancel_at_period_end` means the
      // customer turned off renewal but is still paid through the current period
      // (status stays 'active'/'trialing') — emitting canceled here would revoke
      // their access immediately, before they've actually lost it. Surface it as
      // an update carrying cancelAtPeriodEnd so the app can show "cancels on …"
      // without dropping entitlement early.
      if (sub.status === 'canceled') {
        return {
          type: 'subscription.canceled',
          id,
          accountId,
          mode,
          data: {
            subscriptionId: sub.id,
            customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
            status: sub.status,
            metadata: sub.metadata,
          },
        };
      }
      return {
        type: 'subscription.updated',
        id,
        accountId,
        mode,
        data: {
          subscriptionId: sub.id,
          customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
          status: sub.status,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          // When a cancellation is scheduled, this is the unix timestamp the
          // subscription actually ends — so the app can render "cancels on …"
          // while keeping access until then.
          cancelAt: sub.cancel_at ?? null,
          priceId: sub.items.data[0]?.price?.id ?? null,
          metadata: sub.metadata,
        },
      };
    }
    // NOTE: we intentionally do NOT handle `payment_intent.succeeded`. The app
    // always pays via Checkout, and `checkout.session.completed` is the single
    // canonical "payment done" signal. Handling both would emit TWO distinct
    // `payment.succeeded` events (different Stripe event ids → not deduped) for
    // ONE charge, causing double fulfillment. Subscription-invoice PaymentIntents
    // are conveyed by the subscription.* events instead.
    // `completed` covers immediate (card) payments; `async_payment_succeeded`
    // covers delayed methods (bank debits etc.) that finish unpaid and clear
    // later. For an async payment, `completed` fires first with payment_status
    // != 'paid' (→ null here), and the real success arrives as
    // async_payment_succeeded with payment_status === 'paid' — so exactly one
    // payment.succeeded is emitted per payment.
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status !== 'paid') return null;
      const metadata = (session.metadata ?? {}) as Record<string, string>;
      return {
        type: 'payment.succeeded',
        id,
        accountId,
        mode,
        data: {
          sessionId: session.id,
          paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
          customerId: typeof session.customer === 'string' ? session.customer : null,
          amountTotal: session.amount_total ?? null,
          currency: session.currency ?? null,
          customerEmail: session.customer_details?.email ?? null,
          metadata,
        },
      };
    }
    case 'checkout.session.async_payment_failed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = (session.metadata ?? {}) as Record<string, string>;
      return {
        type: 'payment.failed',
        id,
        accountId,
        mode,
        data: {
          sessionId: session.id,
          paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
          customerId: typeof session.customer === 'string' ? session.customer : null,
          metadata,
        },
      };
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      return {
        type: 'payment.failed',
        id,
        accountId,
        mode,
        data: {
          paymentIntentId: pi.id,
          customerId: typeof pi.customer === 'string' ? pi.customer : null,
          amount: pi.amount,
          currency: pi.currency,
          lastError: pi.last_payment_error?.message ?? null,
          metadata: pi.metadata,
        },
      };
    }
    case 'account.updated': {
      const acct = event.data.object as Stripe.Account;
      return {
        type: 'account.updated',
        id,
        accountId,
        mode,
        data: {
          chargesEnabled: acct.charges_enabled,
          payoutsEnabled: acct.payouts_enabled,
          detailsSubmitted: acct.details_submitted,
          requirementsDisabledReason: acct.requirements?.disabled_reason ?? null,
        },
      };
    }
    default:
      return null;
  }
}

function botflowProjectIdOf(canonical: CanonicalEvent): string | null {
  const md = canonical.data.metadata as Record<string, unknown> | undefined;
  const pid = md?.botflow_project_id;
  return typeof pid === 'string' && pid.length > 0 ? pid : null;
}

/** Stripe object ids on the event we can key a project mapping by (sub/customer). */
function mappableObjectIds(canonical: CanonicalEvent): string[] {
  const out: string[] = [];
  const sub = canonical.data.subscriptionId;
  const cus = canonical.data.customerId;
  if (typeof sub === 'string' && sub) out.push(sub);
  if (typeof cus === 'string' && cus) out.push(cus);
  return out;
}

/**
 * Resolve the single project a payment/subscription event belongs to.
 * Metadata.botflow_project_id is authoritative; on a miss we fall back to the
 * object→project map (populated from earlier metadata-bearing events on the same
 * subscription/customer). Always re-verifies owner + mode + enabled so a stale
 * map row can't misroute. Returns null when it genuinely can't be attributed.
 */
async function resolveOwningProject(
  db: ReturnType<typeof getDb>,
  canonical: CanonicalEvent,
  ownerUserId: string,
): Promise<typeof projects.$inferSelect | null> {
  const verify = async (pid: string) => {
    const [p] = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, pid),
          eq(projects.userId, ownerUserId),
          eq(projects.stripeEnabled, true),
          eq(projects.stripePaymentMode, canonical.mode),
        ),
      )
      .limit(1);
    return p ?? null;
  };

  const metaPid = botflowProjectIdOf(canonical);
  if (metaPid) {
    const p = await verify(metaPid);
    if (p) {
      // Record the mapping so follow-up events that lack metadata still route.
      await rememberObjectMap(db, canonical, p.id);
      return p;
    }
    return null; // metadata names a project that isn't this owner's / mode — drop
  }

  // Metadata absent — try the fallback map (sub id, then customer id).
  for (const objId of mappableObjectIds(canonical)) {
    const [row] = await db
      .select({ projectId: stripeObjectProjectMap.projectId })
      .from(stripeObjectProjectMap)
      .where(
        and(
          eq(stripeObjectProjectMap.mode, canonical.mode),
          eq(stripeObjectProjectMap.objectId, objId),
        ),
      )
      .limit(1);
    if (row) {
      const p = await verify(row.projectId);
      if (p) return p;
    }
  }
  return null;
}

/** Persist (mode, sub/customer id) → project so later metadata-less events route. */
async function rememberObjectMap(
  db: ReturnType<typeof getDb>,
  canonical: CanonicalEvent,
  projectId: string,
): Promise<void> {
  const ids = mappableObjectIds(canonical);
  if (ids.length === 0) return;
  const now = new Date();
  for (const objectId of ids) {
    await db
      .insert(stripeObjectProjectMap)
      .values({ mode: canonical.mode, objectId, projectId, updatedAt: now })
      .onConflictDoUpdate({
        target: [stripeObjectProjectMap.mode, stripeObjectProjectMap.objectId],
        set: { projectId, updatedAt: now },
      });
  }
}

// ─── Durable, routed fan-out ──────────────────────────────────────────────

/** Record a (event, project) target and attempt inline delivery once. */
async function recordAndDeliver(opts: {
  project: typeof projects.$inferSelect;
  eventId: string;
  canonicalType: string;
  mode: StripeMode;
  payload: string;
}): Promise<{ projectId: string; ok: boolean; reason?: string }> {
  const { project, eventId, canonicalType, mode, payload } = opts;
  const db = getDb();

  // Claim this (event, project) target FIRST — before any deliverability check —
  // so a routed event is never dropped just because the project momentarily
  // lacks a webhook secret or Convex backend; the cron retries it once config
  // catches up. onConflictDoNothing makes Stripe's re-delivery idempotent; if we
  // didn't insert, another attempt (or the retry cron) owns it. nextAttemptAt is
  // leased forward so a crash before the terminal update still gets reclaimed.
  const [claimed] = await db
    .insert(stripeWebhookDeliveries)
    .values({
      eventId,
      projectId: project.id,
      canonicalType,
      mode,
      payload,
      status: 'pending',
      nextAttemptAt: new Date(Date.now() + DELIVERY_LEASE_MS),
    })
    .onConflictDoNothing()
    .returning({ id: stripeWebhookDeliveries.id });
  if (!claimed) {
    return { projectId: project.id, ok: true, reason: 'already_claimed' };
  }

  const siteUrl = convexSiteUrlFor(project);
  if (!project.stripeWebhookSecret || !siteUrl) {
    // Can't deliver yet — schedule a retry instead of dropping. The cron reads
    // the CURRENT project secret/site at retry time, so this self-heals once the
    // backend is configured.
    await db
      .update(stripeWebhookDeliveries)
      .set({
        status: 'failed',
        lastError: !project.stripeWebhookSecret ? 'no_secret' : 'no_convex_site',
        nextAttemptAt: new Date(Date.now() + backoffMs(1)),
        updatedAt: new Date(),
      })
      .where(eq(stripeWebhookDeliveries.id, claimed.id));
    return {
      projectId: project.id,
      ok: false,
      reason: !project.stripeWebhookSecret ? 'no_secret' : 'no_convex_site',
    };
  }

  const result = await deliverStripeEventOnce({
    siteUrl,
    secret: project.stripeWebhookSecret,
    payload,
  });
  const nowTs = new Date();
  if (result.ok) {
    await db
      .update(stripeWebhookDeliveries)
      .set({ status: 'delivered', attempts: 1, lastStatus: result.status ?? null, updatedAt: nowTs })
      .where(eq(stripeWebhookDeliveries.id, claimed.id));
    return { projectId: project.id, ok: true };
  }
  console.error('[stripe/webhook] inline delivery failed', project.id, 'status=', result.status, 'err=', result.error);
  await db
    .update(stripeWebhookDeliveries)
    .set({
      status: 'failed',
      attempts: 1,
      lastStatus: result.status ?? null,
      lastError: result.error ?? null,
      nextAttemptAt: new Date(Date.now() + backoffMs(1)),
      updatedAt: nowTs,
    })
    .where(eq(stripeWebhookDeliveries.id, claimed.id));
  return { projectId: project.id, ok: false, reason: 'delivery_failed' };
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!STRIPE_CONNECT_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Stripe Connect is not enabled on this deployment.' },
      { status: 404 },
    );
  }

  const signatureHeader = req.headers.get('stripe-signature');
  if (!signatureHeader) {
    return NextResponse.json({ ok: false, error: 'Missing Stripe-Signature' }, { status: 400 });
  }

  const rawBody = await req.text();
  const verified = await verifyAny(rawBody, signatureHeader);
  if (!verified) {
    return NextResponse.json({ ok: false, error: 'Signature did not verify' }, { status: 400 });
  }
  const { event, mode } = verified;

  const canonical = normalize(event, mode);
  if (!canonical) {
    return NextResponse.json({ ok: true, ignored: event.type });
  }

  if (!canonical.accountId) {
    return NextResponse.json({ ok: true, ignored: 'no_account_on_event' });
  }

  // Resolve which Botflow user owns the connected account (unique per mode).
  const db = getDb();
  const ownerAccountCol =
    canonical.mode === 'live' ? userStripeIdentity.liveAccountId : userStripeIdentity.testAccountId;
  const [identity] = await db
    .select({ userId: userStripeIdentity.userId })
    .from(userStripeIdentity)
    .where(eq(ownerAccountCol, canonical.accountId))
    .limit(1);
  if (!identity) {
    return NextResponse.json({ ok: true, ignored: 'no_botflow_user_for_account' });
  }

  // ── Determine target projects ──────────────────────────────────────────
  let targets: Array<typeof projects.$inferSelect>;
  if (ACCOUNT_LEVEL_TYPES.has(canonical.type)) {
    // Account status — safe to broadcast to the owner's same-mode projects
    // (carries no customer/payment data).
    targets = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.userId, identity.userId),
          eq(projects.stripeEnabled, true),
          eq(projects.stripePaymentMode, canonical.mode),
        ),
      );
  } else {
    // Payment/subscription — route to the SINGLE owning project (metadata first,
    // object-map fallback). Never broadcast one app's customer/payment data to
    // the user's other apps.
    const project = await resolveOwningProject(db, canonical, identity.userId);
    if (!project) {
      // Genuinely can't attribute this to one of the owner's enabled, same-mode
      // projects (e.g. an externally-created charge with no metadata and no prior
      // mapping). Drop rather than leak — but log so it's visible, not silent.
      console.warn(
        '[stripe/webhook] unroutable payment/subscription event dropped',
        'type=', canonical.type,
        'event=', canonical.id,
        'owner=', identity.userId,
      );
      return NextResponse.json({ ok: true, ignored: 'unroutable' });
    }
    targets = [project];
  }

  const payload = JSON.stringify(canonical);
  const deliveries = await Promise.all(
    targets.map((project) =>
      recordAndDeliver({
        project,
        eventId: canonical.id,
        canonicalType: canonical.type,
        mode: canonical.mode,
        payload,
      }),
    ),
  );

  return NextResponse.json({
    ok: true,
    type: canonical.type,
    deliveries: deliveries.length,
    failed: deliveries.filter((d) => !d.ok).length,
  });
}
