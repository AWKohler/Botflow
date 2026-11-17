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

/** Monthly model-credit allowance of the paid plans, read on the server. */
export interface PlanCredits {
  pro: number;
  max: number;
}

/** 40000000 → "40M", 6500000 → "6.5M". */
export function formatCredits(n: number): string {
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return String(n);
}

// What each plan is for and what it adds over the one before it, so the three
// lists read as steps rather than three unrelated feature sets.
function planDetails(credits?: PlanCredits): Record<string, { tagline: string; includes?: string; highlights: string[] }> {
  const multiple = credits && credits.pro > 0 ? credits.max / credits.pro : 0;
  return {
    free: {
      tagline: "Build with your own ChatGPT or Claude sign-in, or your own API keys.",
      highlights: [
        "3 active projects",
        "Bring your own model sign-in or keys",
        "A small monthly credit allowance",
        "One-click deploy and GitHub sync",
      ],
    },
    pro: {
      tagline: "For building regularly, with model credits included.",
      includes: "Everything in Free, plus",
      highlights: [
        "20 active projects",
        credits ? `${formatCredits(credits.pro)} model credits a month` : "Monthly model credits",
        "Custom domains",
        "Sharing projects with collaborators",
      ],
    },
    max: {
      tagline: "For heavy use and apps in production.",
      includes: "Everything in Pro, plus",
      highlights: [
        "Unlimited projects",
        credits
          ? `${formatCredits(credits.max)} model credits a month` +
            (Number.isInteger(multiple) && multiple > 1 ? ` (${multiple}× Pro)` : "")
          : "The largest monthly credit allowance",
        "Priority support",
      ],
    },
  };
}

export function PricingTable(props: {
  newSubscriptionRedirectUrl?: string;
  ctaPosition?: string;
  appearance?: unknown;
  /** Real monthly credit allowances, when the page can supply them. */
  credits?: PlanCredits;
}) {
  const PLAN_DETAILS = planDetails(props.credits);
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [busy, setBusy] = useState<string | null>(null);
  const [checkoutSession, setCheckoutSession] = useState<{
    clientSecret: string;
    plan: PaidPlan;
    interval: BillingInterval;
  } | null>(null);
  const [error, setError] = useState("");
  const { isSignedIn, isLoaded } = useUser();
  // The signed-in user's plan, so their card can say "Current plan". Until it
  // is known the cards show no action at all, never a wrong one.
  const [currentPlan, setCurrentPlan] = useState<string | null>(null);
  const [planLookupFailed, setPlanLookupFailed] = useState(false);
  const planKnown = isLoaded && (!isSignedIn || currentPlan !== null || planLookupFailed);
  useEffect(() => {
    if (!isSignedIn) {
      setCurrentPlan(null);
      return;
    }
    let cancelled = false;
    fetch("/api/billing/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data) setCurrentPlan(data.subscription?.plan ?? "free");
        else setPlanLookupFailed(true);
      })
      .catch(() => {
        if (!cancelled) setPlanLookupFailed(true);
      });
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
                "flex flex-col rounded-xl border bg-surface p-6",
                isCurrent ? "border-border-strong" : "border-border",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{plan.name}</h2>
                {isCurrent && <Badge>Current plan</Badge>}
              </div>
              {/* Fixed-height slot so prices and buttons line up across cards. */}
              <p className="mt-2 min-h-[2.75rem] text-sm leading-snug text-muted">
                {details?.tagline ?? plan.description}
              </p>
              <div className="mt-5">
                <span className="text-4xl font-semibold tracking-tight tabular-nums">{"$" + monthly}</span>
                <span className="text-sm text-muted"> / month</span>
                <p className="mt-1 h-4 text-xs text-muted">
                  {interval === "year" && plan.annual > 0 ? "$" + plan.annual / 100 + " billed annually" : ""}
                </p>
              </div>
              {planKnown ? (
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
              ) : (
                <div aria-hidden="true" className="mt-4 h-10 w-full animate-pulse rounded-lg bg-soft" />
              )}
              {details && (
                <div className="mt-5 border-t border-border pt-4">
                  {/* Same slot on every card, so the lists start on one line. */}
                  <p className="h-5 text-xs font-medium text-muted">{details.includes ?? "Includes"}</p>
                  <ul className="mt-2 space-y-2 text-[13px] text-fg">
                    {details.highlights.map((item) => (
                      <li key={item} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
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
