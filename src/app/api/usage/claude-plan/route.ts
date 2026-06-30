/**
 * GET /api/usage/claude-plan
 *
 * Claude subscription (OAuth) usage for the signed-in user — the same numbers
 * Claude Code's /usage screen shows. Only meaningful when the user has linked
 * their Claude subscription via OAuth; returns { available: false } otherwise.
 *
 * Source: Anthropic's OAuth usage endpoint (GET /api/oauth/usage with the
 * user's bearer token). The response carries per-window utilization:
 *   five_hour  — current session window
 *   seven_day  — current week window
 * Each as { utilization, resets_at }. Utilization is normalized here to 0–100.
 */
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getUserCredentials } from "@/lib/user-credentials";
import { getFreshAnthropicAccessToken } from "@/lib/anthropic-oauth";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

interface UsageWindow {
  utilization?: number;
  resets_at?: string | number | null;
}

/** Anthropic has reported utilization both as a 0–1 fraction and as a 0–100
 *  percent across surfaces; normalize to 0–100 either way. */
function normalizePct(u: number | undefined): number | null {
  if (typeof u !== "number" || !Number.isFinite(u)) return null;
  const pct = u > 1 ? u : u * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export async function GET(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const blocked = await enforce(identifierFor(userId, req), "expensive");
    if (blocked) return blocked;

    const creds = await getUserCredentials(userId);
    if (!creds.claudeOAuthAccessToken) {
      return NextResponse.json({ available: false });
    }

    const token = await getFreshAnthropicAccessToken(
      {
        claudeOAuthAccessToken: creds.claudeOAuthAccessToken,
        claudeOAuthRefreshToken: creds.claudeOAuthRefreshToken,
        claudeOAuthExpiresAt: creds.claudeOAuthExpiresAt,
      },
      userId,
    );
    if (!token) {
      return NextResponse.json({ available: false });
    }

    const res = await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // Token rejected / endpoint unavailable — degrade gracefully, the UI
      // simply hides the gauge.
      return NextResponse.json({ available: false });
    }

    const data = (await res.json()) as {
      five_hour?: UsageWindow | null;
      seven_day?: UsageWindow | null;
    };

    const fiveHour = normalizePct(data.five_hour?.utilization ?? undefined);
    const sevenDay = normalizePct(data.seven_day?.utilization ?? undefined);
    if (fiveHour === null && sevenDay === null) {
      return NextResponse.json({ available: false });
    }

    return NextResponse.json({
      available: true,
      fiveHour,
      sevenDay,
      fiveHourResetsAt: data.five_hour?.resets_at ?? null,
      sevenDayResetsAt: data.seven_day?.resets_at ?? null,
    });
  } catch (err) {
    console.error("GET /api/usage/claude-plan failed:", err);
    return NextResponse.json({ available: false });
  }
}
