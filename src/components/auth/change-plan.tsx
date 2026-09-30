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
      className="fixed inset-0 m-auto w-full max-w-md rounded-xl border border-[var(--sand-border)] bg-[var(--color-surface)] p-7 text-[var(--sand-text)] shadow-xl backdrop:bg-black/40"
    >
      <button
        aria-label="Close plan change"
        disabled={busy}
        className="absolute right-4 top-3 text-xl"
        onClick={() => ref.current?.close()}
      >
        ×
      </button>
      <h2 className="text-xl font-semibold">Change plan</h2>
      <p className="mt-2 text-sm text-[var(--sand-text-muted)]">
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
        <label className="block text-sm">
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
        <label className="block text-sm">
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
          <div className="rounded-md border border-[var(--sand-border)] p-4 text-sm">
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
          <p role="alert" className="text-sm">
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
