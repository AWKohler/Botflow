"use client";
import { useState } from "react";
import {
  BILLING_PLANS,
  type PaidPlan,
  type BillingInterval,
} from "@/lib/billing/plans";
import { useUser } from "./index";
import { CheckoutModal } from "./checkout";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
export function PricingTable(_props: {
  newSubscriptionRedirectUrl?: string;
  ctaPosition?: string;
  appearance?: unknown;
}) {
  void _props;
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [busy, setBusy] = useState<string | null>(null);
  const [checkoutSession, setCheckoutSession] = useState<{
    clientSecret: string;
    plan: PaidPlan;
    interval: BillingInterval;
  } | null>(null);
  const [error, setError] = useState("");
  const { isSignedIn } = useUser();
  async function checkout(plan: PaidPlan) {
    if (!isSignedIn) {
      location.assign("/sign-in?redirect_url=%2Fpricing");
      return;
    }
    setBusy(plan);
    setError("");
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, interval }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setCheckoutSession({ clientSecret: data.clientSecret, plan, interval });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to start checkout");
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="text-fg">
      <div className="mb-7 flex justify-center">
        <Tabs
          options={[
            { value: "month", text: "Monthly" },
            { value: "year", text: "Annually" },
          ]}
          selected={interval}
          onSelect={setInterval}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {Object.entries(BILLING_PLANS).map(([id, plan]) => (
          <section
            key={id}
            className="flex flex-col rounded-xl border border-border bg-surface p-6"
          >
            <h2 className="text-lg font-semibold">{plan.name}</h2>
            <p className="mt-2 min-h-16 text-sm leading-relaxed text-muted">
              {plan.description}
            </p>
            <div className="my-6">
              <span className="text-4xl font-semibold tracking-tight tabular-nums">
                ${(interval === "year" ? plan.annual / 12 : plan.monthly) / 100}
              </span>
              <span className="text-sm text-muted"> / month</span>
              {interval === "year" && plan.annual > 0 && (
                <p className="mt-2 text-xs text-muted">
                  ${plan.annual / 100} billed annually
                </p>
              )}
            </div>
            <Button
              // Paid plans carry the primary action; the free plan is the quiet one.
              variant={id === "free" ? "secondary" : "primary"}
              disabled={busy !== null}
              className="mt-auto h-10 w-full"
              onClick={() =>
                id === "free"
                  ? location.assign(isSignedIn ? "/projects" : "/sign-up")
                  : checkout(id as PaidPlan)
              }
            >
              {busy === id
                ? "Please wait…"
                : id === "free"
                  ? "Get started"
                  : `Subscribe to ${plan.name}`}
            </Button>
          </section>
        ))}
      </div>
      {checkoutSession && (
        <CheckoutModal
          {...checkoutSession}
          onClose={() => setCheckoutSession(null)}
        />
      )}
      {error && (
        <p role="alert" className="mx-auto mt-4 max-w-md rounded-lg border border-danger-border bg-danger-soft px-3 py-2.5 text-center text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
