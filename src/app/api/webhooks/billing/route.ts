import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { billingStripe } from "@/lib/billing/stripe";
import { planForPrice } from "@/lib/billing/plans";
import { getIdentityDb } from "@/lib/auth/database";
import { handlePlanChange } from "@/lib/billing/plan-change";
import { getUserTier } from "@/lib/tier";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const secret = process.env.BILLING_STRIPE_WEBHOOK_SECRET;
  if (!secret)
    return NextResponse.json(
      { error: "Webhook not configured" },
      { status: 503 },
    );
  let event: Stripe.Event;
  const stripe = billingStripe();
  try {
    event = stripe.webhooks.constructEvent(
      await request.text(),
      request.headers.get("stripe-signature") ?? "",
      secret,
    );
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
  if (event.livemode !== (process.env.BILLING_STRIPE_MODE === "live"))
    return NextResponse.json({ error: "Wrong Stripe mode" }, { status: 400 });
  if (
    !event.type.startsWith("customer.subscription.") &&
    ![
      "invoice.paid",
      "invoice.payment_failed",
      "checkout.session.completed",
    ].includes(event.type)
  )
    return NextResponse.json({ received: true });
  let subscriptionId: string | null = null;
  if (event.type.startsWith("customer.subscription."))
    subscriptionId = (event.data.object as Stripe.Subscription).id;
  else if (event.type === "checkout.session.completed") {
    const s = (event.data.object as Stripe.Checkout.Session).subscription;
    subscriptionId = typeof s === "string" ? s : (s?.id ?? null);
  } else {
    const s = (event.data.object as Stripe.Invoice).parent?.subscription_details
      ?.subscription;
    subscriptionId = typeof s === "string" ? s : (s?.id ?? null);
  }
  if (!subscriptionId) return NextResponse.json({ received: true });
  const connection = await getIdentityDb().connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "INSERT INTO botflow_billing_event (event_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [event.id],
    );
    const receipt = await connection.query(
      "SELECT status FROM botflow_billing_event WHERE event_id=$1 FOR UPDATE",
      [event.id],
    );
    if (receipt.rows[0].status === "processed") {
      await connection.query("COMMIT");
      return NextResponse.json({ received: true });
    }
    // Lock before the retrieve. Concurrent/out-of-order events all apply Stripe's
    // current state, never the historical event body.
    await connection.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      subscriptionId,
    ]);
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;
    const record = await connection.query(
      "SELECT user_id, stripe_subscription_id, status FROM botflow_subscription WHERE stripe_customer_id=$1 FOR UPDATE",
      [customerId],
    );
    const owner = record.rows[0];
    const isReplacement =
      owner?.stripe_subscription_id &&
      owner.stripe_subscription_id !== subscription.id;
    const mayReplace =
      isReplacement &&
      ["canceled", "incomplete_expired", "ended"].includes(owner.status) &&
      ["active", "trialing", "incomplete"].includes(subscription.status) &&
      subscription.metadata.botflow_user_id === owner.user_id;
    if (!owner || (isReplacement && !mayReplace)) {
      // Ignore unrelated Stripe products/customers; this account also powers Connect.
      await connection.query(
        "UPDATE botflow_billing_event SET status='processed', processed_at=now() WHERE event_id=$1",
        [event.id],
      );
      await connection.query("COMMIT");
      return NextResponse.json({ received: true });
    }
    const item = subscription.items.data[0];
    const plan = item && planForPrice(item.price.id);
    if (!plan || subscription.items.data.length !== 1)
      throw new Error("Unmapped Botflow subscription price");
    await connection.query(
      `UPDATE botflow_subscription SET source='stripe',stripe_subscription_id=$2,plan=$3,status=$4,
      amount=$5,currency=$6,interval=$7,period_start=$8,period_end=$9,cancel_at_period_end=$10,stripe_event_created=GREATEST(stripe_event_created,$11),updated_at=now() WHERE user_id=$1`,
      [
        owner.user_id,
        subscription.id,
        plan,
        subscription.status,
        item.price.unit_amount ?? 0,
        item.price.currency,
        item.price.recurring?.interval ?? "month",
        new Date(item.current_period_start * 1000),
        new Date(item.current_period_end * 1000),
        subscription.cancel_at_period_end,
        event.created,
      ],
    );
    await connection.query("COMMIT");
    await handlePlanChange(owner.user_id, await getUserTier(owner.user_id));
    await connection.query(
      "UPDATE botflow_billing_event SET status='processed', processed_at=now() WHERE event_id=$1",
      [event.id],
    );
    return NextResponse.json({ received: true });
  } catch (error) {
    await connection.query("ROLLBACK");
    console.error("[billing-webhook] Event processing failed", {
      eventId: event.id,
      error: error instanceof Error ? error.name : "error",
    });
    return NextResponse.json(
      { error: "Event processing failed" },
      { status: 500 },
    );
  } finally {
    connection.release();
  }
}
