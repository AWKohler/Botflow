/** Idempotently provision the four public prices plus the grandfathered Pro price. */
import { config } from "dotenv";
config({ path: process.env.AUTH_MIGRATION_ENV_FILE || ".env.local", quiet: true });
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "dotenv";
import { billingStripe } from "../../src/lib/billing/stripe";
import { BILLING_PLANS } from "../../src/lib/billing/plans";
async function main() {
  const live = process.env.BILLING_STRIPE_MODE === "live";
  if (live && !process.argv.includes("--live-reviewed"))
    throw new Error("Live provisioning requires --live-reviewed");
  const stripe = billingStripe();
  const envPath = process.env.AUTH_MIGRATION_ENV_FILE || ".env.local";
  const env = parse(await readFile(envPath));
  for (const plan of ["pro", "max"] as const) {
    const productId = `botflow_identity_${plan}_v1`;
    let product;
    try {
      product = await stripe.products.retrieve(productId);
    } catch {
      product = await stripe.products.create(
        {
          id: productId,
          name: BILLING_PLANS[plan].name,
          description: BILLING_PLANS[plan].description,
          metadata: { botflow_identity_billing: "v1", plan },
        },
        { idempotencyKey: productId },
      );
    }
    for (const interval of ["month", "year"] as const) {
      const lookup = `botflow_identity_${plan}_${interval}_v1`;
      const existing = await stripe.prices.list({
        lookup_keys: [lookup],
        limit: 1,
      });
      const amount =
        interval === "month"
          ? BILLING_PLANS[plan].monthly
          : BILLING_PLANS[plan].annual;
      const price =
        existing.data[0] ??
        (await stripe.prices.create(
          {
            product: product.id,
            unit_amount: amount,
            currency: "usd",
            recurring: { interval },
            lookup_key: lookup,
          },
          { idempotencyKey: lookup },
        ));
      if (
        price.unit_amount !== amount ||
        price.currency !== "usd" ||
        price.recurring?.interval !== interval
      )
        throw new Error("Existing price differs from the verified plan");
      env[`BILLING_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`] =
        price.id;
    }
  }
  const lookup = "botflow_identity_pro_legacy_100_month_v1";
  const existing = await stripe.prices.list({
    lookup_keys: [lookup],
    limit: 1,
  });
  const legacy =
    existing.data[0] ??
    (await stripe.prices.create(
      {
        product: "botflow_identity_pro_v1",
        unit_amount: 100,
        currency: "usd",
        recurring: { interval: "month" },
        lookup_key: lookup,
      },
      { idempotencyKey: lookup },
    ));
  if (legacy.unit_amount !== 100 || legacy.currency !== "usd")
    throw new Error("Grandfathered price mismatch");
  env.BILLING_PRICE_PRO_LEGACY = legacy.id;
  const configurations = await stripe.billingPortal.configurations.list({
    limit: 100,
  });
  const found = configurations.data.find(
    (c) => c.metadata?.botflow_identity_billing === "v1",
  );
  const portalSettings = {
    business_profile: { headline: "Manage your Botflow subscription" },
    metadata: { botflow_identity_billing: "v1" },
    features: {
      customer_update: {
        enabled: true,
        allowed_updates: ["email", "address", "tax_id"] as ("email" | "address" | "tax_id")[],
      },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end" as const,
        proration_behavior: "none" as const,
      },
      // Native plan changes preserve upgrade/downgrade timing and signed quotes.
      subscription_update: { enabled: false },
    },
  };
  const portal = found
    ? await stripe.billingPortal.configurations.update(found.id, portalSettings)
    : await stripe.billingPortal.configurations.create(portalSettings);
  env.BILLING_PORTAL_CONFIGURATION_ID = portal.id;
  await writeFile(
    envPath,
    Object.entries(env)
      .map(([key, value]) => key + "=" + JSON.stringify(value))
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      mode: live ? "live" : "test",
      pricesConfigured: 5,
      portalConfigured: true,
    }),
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
