import { auth } from "@/lib/auth/server";
import { NextResponse } from "next/server";
import { simulatorProvider } from "@/lib/simulator-provider";
import { availableSimDevices } from "@/lib/sim-hosts/routing";
import { BASE_SIM_DEVICE_MODELS } from "@/lib/sim-platform";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const provider = simulatorProvider();
    // Which devices this user can start. A local Mac runs the base two; in the
    // cloud it depends on the hosts that may serve them (the iPhone Duo needs
    // a Mac that has it).
    const devices = provider === "cloud" ? await availableSimDevices(userId) : [...BASE_SIM_DEVICE_MODELS];
    return NextResponse.json({ provider, devices }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[swift-preview/config]", error);
    return NextResponse.json({ error: "Simulator provider is not configured correctly." }, { status: 503 });
  }
}
