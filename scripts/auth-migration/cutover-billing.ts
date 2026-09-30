/** Dry-run by default. Preserve the reconciled customer, card, price, and renewal. */
import { config } from "dotenv";
config({ path: process.env.AUTH_MIGRATION_ENV_FILE || ".env.local", quiet: true });
import { readFile, writeFile } from "node:fs/promises";
import { getIdentityDb } from "../../src/lib/auth/database";
import { billingStripe } from "../../src/lib/billing/stripe";
interface Reconciliation {
  userId: string;
  clerkSubscriptionId: string;
  items: {
    id: string;
    plan: string;
    amount: number;
    interval: string;
    periodEnd: number;
    canceledAt: number | null;
  }[];
  candidates: {
    customerId: string;
    metadata: Record<string, string>;
    paymentMethodIds: string[];
  }[];
}
async function main() {
  const records = JSON.parse(
    await readFile(".migration/billing-reconciliation.json", "utf8"),
  ) as Reconciliation[];
  const plans = records.map((r) => {
    const matches = r.candidates.filter(
      (c) =>
        c.metadata.user_id === r.userId ||
        c.metadata.botflow_user_id === r.userId,
    );
    if (
      matches.length !== 1 ||
      r.items.length !== 1 ||
      matches[0].paymentMethodIds.length !== 1
    )
      throw new Error(
        "Ambiguous billing owner/payment method; manual reconciliation required",
      );
    const item = r.items[0];
    if (item.plan !== "pro" || item.amount !== 100 || item.interval !== "month")
      throw new Error(
        "Unexpected legacy contract; update reviewed mapping before cutover",
      );
    return {
      userId: r.userId,
      clerkSubscriptionId: r.clerkSubscriptionId,
      clerkItemId: item.id,
      customerId: matches[0].customerId,
      paymentMethodId: matches[0].paymentMethodIds[0],
      amount: 100,
      interval: "month",
      renewalAt: new Date(item.periodEnd).toISOString(),
      renewalTimestamp: Math.floor(item.periodEnd / 1000),
      cancelAtPeriodEnd: !!item.canceledAt,
    };
  });
  console.log(
    JSON.stringify({ mode: "review", subscriptions: plans }, null, 2),
  );
  if (!process.argv.includes("--apply")) return;
  if (
    process.env.AUTH_MIGRATION_TARGET !== "production" ||
    process.env.BILLING_STRIPE_MODE !== "live" ||
    !process.argv.includes("--preserve-existing-renewals")
  )
    throw new Error(
      "Production billing cutover requires explicit target, live keys, and --preserve-existing-renewals",
    );
  const targetHost = new URL(process.env.DATABASE_URL!).hostname;
  if (!process.argv.includes(`--target-host=${targetHost}`))
    throw new Error("Explicit database target required");
  const stripe = billingStripe();
  const db = getIdentityDb();
  for (const p of plans) {
    if (p.cancelAtPeriodEnd)
      throw new Error(
        "This customer already canceled; preserve the cancellation instead of creating a renewal",
      );
    if (p.renewalTimestamp - Date.now() / 1000 < 48 * 3600)
      throw new Error(
        "Renewal is less than 48 hours away; refresh and review the cutover",
      );
    if (!process.env.BILLING_PRICE_PRO_LEGACY)
      throw new Error("Grandfathered Stripe price required");
    const customer = await stripe.customers.retrieve(p.customerId);
    if (customer.deleted || customer.metadata.user_id !== p.userId)
      throw new Error("Customer ownership mismatch");
    const method = await stripe.paymentMethods.retrieve(p.paymentMethodId);
    if (method.customer !== p.customerId)
      throw new Error("Payment method ownership mismatch");
    const price = await stripe.prices.retrieve(
      process.env.BILLING_PRICE_PRO_LEGACY,
    );
    if (
      price.unit_amount !== p.amount ||
      price.currency !== "usd" ||
      price.recurring?.interval !== "month"
    )
      throw new Error("Grandfathered price differs from the contract");
    const list = await stripe.subscriptions.list({
      customer: p.customerId,
      status: "all",
      limit: 100,
    });
    const active = list.data.filter(
      (s) => !["canceled", "incomplete_expired"].includes(s.status),
    );
    const migrated = active.find(
      (s) => s.metadata.clerk_subscription_item_id === p.clerkItemId,
    );
    if (active.some((s) => s.id !== migrated?.id))
      throw new Error(
        "An unrelated subscription already exists; do not double bill",
      );
    const h = {
      Authorization: `Bearer ${process.env.CLERK_MIGRATION_SECRET_KEY}`,
      "Content-Type": "application/json",
    };
    const fresh = await fetch(
      `https://api.clerk.com/v1/users/${p.userId}/billing/subscription`,
      { headers: h },
    );
    if (!fresh.ok) throw new Error("Cannot verify current Clerk contract");
    const before = await fresh.json();
    const original = before.subscription_items.find(
      (i: { id: string }) => i.id === p.clerkItemId,
    );
    if (
      before.id !== p.clerkSubscriptionId ||
      !original ||
      original.plan?.slug !== "pro" ||
      original.plan?.fee?.amount !== p.amount ||
      original.plan_period !== p.interval ||
      !["active", "canceled"].includes(original.status) ||
      Math.floor(original.period_end / 1000) !== p.renewalTimestamp
    )
      throw new Error(
        "Clerk contract changed; resume reconciliation before cancellation",
      );
    if (original.canceled_at && !migrated)
      throw new Error("The customer canceled since reconciliation; preserve their cancellation and refresh the migration plan");
    if (migrated && (
      migrated.metadata.botflow_user_id !== p.userId ||
      migrated.items.data.length !== 1 ||
      migrated.items.data[0].price.id !== price.id ||
      migrated.items.data[0].current_period_end !== p.renewalTimestamp ||
      !["active", "trialing"].includes(migrated.status)
    ))
      throw new Error("Recovered Stripe subscription differs from the verified migration contract");
    const target = await db.query(
      "SELECT user_id FROM botflow_subscription WHERE user_id=$1 AND clerk_item_id=$2",
      [p.userId, p.clerkItemId],
    );
    if (target.rowCount !== 1)
      throw new Error("Imported billing contract missing from target database");
    // Create with renewal DISABLED. A failure before verified Clerk cancellation cannot double bill.
    const subscription =
      migrated ??
      (await stripe.subscriptions.create(
        {
          customer: p.customerId,
          items: [{ price: price.id }],
          default_payment_method: p.paymentMethodId,
          billing_cycle_anchor: p.renewalTimestamp,
          proration_behavior: "none",
          cancel_at_period_end: true,
          metadata: {
            botflow_user_id: p.userId,
            clerk_subscription_item_id: p.clerkItemId,
            migration: "clerk-to-botflow-v1",
          },
        },
        { idempotencyKey: `clerk-cutover-v1:${p.clerkItemId}` },
      ));
    if (!original.canceled_at && !subscription.cancel_at_period_end)
      throw new Error(
        "Stripe and Clerk renewal are both enabled; reconcile the checkpoint before continuing",
      );
    await writeFile(
      ".migration/billing-cutover-checkpoint.json",
      JSON.stringify(
        {
          ...p,
          stripeSubscriptionId: subscription.id,
          step: "stripe-created-with-renewal-disabled",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (!original.canceled_at) {
      const cancel = await fetch(
        `https://api.clerk.com/v1/billing/subscription_items/${p.clerkItemId}?end_now=false`,
        { method: "DELETE", headers: h },
      );
      if (!cancel.ok)
        throw new Error(
          "Clerk cancellation failed; checkpoint retained. Resolve before renewal.",
        );
    }
    const check = await fetch(
      `https://api.clerk.com/v1/users/${p.userId}/billing/subscription`,
      { headers: h },
    );
    if (!check.ok) throw new Error("Cannot verify Clerk cancellation");
    const after = await check.json();
    const canceled = after.subscription_items.find(
      (i: { id: string }) => i.id === p.clerkItemId,
    );
    if (!canceled?.canceled_at)
      throw new Error(
        "Clerk renewal is still active; do not mark cutover complete",
      );
    await writeFile(
      ".migration/billing-cutover-checkpoint.json",
      JSON.stringify(
        {
          ...p,
          stripeSubscriptionId: subscription.id,
          step: "clerk-cancellation-verified-stripe-activation-pending",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const activated = await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: false,
    });
    const item = activated.items.data[0];
    const saved = await db.query(
      `UPDATE botflow_subscription SET source='stripe',stripe_customer_id=$2,stripe_subscription_id=$3,status=$4,period_start=$5,period_end=$6,cancel_at_period_end=false,updated_at=now() WHERE user_id=$1 AND clerk_item_id=$7`,
      [
        p.userId,
        p.customerId,
        activated.id,
        activated.status,
        new Date(item.current_period_start * 1000),
        new Date(item.current_period_end * 1000),
        p.clerkItemId,
      ],
    );
    if (saved.rowCount !== 1)
      throw new Error(
        "Billing activated but database update failed; recover from checkpoint immediately",
      );
    await writeFile(
      ".migration/billing-cutover-checkpoint.json",
      JSON.stringify(
        {
          ...p,
          stripeSubscriptionId: subscription.id,
          step: "verified-complete",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  await db.end();
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
