/**
 * Generic helpers for delivering platform-normalized webhook events to a
 * project's Convex site. Shared by the Stripe and RevenueCat fan-out paths
 * (inbound receiver's first inline attempt + the retry crons).
 *
 * Signing: each request carries
 *   X-Botflow-Signature     — HMAC-SHA256(payload)            [legacy, body-only]
 *   X-Botflow-Timestamp     — unix seconds (re-stamped per attempt)
 *   X-Botflow-Signature-V2  — HMAC-SHA256(`${timestamp}.${payload}`)
 * The V2 signature binds a timestamp so a captured request can't be replayed
 * outside a small window; new scaffolds verify V2 and enforce freshness.
 */
import { createHmac } from 'node:crypto';
import type { projects } from '@/db/schema';

/** Per-attempt backoff. Index by the attempt number about to be made (1-based). */
const BACKOFF_MS = [
  30_000, // after attempt 1 fails → retry in 30s
  120_000, // 2m
  600_000, // 10m
  1_800_000, // 30m
  3_600_000, // 1h
  10_800_000, // 3h
  21_600_000, // 6h
  43_200_000, // 12h
];

/** Give up after this many failed attempts (~1.5 days of retries). */
export const MAX_DELIVERY_ATTEMPTS = 10;

/**
 * Lease window. A row is stamped with nextAttemptAt = now + lease the moment
 * it's claimed (on insert by the inbound receiver, and again by each cron
 * claim). If the worker that claimed it crashes before recording a terminal
 * status, the lease expires and the next cron sweep reclaims it.
 */
export const DELIVERY_LEASE_MS = 120_000;

/** Delay before the next attempt given how many have already been made. */
export function backoffMs(attemptsMade: number): number {
  const idx = Math.min(Math.max(attemptsMade - 1, 0), BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx];
}

/** Convex *site* URL (.convex.site) for a project, or null if no backend. */
export function convexSiteUrlFor(project: typeof projects.$inferSelect): string | null {
  const deployUrl = project.userConvexUrl ?? project.convexDeployUrl;
  if (!deployUrl) return null;
  return deployUrl.replace('.convex.cloud', '.convex.site');
}

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/** Build the signed headers for one delivery attempt (fresh timestamp). */
export function signedDeliveryHeaders(secret: string, payload: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  return {
    'Content-Type': 'application/json',
    'X-Botflow-Signature': hmacHex(secret, payload),
    'X-Botflow-Timestamp': ts,
    'X-Botflow-Signature-V2': hmacHex(secret, `${ts}.${payload}`),
  };
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** POST one signed delivery to a full Convex webhook URL. */
export async function deliverWebhookEventOnce(opts: {
  url: string;
  secret: string;
  payload: string;
  timeoutMs?: number;
}): Promise<DeliveryResult> {
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: signedDeliveryHeaders(opts.secret, opts.payload),
      body: opts.payload,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (res.ok) return { ok: true, status: res.status };
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
