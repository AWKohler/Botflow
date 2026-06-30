/**
 * Stripe-specific delivery: thin wrapper over the generic webhook-delivery lib
 * that targets the project's Convex `/stripe/webhook` endpoint. The signing,
 * backoff, lease, and helpers are shared with the RevenueCat fan-out path.
 */
export {
  MAX_DELIVERY_ATTEMPTS,
  DELIVERY_LEASE_MS,
  backoffMs,
  convexSiteUrlFor,
  signedDeliveryHeaders,
  type DeliveryResult,
} from '@/lib/webhook-delivery';

import { deliverWebhookEventOnce, type DeliveryResult } from '@/lib/webhook-delivery';

/** POST one signed delivery to the project's Convex `/stripe/webhook` endpoint. */
export async function deliverStripeEventOnce(opts: {
  siteUrl: string;
  secret: string;
  payload: string;
  timeoutMs?: number;
}): Promise<DeliveryResult> {
  return deliverWebhookEventOnce({
    url: `${opts.siteUrl}/stripe/webhook`,
    secret: opts.secret,
    payload: opts.payload,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
