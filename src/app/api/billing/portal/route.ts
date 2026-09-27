import { identityBaseURL } from "@/lib/auth/base-url";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import { requireSameOrigin } from "@/lib/auth/policy";
import { billingStripe } from "@/lib/billing/stripe";
import { getSubscription } from "@/lib/billing/entitlements";
export async function POST(request: Request) {
  if (!requireSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const { userId, actor } = await auth();
  if (!userId || actor)
    return NextResponse.json(
      { error: "Sign in with your own account to manage billing" },
      { status: 403 },
    );
  const subscription = await getSubscription(userId);
  if (
    !subscription ||
    subscription.source !== "stripe" ||
    !subscription.stripe_customer_id
  )
    return NextResponse.json(
      { error: "No migrated Stripe billing account is available yet." },
      { status: 409 },
    );
  try {
    const session = await billingStripe().billingPortal.sessions.create({
      customer: subscription.stripe_customer_id,
      return_url: `${identityBaseURL()}/account?tab=billing`,
      configuration: process.env.BILLING_PORTAL_CONFIGURATION_ID,
    });
    return NextResponse.json({ url: session.url });
  } catch {
    return NextResponse.json(
      { error: "Billing is temporarily unavailable" },
      { status: 503 },
    );
  }
}
