/**
 * Programmatic provisioning of the platform's Stripe Connect webhook endpoints.
 *
 * A single Connect webhook endpoint per mode (registered on the PLATFORM
 * account) receives events for every connected account — users never configure
 * anything. Historically this was set up by hand in the Stripe dashboard, which
 * is exactly how live-mode delivery silently went missing. Instead we create
 * the endpoint via the Stripe API (idempotently, one row per mode) and store
 * the signing secret — Stripe only returns it at creation time — so the inbound
 * receiver can verify against it without depending on env config or a human.
 */
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { getDb } from '@/db';
import { stripeWebhookEndpoints } from '@/db/schema';
import { getStripe, type StripeMode } from '@/lib/stripe';

// Stable public origin Stripe should deliver to (never a preview URL).
function webhookUrl(): string {
  const base = (process.env.STRIPE_WEBHOOK_PUBLIC_BASE || 'https://botflow.io').replace(/\/+$/, '');
  return `${base}/api/webhooks/stripe`;
}

// The events our normalize() switch handles. Intentionally explicit so the
// "subscription events weren't enabled" failure can't recur.
const ENABLED_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'checkout.session.completed',
  // Delayed/async Checkout payment methods (bank debits etc.) finish unpaid and
  // clear later — without these the success would never be fulfilled.
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  // NOTE: payment_intent.succeeded is deliberately NOT enabled — it would
  // duplicate checkout.session.completed for the same one-time charge (the
  // receiver also ignores it). Only the failure event is needed.
  'payment_intent.payment_failed',
  'account.updated',
];

/**
 * All managed webhook signing secrets stored in the DB. Best-effort — returns
 * [] if the table doesn't exist yet (migration not applied) so the env-based
 * verification path keeps working.
 */
export async function getManagedWebhookSecrets(): Promise<Array<{ mode: StripeMode; secret: string }>> {
  try {
    const db = getDb();
    const rows = await db.select().from(stripeWebhookEndpoints);
    return rows.map((r) => ({ mode: r.mode as StripeMode, secret: r.secret }));
  } catch {
    return [];
  }
}

/**
 * Ensure a Connect webhook endpoint exists for `mode`. Idempotent via the DB
 * (one row per mode). Best-effort — never throws; logs and returns on failure.
 */
export async function ensureConnectWebhookEndpoint(mode: StripeMode): Promise<void> {
  try {
    const db = getDb();
    const stripe = getStripe(mode);
    const [existing] = await db
      .select()
      .from(stripeWebhookEndpoints)
      .where(eq(stripeWebhookEndpoints.mode, mode))
      .limit(1);
    if (existing) {
      // Already provisioned — but self-heal the enabled-events set so newly-added
      // event types (e.g. async Checkout) reach EXISTING production endpoints
      // without a manual migration. Idempotent (setting the same set is a no-op);
      // best-effort so a transient Stripe error doesn't break the connect flow.
      try {
        await stripe.webhookEndpoints.update(existing.endpointId, { enabled_events: ENABLED_EVENTS });
      } catch (err) {
        console.error('[stripe-webhook-provisioning] failed to sync enabled_events for', mode, err);
      }
      return;
    }

    const url = webhookUrl();
    const endpoint = await stripe.webhookEndpoints.create({
      url,
      enabled_events: ENABLED_EVENTS,
      connect: true,
    });
    if (!endpoint.secret) {
      console.error('[stripe-webhook-provisioning] Stripe returned no secret for', mode);
      // Don't leave a secretless endpoint live at Stripe.
      await stripe.webhookEndpoints.del(endpoint.id).catch(() => {});
      return;
    }
    const [inserted] = await db
      .insert(stripeWebhookEndpoints)
      .values({ mode, endpointId: endpoint.id, secret: endpoint.secret, url })
      .onConflictDoNothing()
      .returning({ endpointId: stripeWebhookEndpoints.endpointId });
    if (!inserted) {
      // A concurrent call already provisioned this mode and won the insert. The
      // endpoint we just created is an orphan whose secret isn't stored — its
      // deliveries would fail verification forever. Delete it immediately.
      await stripe.webhookEndpoints.del(endpoint.id).catch((err) => {
        console.error('[stripe-webhook-provisioning] failed to delete orphan endpoint', endpoint.id, err);
      });
      console.log('[stripe-webhook-provisioning] lost provisioning race for', mode, '— deleted orphan', endpoint.id);
      return;
    }
    console.log('[stripe-webhook-provisioning] provisioned', mode, 'endpoint', endpoint.id);
  } catch (err) {
    console.error('[stripe-webhook-provisioning] ensure failed for', mode, err);
  }
}
