import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type Stripe from "stripe";
import { getIdentityDb } from "@/lib/auth/database";
import { billingStripe } from "./stripe";
import {
  priceId,
  planForPrice,
  type PaidPlan,
  type BillingInterval,
} from "./plans";
interface Quote {
  userId: string;
  subscriptionId: string;
  itemId: string;
  currentPrice: string;
  targetPrice: string;
  plan: PaidPlan;
  interval: BillingInterval;
  prorationDate: number;
  periodEnd: number;
  effectiveAt: number;
  amountDue: number;
  recurringAmount: number;
  currency: string;
  expiresAt: number;
}
export function changeTiming(
  currentPlan: PaidPlan,
  currentInterval: string,
  targetPlan: PaidPlan,
  targetInterval: BillingInterval,
): "now" | "renewal" {
  return (currentPlan === "max" && targetPlan === "pro") ||
    (currentPlan === targetPlan &&
      currentInterval === "year" &&
      targetInterval === "month")
    ? "renewal"
    : "now";
}
function signature(value: string) {
  if (!process.env.BETTER_AUTH_SECRET)
    throw new Error("Signing key unavailable");
  return createHmac("sha256", process.env.BETTER_AUTH_SECRET)
    .update(`billing-quote:${value}`)
    .digest();
}
function encode(quote: Quote) {
  const body = Buffer.from(JSON.stringify(quote)).toString("base64url");
  return `${body}.${signature(body).toString("base64url")}`;
}
function decode(token: string, userId: string): Quote {
  const [body, mac, ...extra] = token.split(".");
  if (!body || !mac || extra.length) throw new Error("Invalid quote");
  const received = Buffer.from(mac, "base64url"),
    expected = signature(body);
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    throw new Error("Invalid quote");
  const quote = JSON.parse(Buffer.from(body, "base64url").toString()) as Quote;
  if (quote.userId !== userId || quote.expiresAt < Date.now())
    throw new Error("This quote expired. Review the plan again.");
  if (priceId(quote.plan, quote.interval) !== quote.targetPrice)
    throw new Error("The plan price changed. Review it again.");
  return quote;
}
async function currentSubscription(
  userId: string,
  stripe: Stripe,
  connection?: PoolClient,
) {
  const { rows } = await (connection ?? getIdentityDb()).query(
    "SELECT * FROM botflow_subscription WHERE user_id=$1",
    [userId],
  );
  const row = rows[0];
  if (row?.source !== "stripe" || !row.stripe_subscription_id)
    throw new Error("No active migrated subscription");
  const subscription = await stripe.subscriptions.retrieve(
    row.stripe_subscription_id,
  );
  if (
    subscription.customer !== row.stripe_customer_id ||
    subscription.items.data.length !== 1 ||
    !["active", "trialing"].includes(subscription.status)
  )
    throw new Error("This subscription needs attention before changing plans.");
  if (subscription.cancel_at_period_end)
    throw new Error("Resume your subscription before changing plans.");
  if (subscription.pending_update)
    throw new Error("Complete the pending payment before changing plans.");
  return subscription;
}
async function previewInvoice(
  stripe: Stripe,
  quote: Pick<
    Quote,
    "subscriptionId" | "itemId" | "targetPrice" | "prorationDate"
  >,
) {
  return stripe.invoices.createPreview({
    subscription: quote.subscriptionId,
    subscription_details: {
      items: [{ id: quote.itemId, price: quote.targetPrice, quantity: 1 }],
      proration_behavior: "always_invoice",
      proration_date: quote.prorationDate,
    },
  });
}
export async function quotePlanChange(
  userId: string,
  plan: PaidPlan,
  interval: BillingInterval,
) {
  const stripe = billingStripe(),
    subscription = await currentSubscription(userId, stripe),
    item = subscription.items.data[0];
  const target = await stripe.prices.retrieve(priceId(plan, interval));
  const currentPlan = planForPrice(item.price.id);
  if (!currentPlan) throw new Error("Unknown current plan");
  if (target.id === item.price.id)
    throw new Error("You already have this plan and billing period.");
  const now = Math.floor(Date.now() / 1000),
    scheduled =
      changeTiming(
        currentPlan,
        item.price.recurring!.interval,
        plan,
        interval,
      ) === "renewal";
  const quote: Quote = {
    userId,
    subscriptionId: subscription.id,
    itemId: item.id,
    currentPrice: item.price.id,
    targetPrice: target.id,
    plan,
    interval,
    prorationDate: now,
    periodEnd: item.current_period_end,
    effectiveAt: scheduled ? item.current_period_end : now,
    amountDue: 0,
    recurringAmount: target.unit_amount ?? 0,
    currency: target.currency,
    expiresAt: Date.now() + 5 * 60000,
  };
  if (!scheduled) {
    const invoice = await previewInvoice(stripe, quote);
    quote.amountDue = invoice.amount_due;
  }
  return {
    token: encode(quote),
    plan,
    interval,
    amountDue: quote.amountDue,
    recurringAmount: quote.recurringAmount,
    currency: quote.currency,
    effectiveAt: quote.effectiveAt,
    scheduled,
  };
}
export async function applyPlanChange(userId: string, token: string) {
  const quote = decode(token, userId),
    stripe = billingStripe(),
    db = await getIdentityDb().connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `billing:${userId}`,
    ]);
    const identity = await db.query(
      "SELECT banned FROM identity_user WHERE id=$1",
      [userId],
    );
    if (!identity.rows[0] || identity.rows[0].banned)
      throw new Error("Account unavailable");
    const sub = await currentSubscription(userId, stripe, db),
      item = sub.items.data[0];
    if (
      sub.id !== quote.subscriptionId ||
      item.id !== quote.itemId ||
      item.price.id !== quote.currentPrice ||
      item.current_period_end !== quote.periodEnd
    )
      throw new Error("Your subscription changed. Review the plan again.");
    const scheduled = quote.effectiveAt === quote.periodEnd;
    const existingSchedule = sub.schedule
      ? await stripe.subscriptionSchedules.retrieve(
          typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id,
        )
      : null;
    if (
      existingSchedule &&
      existingSchedule.metadata?.botflow_user_id !== userId
    ) {
      // Recover an interrupted create/update only through this exact quote's
      // Stripe idempotency key; never adopt an unrelated schedule.
      if (Object.keys(existingSchedule.metadata ?? {}).length)
        throw new Error("A scheduled billing change requires support.");
      const recovered = await stripe.subscriptionSchedules.create(
        { from_subscription: sub.id },
        { idempotencyKey: `plan-schedule:${signature(token).toString("hex")}` },
      );
      if (recovered.id !== existingSchedule.id)
        throw new Error("A scheduled billing change requires support.");
    }
    if (scheduled) {
      const schedule =
        existingSchedule ??
        (await stripe.subscriptionSchedules.create(
          { from_subscription: sub.id },
          {
            idempotencyKey: `plan-schedule:${signature(token).toString("hex")}`,
          },
        ));
      await stripe.subscriptionSchedules.update(schedule.id, {
        metadata: { botflow_user_id: userId },
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: item.current_period_start,
            end_date: item.current_period_end,
            items: [{ price: item.price.id, quantity: 1 }],
            proration_behavior: "none",
          },
          {
            start_date: item.current_period_end,
            items: [{ price: quote.targetPrice, quantity: 1 }],
            iterations: 1,
            proration_behavior: "none",
          },
        ],
      });
      await db.query("COMMIT");
      return { scheduled: true, effectiveAt: quote.effectiveAt };
    }
    const preview = await previewInvoice(stripe, quote);
    if (
      preview.amount_due !== quote.amountDue ||
      preview.currency !== quote.currency
    )
      throw new Error("The charge changed. Review a fresh quote.");
    if (existingSchedule)
      await stripe.subscriptionSchedules.release(existingSchedule.id);
    const updated = await stripe.subscriptions.update(
      sub.id,
      {
        items: [{ id: item.id, price: quote.targetPrice, quantity: 1 }],
        proration_behavior: "always_invoice",
        proration_date: quote.prorationDate,
        payment_behavior: "pending_if_incomplete",
        expand: ["latest_invoice.confirmation_secret"],
      },
      { idempotencyKey: `plan-change:${signature(token).toString("hex")}` },
    );
    const invoice =
      typeof updated.latest_invoice === "object"
        ? updated.latest_invoice
        : null;
    await db.query("COMMIT");
    return {
      scheduled: false,
      effectiveAt: quote.effectiveAt,
      clientSecret: updated.pending_update
        ? invoice?.confirmation_secret?.client_secret
        : undefined,
      pendingPayment: !!updated.pending_update,
    };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
