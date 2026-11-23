/**
 * POST   /api/native/devices  { token, environment, bundleId? }: register this device for pushes
 * DELETE /api/native/devices  [{ token }]: forget one device, or all of the caller's (sign-out)
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import { DEFAULT_BUNDLE_ID, isApnsConfigured } from "@/lib/native/apns";
import { APNS_TOKEN_PATTERN, registerDevice, removeAllDevices, removeDevice } from "@/lib/native/devices";

export const dynamic = "force-dynamic";

const BUNDLE_IDS = new Set([DEFAULT_BUNDLE_ID]);

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { token?: unknown; environment?: unknown; bundleId?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.toLowerCase() : "";
  if (!APNS_TOKEN_PATTERN.test(token)) {
    return NextResponse.json({ error: "A valid device token is required" }, { status: 400 });
  }
  const environment = body?.environment === "development" ? "development" : "production";
  const bundleId = typeof body?.bundleId === "string" && BUNDLE_IDS.has(body.bundleId) ? body.bundleId : DEFAULT_BUNDLE_ID;
  try {
    await registerDevice(userId, { token, environment, bundleId });
    // `push` tells the app whether this server can reach it; when it cannot,
    // the app raises its own notifications for turns it sees end.
    return NextResponse.json({ ok: true, push: isApnsConfigured() });
  } catch (err) {
    console.error("POST /api/native/devices failed:", err);
    return NextResponse.json({ error: "Could not register the device" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  try {
    if (typeof body?.token === "string" && APNS_TOKEN_PATTERN.test(body.token.toLowerCase())) {
      await removeDevice(userId, body.token.toLowerCase());
    } else {
      await removeAllDevices(userId);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/native/devices failed:", err);
    return NextResponse.json({ error: "Could not remove the device" }, { status: 500 });
  }
}
