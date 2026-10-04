"use client";
import { useState } from "react";
import {
  BILLING_PLANS,
  type PaidPlan,
  type BillingInterval,
} from "@/lib/billing/plans";
import { useUser } from "./index";
import { CheckoutModal } from "./checkout";
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
    <div className="text-[var(--sand-text)]">
      <div className="mb-7 flex justify-center">
        <div className="inline-flex rounded-lg border border-[var(--sand-border)] p-1">
          {(["month", "year"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={interval === value}
              onClick={() => setInterval(value)}
              className={`rounded-md px-4 py-2 text-sm ${interval === value ? "bg-[var(--sand-elevated)] font-medium" : "text-[var(--sand-text-muted)]"}`}
            >
              {value === "month" ? "Monthly" : "Annually"}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {Object.entries(BILLING_PLANS).map(([id, plan]) => (
          <section
            key={id}
            className="flex flex-col rounded-xl border border-[var(--sand-border)] bg-[var(--color-surface)] p-6"
          >
            <h2 className="text-xl font-semibold">{plan.name}</h2>
            <p className="mt-3 min-h-16 text-sm text-[var(--sand-text-muted)]">
              {plan.description}
            </p>
            <div className="my-6">
              <span className="text-4xl font-semibold tracking-tight">
                ${(interval === "year" ? plan.annual / 12 : plan.monthly) / 100}
              </span>
              <span className="text-sm text-[var(--sand-text-muted)]">
                {" "}
                / month
              </span>
              {interval === "year" && plan.annual > 0 && (
                <p className="mt-2 text-xs text-[var(--sand-text-muted)]">
                  ${plan.annual / 100} billed annually
                </p>
              )}
            </div>
            <button
              disabled={busy !== null}
              className="mt-auto w-full rounded-md bg-[var(--sand-text)] px-4 py-2.5 text-sm font-medium text-[var(--sand-bg)] disabled:opacity-50"
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
            </button>
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
        <p role="alert" className="mt-4 text-center text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
