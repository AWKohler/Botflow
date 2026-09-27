/** Exercises real Stripe TEST objects and the signed webhook against isolated Neon. */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { billingStripe } from "../../src/lib/billing/stripe";
import { getIdentityDb } from "../../src/lib/auth/database";
import { encryptPrivateData } from "../../src/lib/auth/crypto";
import { getPaidTier } from "../../src/lib/billing/entitlements";
import { POST } from "../../src/app/api/webhooks/billing/route";

async function main() {
  if (
    process.env.AUTH_MIGRATION_TARGET !== "staging" ||
    process.env.BILLING_STRIPE_MODE !== "test"
  )
    throw new Error("Requires isolated staging and Stripe test mode");
  process.env.BILLING_STRIPE_WEBHOOK_SECRET = `whsec_rehearsal_${randomUUID()}`;
  const stripe = billingStripe(),
    db = getIdentityDb(),
    tag = randomUUID(),
    userId = `billing-rehearsal-${tag}`;
  let customerId: string | undefined;
  const subscriptions: string[] = [],
    events: string[] = [];
  async function deliver(
    subscriptionId: string,
    id = `evt_rehearsal_${randomUUID()}`,
  ) {
    const payload = JSON.stringify({
      id,
      object: "event",
      type: "customer.subscription.updated",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: subscriptionId } },
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.BILLING_STRIPE_WEBHOOK_SECRET!,
    });
    events.push(id);
    const response = await POST(
      new Request("http://localhost:3107/api/webhooks/billing", {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: payload,
      }),
    );
    assert.equal(response.status, 200, await response.text());
    return id;
  }
  try {
    const invalid = await POST(
      new Request("http://localhost:3107/api/webhooks/billing", {
        method: "POST",
        body: "{}",
      }),
    );
    assert.equal(invalid.status, 400);
    await db.query(
      'INSERT INTO identity_user(id,name,email,"emailVerified")VALUES($1,$2,$3,true)',
      [userId, "Billing test", `${tag}@example.invalid`],
    );
    await db.query(
      "INSERT INTO identity_profile(user_id,private_metadata_encrypted)VALUES($1,$2)",
      [userId, encryptPrivateData({}, `profile:${userId}`)],
    );
    const customer = await stripe.customers.create({
      name: "Botflow migration TEST fixture",
      metadata: { botflow_user_id: userId },
    });
    customerId = customer.id;
    const payment = await stripe.paymentMethods.attach("pm_card_visa", {
      customer: customer.id,
    });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: payment.id },
    });
    await db.query(
      "INSERT INTO botflow_subscription(user_id,source,stripe_customer_id,plan,status)VALUES($1,'stripe',$2,'free','active')",
      [userId, customer.id],
    );
    const anchor = Math.floor(Date.now() / 1000) + 7 * 86400;
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: process.env.BILLING_PRICE_PRO_LEGACY! }],
      default_payment_method: payment.id,
      billing_cycle_anchor: anchor,
      proration_behavior: "none",
      cancel_at_period_end: true,
      metadata: { botflow_user_id: userId },
    });
    subscriptions.push(sub.id);
    assert.equal(sub.items.data[0].current_period_end, anchor);
    assert.equal(sub.cancel_at_period_end, true);
    const invoices = await stripe.invoices.list({ customer: customer.id });
    assert.ok(invoices.data.every((i) => i.amount_due === 0));
    const event = await deliver(sub.id);
    assert.equal(await getPaidTier(userId), "pro");
    await deliver(sub.id, event);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM botflow_billing_event WHERE event_id=$1",
          [event],
        )
      ).rows[0].count,
      1,
    );
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
    await deliver(sub.id);
    assert.equal(
      (
        await db.query(
          "SELECT cancel_at_period_end FROM botflow_subscription WHERE user_id=$1",
          [userId],
        )
      ).rows[0].cancel_at_period_end,
      false,
    );
    await stripe.subscriptions.update(sub.id, {
      items: [
        {
          id: sub.items.data[0].id,
          price: process.env.BILLING_PRICE_MAX_MONTH!,
        },
      ],
      proration_behavior: "none",
    });
    await deliver(sub.id);
    assert.equal(await getPaidTier(userId), "max");
    await stripe.subscriptions.cancel(sub.id);
    await deliver(sub.id);
    assert.equal(await getPaidTier(userId), "free");
    const replacement = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: process.env.BILLING_PRICE_PRO_MONTH! }],
      trial_end: anchor,
      metadata: { botflow_user_id: userId },
    });
    subscriptions.push(replacement.id);
    await deliver(replacement.id);
    assert.equal(await getPaidTier(userId), "pro");
    await deliver(sub.id);
    assert.equal(await getPaidTier(userId), "pro");
    assert.equal(
      (
        await db.query(
          "SELECT stripe_subscription_id FROM botflow_subscription WHERE user_id=$1",
          [userId],
        )
      ).rows[0].stripe_subscription_id,
      replacement.id,
    );
    console.log(
      JSON.stringify(
        {
          invalidSignatureRejected: true,
          grandfatheredPricePreserved: true,
          renewalAnchorPreserved: true,
          noImmediateCharge: true,
          renewalDisabledUntilCutover: true,
          duplicateEventIdempotent: true,
          renewalResumed: true,
          maxUpgrade: true,
          immediateCancellationRevokesAccess: true,
          resubscribe: true,
          staleSubscriptionEventIgnored: true,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const id of subscriptions) {
      const sub = await stripe.subscriptions.retrieve(id);
      if (sub.status !== "canceled") await stripe.subscriptions.cancel(id);
    }
    if (customerId) await stripe.customers.del(customerId);
    await db.query(
      "DELETE FROM botflow_billing_event WHERE event_id=ANY($1::text[])",
      [events],
    );
    await db.query("DELETE FROM botflow_subscription WHERE user_id=$1", [
      userId,
    ]);
    await db.query("DELETE FROM identity_user WHERE id=$1", [userId]);
    await db.end();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
