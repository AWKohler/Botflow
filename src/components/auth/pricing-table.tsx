"use client";
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  BILLING_PLANS,
  type PaidPlan,
  type BillingInterval,
} from "@/lib/billing/plans";
import { useUser } from "./index";
import { CheckoutModal } from "./checkout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

// What each plan is for and what it adds. Mirrors the comparison table on
// the pricing page so the cards and the table can't disagree.
const PLAN_DETAILS: Record<string, { tagline: string; highlights: string[] }> = {
  free: {
    tagline: "Build with your own ChatGPT or Claude sign-in, or your own API keys.",
    highlights: ["3 active projects", "Bring your own model keys", "One-click deploy and GitHub sync"],
  },
  pro: {
    tagline: "For building regularly, with model credits included.",
    highlights: ["20 active projects", "Monthly model credits", "Custom domains"],
  },
  max: {
    tagline: "For heavy use and apps in production.",
    highlights: ["Unlimited projects", "The largest monthly credit allowance", "Priority support"],
  },
};

export function PricingTable(props: {
  newSubscriptionRedirectUrl?: string;
  ctaPosition?: string;
  appearance?: unknown;
  /** Tighter cards for use inside a dialog. */
  compact?: boolean;
}) {
  const { compact = false } = props;
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [busy, setBusy] = useState<string | null>(null);
  const [checkoutSession, setCheckoutSession] = useState<{
    clientSecret: string;
    plan: PaidPlan;
    interval: BillingInterval;
  } | null>(null);
  const [error, setError] = useState("");
  const { isSignedIn } = useUser();
  // The signed-in user's plan, so their card can say "Current plan".
  const [currentPlan, setCurrentPlan] = useState<string | null>(null);
  useEffect(() => {
    if (!isSignedIn) {
      setCurrentPlan(null);
      return;
    }
    let cancelled = false;
    fetch("/api/billing/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setCurrentPlan(data?.subscription?.plan ?? "free");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

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
        {Object.entries(BILLING_PLANS).map(([id, plan]) => {
          const details = PLAN_DETAILS[id];
          const isCurrent = currentPlan === id;
          const monthly = (interval === "year" ? plan.annual / 12 : plan.monthly) / 100;
          return (
            <section
              key={id}
              className={cn(
                "flex flex-col rounded-xl border bg-surface",
                compact ? "p-5" : "p-6",
                isCurrent ? "border-border-strong" : "border-border",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{plan.name}</h2>
                {isCurrent && <Badge>Current plan</Badge>}
              </div>
              {/* Fixed-height slot so prices and buttons line up across cards. */}
              <p className={cn("mt-2 text-sm leading-snug text-muted", compact ? "min-h-[3.9rem]" : "min-h-[2.75rem]")}>
                {details?.tagline ?? plan.description}
              </p>
              <div className={compact ? "mt-4" : "mt-5"}>
                <span className={cn("font-semibold tracking-tight tabular-nums", compact ? "text-3xl" : "text-4xl")}>
                  {"$" + monthly}
                </span>
                <span className="text-sm text-muted"> / month</span>
                <p className="mt-1 h-4 text-xs text-muted">
                  {interval === "year" && plan.annual > 0 ? "$" + plan.annual / 100 + " billed annually" : ""}
                </p>
              </div>
              <Button
                // Paid plans carry the primary action; the free plan is the quiet one.
                variant={id === "free" || isCurrent ? "secondary" : "primary"}
                disabled={busy !== null || isCurrent}
                className="mt-4 h-10 w-full"
                onClick={() =>
                  id === "free"
                    ? location.assign(isSignedIn ? "/projects" : "/sign-up")
                    : checkout(id as PaidPlan)
                }
              >
                {isCurrent
                  ? "Current plan"
                  : busy === id
                    ? "Please wait…"
                    : id === "free"
                      ? "Get started"
                      : "Subscribe to " + plan.name}
              </Button>
              {details && (
                <ul className="mt-5 space-y-2 border-t border-border pt-4 text-[13px] text-fg">
                  {details.highlights.map((item) => (
                    <li key={item} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                      {item}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
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
