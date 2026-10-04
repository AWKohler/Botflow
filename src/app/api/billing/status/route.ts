import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import { getSubscription } from "@/lib/billing/entitlements";
export async function GET() {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const subscription = await getSubscription(userId);
  return NextResponse.json(
    {
      subscription: subscription
        ? {
            plan: subscription.plan,
            status: subscription.status,
            amount: subscription.amount,
            currency: subscription.currency,
            interval: subscription.interval,
            periodEnd: subscription.period_end,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            migrationPending:
              subscription.source === "clerk" && subscription.plan !== "free",
          }
        : null,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
