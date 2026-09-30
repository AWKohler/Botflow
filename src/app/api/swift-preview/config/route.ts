import { auth } from "@/lib/auth/server";
import { NextResponse } from "next/server";
import { simulatorProvider } from "@/lib/simulator-provider";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ provider: simulatorProvider() }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[swift-preview/config]", error);
    return NextResponse.json({ error: "Simulator provider is not configured correctly." }, { status: 503 });
  }
}
