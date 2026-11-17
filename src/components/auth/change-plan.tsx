"use client";
import { useEffect, useRef, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  BILLING_PLANS,
  type PaidPlan,
  type BillingInterval,
} from "@/lib/billing/plans";
import { fieldClass, primaryClass } from "./sign-in";
interface Quote {
  token: string;
  plan: PaidPlan;
  interval: BillingInterval;
  amountDue: number;
  recurringAmount: number;
  currency: string;
  effectiveAt: number;
  scheduled: boolean;
}
const stripePromise = process.env.NEXT_PUBLIC_BILLING_STRIPE_PUBLISHABLE_KEY
  ? loadStripe(process.env.NEXT_PUBLIC_BILLING_STRIPE_PUBLISHABLE_KEY)
  : null;
const money = (amount: number, currency = "usd") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    amount / 100,
  );
export function ChangePlanModal({
  currentPlan,
  currentInterval,
  onClose,
  onSaved,
}: {
  currentPlan: string;
  currentInterval: string;
  onClose: () => void;
  onSaved: (change: Pick<Quote, "plan" | "interval" | "scheduled">) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [plan, setPlan] = useState<PaidPlan>(
    currentPlan === "max" ? "pro" : "max",
  );
  const [interval, setInterval] = useState<BillingInterval>(
    currentInterval === "year" ? "year" : "month",
  );
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/billing/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          quote
            ? { action: "apply", token: quote.token }
            : { action: "preview", plan, interval },
        ),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (!quote) {
        setQuote(data);
        return;
      }
      if (data.pendingPayment) {
        if (!data.clientSecret)
          throw new Error(
            "Payment needs attention. Update your payment method and try again.",
          );
        const stripe = await stripePromise;
        if (!stripe) throw new Error("Payment confirmation unavailable");
        const result = await stripe.confirmCardPayment(data.clientSecret);
        if (result.error) throw new Error(result.error.message);
      }
      onSaved(quote);
      ref.current?.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to change your plan");
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-bg p-6 text-fg shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-[2px]"
    >
      <button
        aria-label="Close plan change"
        disabled={busy}
        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-lg leading-none text-muted transition-colors hover:bg-elevated hover:text-fg"
        onClick={() => ref.current?.close()}
      >
        ×
      </button>
      <h2 className="text-base font-semibold">Change plan</h2>
      <p className="mt-2 text-sm text-muted">
        Upgrades start immediately. Downgrades start when your current billing
        period ends.
      </p>
      <form
        className="mt-5 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="block text-[13px] font-medium">
          Plan
          <select
            className={fieldClass}
            value={plan}
            disabled={busy}
            onChange={(e) => {
              setPlan(e.target.value as PaidPlan);
              setQuote(null);
            }}
          >
            {(["pro", "max"] as const).map((p) => (
              <option key={p} value={p}>
                {BILLING_PLANS[p].name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[13px] font-medium">
          Billing period
          <select
            className={fieldClass}
            value={interval}
            disabled={busy}
            onChange={(e) => {
              setInterval(e.target.value as BillingInterval);
              setQuote(null);
            }}
          >
            <option value="month">Monthly</option>
            <option value="year">Annually</option>
          </select>
        </label>
        {quote && (
          <div className="rounded-lg border border-border bg-surface p-4 text-sm">
            <p>
              {money(quote.recurringAmount, quote.currency)} / {quote.interval}
            </p>
            <p className="mt-2">
              Due today:{" "}
              <strong>{money(quote.amountDue, quote.currency)}</strong>
            </p>
            <p className="mt-2">
              {quote.scheduled
                ? `Starts ${new Date(quote.effectiveAt * 1000).toLocaleDateString()}. You keep your current plan until then.`
                : "Starts immediately after payment succeeds. Unused time on your current plan is credited in this quote."}
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
            {error}
          </p>
        )}
        <button disabled={busy} className={primaryClass}>
          {busy
            ? "Please wait…"
            : quote
              ? "Confirm plan change"
              : "Review change"}
        </button>
      </form>
    </dialog>
  );
}
