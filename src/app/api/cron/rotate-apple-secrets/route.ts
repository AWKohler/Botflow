/**
 * Apple "Sign in with Apple" client-secret rotation sweep.
 *
 * Apple caps the client secret (an ES256 JWT) at 6 months. setupOAuthProvider
 * persists each project's signing inputs encrypted; this cron re-signs any
 * secret nearing expiry and pushes it to that project's Convex deployment, so
 * Apple sign-in never silently breaks. Triggered by Vercel cron (see
 * vercel.json), authorized by the shared CRON_SECRET. Per-project failures are
 * isolated inside rotateExpiringAppleSecrets.
 */
import { NextResponse } from "next/server";
import { rotateExpiringAppleSecrets } from "@/lib/convex-auth-setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[rotate-apple-secrets] CRON_SECRET is not set");
    return false;
  }
  if (req.headers.get("authorization") === `Bearer ${cronSecret}`) return true;
  const url = new URL(req.url);
  return url.searchParams.get("token") === cronSecret;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const withinDays = Math.min(
    Math.max(parseInt(url.searchParams.get("withinDays") || "30", 10) || 30, 1),
    180,
  );

  try {
    const result = await rotateExpiringAppleSecrets(withinDays);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[rotate-apple-secrets] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
