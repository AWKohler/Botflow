import { migrationArtifactPath } from "./artifacts";
import { config } from "dotenv";
config({
  path: process.env.AUTH_MIGRATION_ENV_FILE || ".env.local",
  quiet: true,
});
import { readFile, writeFile } from "node:fs/promises";
import { decryptPrivateData } from "../../src/lib/auth/crypto";
import type { Snapshot } from "./snapshot";
import Stripe from "stripe";
async function main() {
  if (!process.env.STRIPE_READ_ONLY_KEY)
    throw new Error("STRIPE_READ_ONLY_KEY required");
  const stripe = new Stripe(process.env.STRIPE_READ_ONLY_KEY, {
    apiVersion: "2025-08-27.basil",
  });
  const snapshot = decryptPrivateData<Snapshot>(
    await readFile(migrationArtifactPath("clerk-snapshot.enc"), "utf8"),
    "clerk-migration-snapshot",
  );
  const customers: Stripe.Customer[] = [];
  for await (const customer of stripe.customers.list({ limit: 100 }))
    customers.push(customer);
  const result = [];
  for (const user of snapshot.users) {
    const subscription = snapshot.subscriptions[user.id];
    const paid = subscription.subscription_items.filter(
      (i) =>
        ["pro", "max", "staff"].includes(i.plan.slug) &&
        ["active", "past_due", "canceled"].includes(i.status),
    );
    if (!paid.length) continue;
    const email = user.email_addresses
      .find((e) => e.id === user.primary_email_address_id)
      ?.email_address.toLowerCase();
    const candidates = customers.filter(
      (c) =>
        c.email?.toLowerCase() === email ||
        Object.values(c.metadata).includes(user.id),
    );
    const candidateReports = [];
    for (const customer of candidates) {
      const [methods, subscriptions, intents] = await Promise.all([
        stripe.paymentMethods.list({
          customer: customer.id,
          type: "card",
          limit: 100,
        }),
        stripe.subscriptions.list({
          customer: customer.id,
          status: "all",
          limit: 100,
        }),
        stripe.paymentIntents.list({ customer: customer.id, limit: 100 }),
      ]);
      candidateReports.push({
        customerId: customer.id,
        metadata: customer.metadata,
        paymentMethodIds: methods.data.map((m) => m.id),
        subscriptions: subscriptions.data.map((s) => ({
          id: s.id,
          status: s.status,
          metadata: s.metadata,
        })),
        recentPayments: intents.data.slice(0, 10).map((p) => ({
          id: p.id,
          amount: p.amount,
          status: p.status,
          created: p.created,
          metadata: p.metadata,
          description: p.description,
          paymentMethod:
            typeof p.payment_method === "string"
              ? p.payment_method
              : p.payment_method?.id,
        })),
      });
    }
    result.push({
      userId: user.id,
      clerkSubscriptionId: subscription.id,
      items: paid.map((i) => ({
        id: i.id,
        plan: i.plan.slug,
        amount: i.plan.fee.amount,
        interval: i.plan_period,
        periodStart: i.period_start,
        periodEnd: i.period_end,
        canceledAt: i.canceled_at,
      })),
      candidates: candidateReports,
    });
  }
  await writeFile(
    migrationArtifactPath("billing-reconciliation.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
