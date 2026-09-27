import { identityBaseURL } from "@/lib/auth/base-url";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth/server";
import { getIdentityDb } from "@/lib/auth/database";
import { getIdentityUser } from "@/lib/auth/directory";
import { requireSameOrigin } from "@/lib/auth/policy";
import { billingStripe } from "@/lib/billing/stripe";
import { priceId } from "@/lib/billing/plans";
const input = z.object({
  plan: z.enum(["pro", "max"]),
  interval: z.enum(["month", "year"]),
});
export async function POST(request: Request) {
  if (!requireSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const { userId, actor } = await auth();
  if (!userId || actor)
    return NextResponse.json(
      { error: "Sign in with your own account to manage billing" },
      { status: 403 },
    );
  const body = input.safeParse(await request.json().catch(() => null));
  if (!body.success)
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  const connection = await getIdentityDb().connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `billing:${userId}`,
    ]);
    const { rows } = await connection.query(
      "SELECT * FROM botflow_subscription WHERE user_id=$1 FOR UPDATE",
      [userId],
    );
    const existing = rows[0];
    if (
      existing &&
      existing.plan !== "free" &&
      !["canceled", "incomplete_expired", "ended"].includes(existing.status)
    ) {
      await connection.query("ROLLBACK");
      return NextResponse.json(
        {
          error:
            existing.source === "clerk"
              ? "Your existing subscription is being migrated. Your current access and price are preserved."
              : "Manage your existing subscription from Billing in your account.",
        },
        { status: 409 },
      );
    }
    // Even a canceled legacy subscription may still have paid time remaining.
    if (
      existing?.source === "clerk" &&
      existing.plan !== "free" &&
      existing.period_end &&
      new Date(existing.period_end).getTime() > Date.now()
    ) {
      await connection.query("ROLLBACK");
      return NextResponse.json(
        {
          error:
            "Your existing paid period must be reconciled before a new subscription is created.",
        },
        { status: 409 },
      );
    }
    const stripe = billingStripe();
    let customerId = existing?.stripe_customer_id as string | undefined;
    if (!customerId) {
      const user = await getIdentityUser(userId);
      const customer = await stripe.customers.create(
        {
          email: user.primaryEmailAddress.emailAddress,
          name: [user.firstName, user.lastName].filter(Boolean).join(" "),
          metadata: { botflow_user_id: userId },
        },
        { idempotencyKey: `botflow-customer-v1:${userId}` },
      );
      customerId = customer.id;
      await connection.query(
        `INSERT INTO botflow_subscription (user_id,source,stripe_customer_id,plan,status) VALUES ($1,'stripe',$2,'free','active') ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id=$2`,
        [userId, customerId],
      );
    }
    const active = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    });
    if (
      active.data.some(
        (s) => !["canceled", "incomplete_expired"].includes(s.status),
      )
    ) {
      await connection.query("COMMIT");
      return NextResponse.json(
        {
          error:
            "An existing subscription needs to be managed from your account.",
        },
        { status: 409 },
      );
    }
    const open = await stripe.checkout.sessions.list({
      customer: customerId,
      status: "open",
      limit: 100,
    });
    const pending = open.data.find(
      (s) =>
        s.mode === "subscription" && s.metadata?.botflow_user_id === userId,
    );
    if (
      pending &&
      (pending.metadata?.plan !== body.data.plan ||
        pending.metadata?.interval !== body.data.interval)
    )
      await stripe.checkout.sessions.expire(pending.id);
    const baseURL = identityBaseURL();
    const session =
      pending &&
      pending.metadata?.plan === body.data.plan &&
      pending.metadata?.interval === body.data.interval
        ? pending
        : await stripe.checkout.sessions.create({
            mode: "subscription",
            ui_mode: "custom",
            customer: customerId,
            client_reference_id: userId,
            line_items: [
              {
                price: priceId(body.data.plan, body.data.interval),
                quantity: 1,
              },
            ],
            metadata: { botflow_user_id: userId, ...body.data },
            subscription_data: { metadata: { botflow_user_id: userId } },
            return_url: `${baseURL}/account?tab=billing&checkout=success`,
          });
    await connection.query("COMMIT");
    return NextResponse.json({ clientSecret: session.client_secret });
  } catch (error) {
    await connection.query("ROLLBACK");
    console.error(
      "[billing] Checkout could not be created",
      error instanceof Error ? error.name : "error",
    );
    return NextResponse.json(
      { error: "Billing is temporarily unavailable. Please try again later." },
      { status: 503 },
    );
  } finally {
    connection.release();
  }
}
