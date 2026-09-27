"use client";
import { useState, useMemo } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { primaryClass } from "./sign-in";
const key = process.env.NEXT_PUBLIC_BILLING_STRIPE_PUBLISHABLE_KEY;
const stripePromise = key ? loadStripe(key) : null;
function Form({ onSaved }: { onSaved: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!stripe || !elements) return;
        setBusy(true);
        try {
          const result = await stripe.confirmSetup({
            elements,
            confirmParams: {
              return_url: location.origin + "/account?tab=billing",
            },
            redirect: "if_required",
          });
          if (result.error) {
            setMessage(result.error.message ?? "Unable to save card");
            return;
          }
          const method = result.setupIntent.payment_method;
          const response = await fetch("/api/billing/manage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "set-default-payment",
              paymentMethodId: typeof method === "string" ? method : method?.id,
            }),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error);
          onSaved();
        } catch (e) {
          setMessage(e instanceof Error ? e.message : "Unable to save card");
        } finally {
          setBusy(false);
        }
      }}
    >
      <PaymentElement />
      {message && (
        <p role="alert" className="text-sm">
          {message}
        </p>
      )}
      <button disabled={!stripe || busy} className={primaryClass}>
        {busy ? "Saving…" : "Save payment method"}
      </button>
    </form>
  );
}
export function PaymentMethodForm({
  clientSecret,
  onSaved,
}: {
  clientSecret: string;
  onSaved: () => void;
}) {
  const options = useMemo(
    () => ({
      clientSecret,
      appearance: {
        theme: "stripe" as const,
        variables: {
          colorBackground:
            getComputedStyle(document.documentElement)
              .getPropertyValue("--color-surface")
              .trim() || "#faf9f6",
          colorText:
            getComputedStyle(document.documentElement)
              .getPropertyValue("--sand-text")
              .trim() || "#292524",
          borderRadius: "6px",
        },
      },
    }),
    [clientSecret],
  );
  return stripePromise ? (
    <Elements stripe={stripePromise} options={options}>
      <Form onSaved={onSaved} />
    </Elements>
  ) : (
    <p>Payments are not configured.</p>
  );
}
