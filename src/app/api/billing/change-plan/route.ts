import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth/server";
import { requireSameOrigin } from "@/lib/auth/policy";
import { quotePlanChange, applyPlanChange } from "@/lib/billing/change-plan";
const input = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("preview"),
    plan: z.enum(["pro", "max"]),
    interval: z.enum(["month", "year"]),
  }),
  z.object({ action: z.literal("apply"), token: z.string().min(1).max(4096) }),
]);
export async function POST(request: Request) {
  if (!requireSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const { userId, actor } = await auth();
  if (!userId || actor)
    return NextResponse.json(
      { error: "Manage billing from your own account" },
      { status: 403 },
    );
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid plan change" }, { status: 400 });
  try {
    const value = parsed.data;
    return NextResponse.json(
      value.action === "preview"
        ? await quotePlanChange(userId, value.plan, value.interval)
        : await applyPlanChange(userId, value.token),
    );
  } catch (error) {
    console.error(
      "[billing] Plan change failed",
      error instanceof Error ? error.name : "error",
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.name === "Error"
            ? error.message
            : "Unable to change your plan. Please try again.",
      },
      { status: 409 },
    );
  }
}
