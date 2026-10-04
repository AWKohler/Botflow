export const BILLING_PLANS = {
  free: {
    name: "Free",
    monthly: 0,
    annual: 0,
    description:
      "Sign in with your ChatGPT or Claude account for usage free of charge! Includes limited free usage as well. Best for SSO, and BYOK.",
  },
  pro: {
    name: "Pro",
    monthly: 2000,
    annual: 20400,
    description: "Higher limits",
  },
  max: {
    name: "Max",
    monthly: 6000,
    annual: 60000,
    description: "Highest limits",
  },
} as const;
export type PaidPlan = "pro" | "max";
export type BillingInterval = "month" | "year";
export function priceId(plan: PaidPlan, interval: BillingInterval): string {
  const value =
    process.env[
      `BILLING_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`
    ];
  if (!value?.startsWith("price_"))
    throw new Error("Billing prices are not configured");
  return value;
}
export function planForPrice(id: string): PaidPlan | null {
  for (const plan of ["pro", "max"] as const)
    for (const interval of ["month", "year"] as const) {
      if (
        process.env[
          `BILLING_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`
        ] === id
      )
        return plan;
    }
  // Explicit mapping for imported grandfathered contracts; never infer from dollar amounts.
  if (process.env.BILLING_PRICE_PRO_LEGACY === id) return "pro";
  return null;
}
