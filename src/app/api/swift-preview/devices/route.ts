import { auth } from "@/lib/auth/server";
import { NextResponse } from "next/server";
import { simulatorProvider } from "@/lib/simulator-provider";
import { availableSimDevices } from "@/lib/sim-hosts/routing";
import { BASE_SIM_DEVICE_MODELS } from "@/lib/sim-platform";

export const dynamic = "force-dynamic";

/**
 * The devices this user can start a simulator on: the iPhone and the iPad
 * always, plus whatever else a host that may serve them has (the iPhone Duo
 * needs a Mac that can run it).
 *
 * Kept apart from /api/swift-preview/config because it asks the simulator
 * hosts how they are, which can take a moment: the preview must not wait on
 * that to appear, only the device picker's extra entry does.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let devices = [...BASE_SIM_DEVICE_MODELS];
  try {
    // A local Mac (Botflow Companion) runs the base two.
    if (simulatorProvider() === "cloud") devices = await availableSimDevices(userId);
  } catch (error) {
    console.error("[swift-preview/devices]", error);
  }
  return NextResponse.json({ devices }, { headers: { "Cache-Control": "private, no-store" } });
}
