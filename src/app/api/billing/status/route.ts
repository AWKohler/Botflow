import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import { getSubscription } from "@/lib/billing/entitlements";
import { getActiveAppleSubscription } from "@/lib/native/app-store";
export async function GET() {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [subscription, appStore] = await Promise.all([getSubscription(userId), getActiveAppleSubscription(userId)]);
  return NextResponse.json(
    {
      // A plan bought in the iOS app; managed in the person's Apple Account.
      appStore: appStore
        ? { plan: appStore.plan, interval: appStore.interval, expiresAt: appStore.expires_at }
        : null,
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
