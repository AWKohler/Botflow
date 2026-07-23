/**
 * Function-call counter for platform-managed Convex deployments.
 *
 * Counts new entries on the deployment's admin log stream
 * (GET {deployUrl}/api/stream_function_logs?cursor=<ms> → { entries, newCursor },
 * one entry per function execution — same endpoint convex-admin.ts reads).
 * Entries are bucketed per UTC day from their own execution timestamps, so a
 * poll that straddles midnight (or catches up after cron downtime) attributes
 * calls to the day they actually ran instead of collapsing them into "today"
 * and false-tripping a daily threshold.
 *
 * Operational properties (measured live against a scratch deployment,
 * 2026-07-23):
 *
 *  - The endpoint LONG-POLLS when the cursor is current. We always race a
 *    timeout and treat it as "no new calls" so one quiet deployment can't
 *    stall the sweep.
 *  - The server-side buffer holds at most BUFFER_CAP entries (measured: fired
 *    1200 calls, got exactly 1000 back). A deployment doing more than that
 *    between polls undercounts; we surface `saturated` + the covered time
 *    span so the caller can extrapolate. This is an outlier detector, not
 *    billing-grade accounting.
 *  - `newCursor` is fractional ms (a float).
 */

/** Measured cap of entries one stream_function_logs response returns. */
export const BUFFER_CAP = 1000;

export type PollCallsResult =
  | {
      ok: true;
      /** Total new executions observed (≤ BUFFER_CAP per poll). */
      count: number;
      /** Executions bucketed by UTC day ('YYYY-MM-DD') of their timestamp. */
      countsByDay: Record<string, number>;
      /** Float ms cursor to persist (ceil before storing in a bigint). */
      newCursor: number;
      /** True when the buffer cap was hit — real count is likely higher. */
      saturated: boolean;
      /** ms between first and last returned entry (0 when count < 2). */
      spanMs: number;
    }
  | { ok: false; error: string };

function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

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
      return { ok: true, count: 0, countsByDay: {}, newCursor: cursor, saturated: false, spanMs: 0 };
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

  let data: { entries?: Array<Record<string, unknown>>; newCursor?: number };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { ok: false, error: "stream_function_logs returned malformed JSON" };
  }

  const entries = Array.isArray(data.entries) ? data.entries : [];
  const count = entries.length;

  // Bucket by each entry's own execution timestamp (float seconds — same
  // field convex-admin.ts reads). Entries with a missing/bogus timestamp are
  // attributed to the current UTC day rather than dropped.
  const countsByDay: Record<string, number> = {};
  let firstTsMs = Number.POSITIVE_INFINITY;
  let lastTsMs = 0;
  let maxRawTsMs = 0; // unclamped — cursor must never regress below a real entry
  const nowMs = Date.now();
  for (const e of entries) {
    const rawTsMs = typeof e.timestamp === "number" && e.timestamp > 0 ? e.timestamp * 1000 : nowMs;
    if (rawTsMs > maxRawTsMs) maxRawTsMs = rawTsMs;
    // Clamp to now for BUCKETING only: a corrupt future-dated timestamp would
    // otherwise create a future day bucket that inflates the 30-day rollup
    // and outlives pruning.
    const tsMs = Math.min(rawTsMs, nowMs);
    if (tsMs < firstTsMs) firstTsMs = tsMs;
    if (tsMs > lastTsMs) lastTsMs = tsMs;
    const day = utcDayKey(tsMs);
    countsByDay[day] = (countsByDay[day] ?? 0) + 1;
  }
  const spanMs = count >= 2 ? Math.max(0, lastTsMs - firstTsMs) : 0;

  // If the payload carries entries but no usable cursor (schema drift), fall
  // back to the newest RAW entry timestamp (unclamped — a clamped fallback
  // could sit below a clock-skewed entry and re-count it next tick). NEVER
  // return the old cursor alongside a nonzero count, or every subsequent tick
  // re-counts the same entries and ratchets the buckets toward a false pause.
  let newCursor: number;
  if (typeof data.newCursor === "number" && Number.isFinite(data.newCursor)) {
    newCursor = data.newCursor;
  } else if (count > 0) {
    newCursor = maxRawTsMs;
  } else {
    newCursor = cursor;
  }

  return { ok: true, count, countsByDay, newCursor, saturated: count >= BUFFER_CAP, spanMs };
}
