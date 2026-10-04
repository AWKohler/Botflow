import { getIdentityDb } from "@/lib/auth/database";
import type { Tier } from "@/lib/tier-shared";

export interface SubscriptionRecord {
  user_id: string;
  source: "clerk" | "stripe";
  plan: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  legacy_billing_cutover_at?: Date | null;
  period_end: Date | null;
  cancel_at_period_end: boolean;
  amount: number;
  currency: string;
  interval: string;
}
export function subscriptionTier(
  subscription:
    | (Pick<SubscriptionRecord, "plan" | "status" | "period_end"> & {
        source?: SubscriptionRecord["source"];
      })
    | null,
  now = Date.now(),
): Tier {
  if (
    !subscription ||
    !["active", "trialing", "canceled"].includes(subscription.status)
  )
    return "free";
  // Stripe's canceled status means termination; scheduled cancellations stay active.
  if (subscription.source === "stripe" && subscription.status === "canceled")
    return "free";
  if (
    subscription.period_end &&
    new Date(subscription.period_end).getTime() <= now
  )
    return "free";
  return subscription.plan === "max"
    ? "max"
    : subscription.plan === "pro"
      ? "pro"
      : "free";
}
export async function getSubscription(
  userId: string,
): Promise<SubscriptionRecord | null> {
  const { rows } = await getIdentityDb().query<SubscriptionRecord>(
    "SELECT * FROM botflow_subscription WHERE user_id=$1",
    [userId],
  );
  return rows[0] ?? null;
}
export async function getPaidTier(userId: string): Promise<Tier> {
  return subscriptionTier(await getSubscription(userId));
}
