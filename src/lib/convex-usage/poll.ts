/**
 * Function-call counter for platform-managed Convex deployments.
 *
 * Counts new entries on the deployment's admin log stream
 * (GET {deployUrl}/api/stream_function_logs?cursor=<ms> → { entries, newCursor },
 * one entry per function execution — same endpoint convex-admin.ts reads).
 *
 * Two properties matter for the cron caller:
 *
 *  - The endpoint LONG-POLLS when the cursor is current. We always race a
 *    timeout and treat it as "no new calls" so one quiet deployment can't
 *    stall the sweep.
 *  - The server-side buffer is bounded, so a deployment doing millions of
 *    calls between polls undercounts. That's acceptable: this is an outlier
 *    detector, not billing-grade accounting — a saturated buffer every poll
 *    is itself an unambiguous spike signal.
 */

export type PollCallsResult =
  | { ok: true; count: number; newCursor: number }
  | { ok: false; error: string };

export async function fetchNewFunctionCalls(
  deployUrl: string,
  deployKey: string,
  /** ms cursor from the previous poll; pass Date.now() on first poll. */
  cursor: number,
  timeoutMs = 10_000,
): Promise<PollCallsResult> {
  let res: Response;
  try {
    res = await fetch(
      `${deployUrl}/api/stream_function_logs?cursor=${encodeURIComponent(String(cursor))}`,
      {
        headers: { Authorization: `Convex ${deployKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (err) {
    // Timeout = the long-poll had nothing to say. Cursor stands.
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: true, count: 0, newCursor: cursor };
    }
    return {
      ok: false,
      error: `Failed to reach Convex deployment: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    await res.text().catch(() => "");
    return { ok: false, error: `stream_function_logs returned HTTP ${res.status}` };
  }

  let data: { entries?: unknown[]; newCursor?: number };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { ok: false, error: "stream_function_logs returned malformed JSON" };
  }

  const count = Array.isArray(data.entries) ? data.entries.length : 0;
  const newCursor = typeof data.newCursor === "number" ? data.newCursor : cursor;
  return { ok: true, count, newCursor };
}
