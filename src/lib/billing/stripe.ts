import Stripe from "stripe";
let instance: Stripe | undefined;
export function billingStripe(): Stripe {
  const key = process.env.BILLING_STRIPE_SECRET_KEY;
  if (!key) throw new Error("BILLING_STRIPE_SECRET_KEY is required");
  const live = process.env.BILLING_STRIPE_MODE === "live";
  if (live !== key.includes("_live_"))
    throw new Error("Billing key mode does not match BILLING_STRIPE_MODE");
  if (process.env.VERCEL_ENV === "preview" && live)
    throw new Error("Preview deployments must use Stripe test mode");
  return (instance ??= new Stripe(key, {
    apiVersion: "2025-08-27.basil",
    typescript: true,
  }));
}
