/**
 * POST /api/webhooks/apple  { signedPayload }
 *
 * App Store Server Notifications (version 2): Apple reports renewals,
 * expirations and refunds for subscriptions bought in the iOS app, so a plan
 * stays right when the app is not opened. The payload is a JWS signed by
 * Apple; an unsigned or foreign payload is rejected, and a subscription we
 * have no record of is ignored.
 */
import { NextResponse } from "next/server";
import {
  AppStoreError,
  applyAppleUpdate,
  environmentAllowed,
  verifyAppStoreJws,
  type AppStoreTransaction,
} from "@/lib/native/app-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Notification {
  notificationType?: string;
  data?: { bundleId?: string; environment?: string; signedTransactionInfo?: string };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { signedPayload?: unknown } | null;
  const signedPayload = typeof body?.signedPayload === "string" ? body.signedPayload : "";
  if (!signedPayload || signedPayload.length > 100_000) {
    return NextResponse.json({ error: "signedPayload is required" }, { status: 400 });
  }
  try {
    const notification = verifyAppStoreJws<Notification>(signedPayload);
    const signedTransaction = notification.data?.signedTransactionInfo;
    if (!signedTransaction || !environmentAllowed(notification.data?.environment ?? "")) {
      return NextResponse.json({ ok: true, applied: false });
    }
    const transaction = verifyAppStoreJws<AppStoreTransaction>(signedTransaction);
    const applied = await applyAppleUpdate(transaction);
    return NextResponse.json({ ok: true, applied });
  } catch (error) {
    if (error instanceof AppStoreError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error("POST /api/webhooks/apple failed:", error);
    // A 5xx makes Apple retry later.
    return NextResponse.json({ error: "Could not process the notification" }, { status: 500 });
  }
}
