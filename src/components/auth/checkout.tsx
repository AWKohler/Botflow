"use client";
import { useMemo, useRef, useEffect, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  CheckoutProvider,
  PaymentElement,
  useCheckout,
} from "@stripe/react-stripe-js/checkout";
import {
  BILLING_PLANS,
  type PaidPlan,
  type BillingInterval,
} from "@/lib/billing/plans";
import { primaryClass } from "./sign-in";
const key = process.env.NEXT_PUBLIC_BILLING_STRIPE_PUBLISHABLE_KEY;
const stripePromise = key ? loadStripe(key) : null;
function CheckoutForm() {
  const state = useCheckout();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (state.type === "loading")
    return <p className="text-sm">Loading secure checkout…</p>;
  if (state.type === "error")
    return (
      <p role="alert" className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
        {state.error.message}
      </p>
    );
  const { checkout } = state;
  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage("");
        try {
          const result = await checkout.confirm({ redirect: "if_required" });
          if (result.type === "error") setMessage(result.error.message);
          else location.assign("/account?tab=billing&checkout=success");
        } catch {
          setMessage("Payment could not be completed. Please try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <PaymentElement options={{ layout: "tabs" }} />
      <div className="flex justify-between border-t border-border pt-4 text-sm">
        <span>Due today</span>
        <strong>{checkout.total.total.amount}</strong>
      </div>
      {message && (
        <p role="alert" className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
          {message}
        </p>
      )}
      <button disabled={busy} className={primaryClass}>
        {busy ? "Processing…" : "Subscribe"}
      </button>
      <p className="text-xs text-muted">
        Your subscription renews automatically. You can cancel from your
        account.
      </p>
    </form>
  );
}
export function CheckoutModal({
  clientSecret,
  plan,
  interval,
  onClose,
}: {
  clientSecret: string;
  plan: PaidPlan;
  interval: BillingInterval;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const options = useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      fetchClientSecret: async () => clientSecret,
      elementsOptions: {
        appearance: {
          theme: "stripe" as const,
          variables: {
            colorPrimary:
              style.getPropertyValue("--sand-text").trim() || "#292524",
            colorBackground:
              style.getPropertyValue("--color-surface").trim() || "#faf9f6",
            colorText:
              style.getPropertyValue("--sand-text").trim() || "#292524",
            borderRadius: "6px",
            fontFamily: "Arial, sans-serif",
          },
          rules: {
            ".Input": {
              borderColor:
                style.getPropertyValue("--sand-border").trim() || "#d6d3ce",
              boxShadow: "none",
            },
          },
        },
      },
    };
  }, [clientSecret]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-border bg-bg p-6 text-fg shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-[2px]"
    >
      <button
        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-lg leading-none text-muted transition-colors hover:bg-elevated hover:text-fg"
        aria-label="Close checkout"
        onClick={() => ref.current?.close()}
      >
        ×
      </button>
      <h2 className="text-base font-semibold">
        Subscribe to {BILLING_PLANS[plan].name}
      </h2>
      <p className="mb-6 mt-2 text-sm text-muted">
        $
        {(interval === "month"
          ? BILLING_PLANS[plan].monthly
          : BILLING_PLANS[plan].annual) / 100}{" "}
        / {interval}
      </p>
      {stripePromise ? (
        <CheckoutProvider stripe={stripePromise} options={options}>
          <CheckoutForm />
        </CheckoutProvider>
      ) : (
        <p>Checkout is not configured.</p>
      )}
    </dialog>
  );
}
