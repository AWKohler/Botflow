/**
 * POST /api/native/purchases/apple  { signedTransaction }
 *
 * The iOS app bought (or restored, or renewed) a plan through the App Store
 * and presents Apple's signed transaction. Once the signature checks out the
 * subscription is recorded against the caller, and their plan follows it.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import { getPaidTier } from "@/lib/billing/entitlements";
import { AppStoreError, recordAppleTransaction, verifyAppStoreJws, type AppStoreTransaction } from "@/lib/native/app-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { signedTransaction?: unknown } | null;
  const jws = typeof body?.signedTransaction === "string" ? body.signedTransaction : "";
  if (!jws || jws.length > 20_000) {
    return NextResponse.json({ error: "signedTransaction is required" }, { status: 400 });
  }
  try {
    const transaction = verifyAppStoreJws<AppStoreTransaction>(jws);
    const row = await recordAppleTransaction(userId, transaction);
    return NextResponse.json({
      ok: true,
      tier: await getPaidTier(userId),
      plan: row.plan,
      expiresAt: new Date(row.expires_at).toISOString(),
    });
  } catch (error) {
    if (error instanceof AppStoreError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("POST /api/native/purchases/apple failed:", error);
    return NextResponse.json({ error: "Could not record the purchase" }, { status: 500 });
  }
}
