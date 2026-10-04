import { paymentHistory } from "@/lib/billing/payment-history";
import { planForPrice } from "@/lib/billing/plans";
import { ensureFreeBillingCustomer } from "@/lib/billing/customer";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth/server";
import { requireSameOrigin } from "@/lib/auth/policy";
import { getSubscription } from "@/lib/billing/entitlements";
import { billingStripe } from "@/lib/billing/stripe";
import { getIdentityDb } from "@/lib/auth/database";
export async function GET() {
  const { userId, actor } = await auth();
  if (!userId || actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const row = await getSubscription(userId);
  if (!row?.stripe_customer_id || row.source !== "stripe")
    return NextResponse.json({ invoices: [], paymentMethods: [] });
  const stripe = billingStripe();
  const [invoices, methods, customer, subscription] = await Promise.all([
    paymentHistory(
      stripe,
      row.stripe_customer_id,
      row.legacy_billing_cutover_at,
    ),
    stripe.paymentMethods.list({
      customer: row.stripe_customer_id,
      type: "card",
      limit: 20,
    }),
    stripe.customers.retrieve(row.stripe_customer_id),
    row.stripe_subscription_id
      ? stripe.subscriptions.retrieve(row.stripe_subscription_id)
      : null,
  ]);
  let upcomingPlan = null;
  if (subscription?.schedule) {
    const schedule = await stripe.subscriptionSchedules.retrieve(
      typeof subscription.schedule === "string"
        ? subscription.schedule
        : subscription.schedule.id,
    );
    const next = schedule.phases.find(
      (phase) => phase.start_date > Date.now() / 1000,
    );
    if (next?.items[0]) {
      const price = await stripe.prices.retrieve(
        typeof next.items[0].price === "string"
          ? next.items[0].price
          : next.items[0].price.id,
      );
      upcomingPlan = {
        plan: planForPrice(price.id),
        interval: price.recurring?.interval,
        amount: price.unit_amount,
        effectiveAt: next.start_date,
      };
    }
  }
  return NextResponse.json(
    {
      upcomingPlan,
      invoices,
      paymentMethods: methods.data.map((m) => ({
        id: m.id,
        brand: m.card?.brand,
        last4: m.card?.last4,
        expiryMonth: m.card?.exp_month,
        expiryYear: m.card?.exp_year,
        isDefault:
          !customer.deleted &&
          (subscription?.default_payment_method ||
            customer.invoice_settings.default_payment_method) === m.id,
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("cancel-plan-change") }),
  z.object({ action: z.literal("setup-payment") }),
  z.object({
    action: z.literal("remove-payment"),
    paymentMethodId: z.string().startsWith("pm_"),
  }),
  z.object({
    action: z.literal("set-default-payment"),
    paymentMethodId: z.string().startsWith("pm_"),
  }),
]);
export async function POST(request: Request) {
  if (!requireSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const { userId, actor } = await auth();
  if (!userId || actor)
    return NextResponse.json(
      { error: "Manage billing from your own account" },
      { status: 403 },
    );
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid billing action" },
      { status: 400 },
    );
  try {
    let row = await getSubscription(userId);
    if (
      parsed.data.action === "setup-payment" &&
      (!row || row.plan === "free")
    ) {
      await ensureFreeBillingCustomer(userId);
      row = await getSubscription(userId);
    }
    if (!row?.stripe_customer_id || row.source !== "stripe")
      return NextResponse.json(
        { error: "Your billing migration must finish before making changes." },
        { status: 409 },
      );
    const stripe = billingStripe();
    const action = parsed.data;
    if (action.action === "setup-payment") {
      const intent = await stripe.setupIntents.create({
        customer: row.stripe_customer_id,
        payment_method_types: ["card"],
        usage: "off_session",
        metadata: { botflow_user_id: userId },
      });
      return NextResponse.json({ clientSecret: intent.client_secret });
    }
    if (
      action.action === "set-default-payment" ||
      action.action === "remove-payment"
    ) {
      const method = await stripe.paymentMethods.retrieve(
        action.paymentMethodId,
      );
      if (method.customer !== row.stripe_customer_id)
        return NextResponse.json(
          { error: "Payment method does not belong to your billing account" },
          { status: 403 },
        );
      const subscription = row.stripe_subscription_id
        ? await stripe.subscriptions.retrieve(row.stripe_subscription_id)
        : null;
      const active =
        subscription &&
        !["canceled", "incomplete_expired"].includes(subscription.status);
      if (action.action === "remove-payment") {
        const customer = await stripe.customers.retrieve(
          row.stripe_customer_id,
        );
        const currentDefault =
          subscription?.default_payment_method ||
          (!customer.deleted &&
            customer.invoice_settings.default_payment_method);
        if (active && currentDefault === method.id)
          return NextResponse.json(
            {
              error:
                "Choose another default payment method before removing this card.",
            },
            { status: 409 },
          );
        await stripe.paymentMethods.detach(method.id);
      } else {
        await stripe.customers.update(row.stripe_customer_id, {
          invoice_settings: { default_payment_method: method.id },
        });
        if (active)
          await stripe.subscriptions.update(subscription.id, {
            default_payment_method: method.id,
          });
      }
      return NextResponse.json({ ok: true });
    }
    if (!row.stripe_subscription_id)
      return NextResponse.json(
        { error: "No active subscription" },
        { status: 409 },
      );
    const current = await stripe.subscriptions.retrieve(
      row.stripe_subscription_id,
    );
    if (!["active", "trialing", "past_due"].includes(current.status))
      return NextResponse.json(
        { error: "This subscription cannot be changed" },
        { status: 409 },
      );
    if (current.schedule) {
      const schedule = await stripe.subscriptionSchedules.retrieve(
        typeof current.schedule === "string"
          ? current.schedule
          : current.schedule.id,
      );
      if (schedule.metadata?.botflow_user_id !== userId)
        return NextResponse.json(
          { error: "A scheduled change needs support before this action." },
          { status: 409 },
        );
      await stripe.subscriptionSchedules.release(schedule.id);
    }
    if (action.action === "cancel-plan-change")
      return NextResponse.json({ ok: true });
    const updated = await stripe.subscriptions.update(current.id, {
      cancel_at_period_end: action.action === "cancel",
    });
    await getIdentityDb().query(
      "UPDATE botflow_subscription SET cancel_at_period_end=$2,updated_at=now() WHERE user_id=$1",
      [userId, updated.cancel_at_period_end],
    );
    return NextResponse.json({
      ok: true,
      cancelAtPeriodEnd: updated.cancel_at_period_end,
    });
  } catch (error) {
    console.error(
      "[billing] Account action failed",
      error instanceof Error ? error.name : "error",
    );
    return NextResponse.json(
      { error: "Unable to update billing. Please try again." },
      { status: 503 },
    );
  }
}
