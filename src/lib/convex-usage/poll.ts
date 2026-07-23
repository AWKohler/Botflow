/**
 * Function-call counter for platform-managed Convex deployments.
 *
 * Counts new COMPLETED function executions on the deployment's admin log
 * stream (GET {deployUrl}/api/stream_function_logs?cursor=<ms> →
 * { entries, newCursor } — same endpoint convex-admin.ts reads). Entries are
 * bucketed per UTC day from their own execution timestamps, so a poll that
 * straddles midnight (or catches up after cron downtime) attributes calls to
 * the day they actually ran instead of collapsing them into "today" and
 * false-tripping a daily threshold.
 *
 * Operational properties (measured live against a scratch deployment,
 * 2026-07-23):
 *
 *  - Entries carry kind='Completion' (one per finished execution) and
 *    kind='Progress' (actions emit one PER console.log LINE — measured: 5
 *    actions × 20 logs = 100 Progress + 5 Completion). Only Completions are
 *    counted, or a chatty-but-legit app would meter at ~21× its real rate.
 *    If the schema ever drops `kind` (drift), we fall back to counting
 *    everything — over-counting alerts an operator; under-counting hides
 *    abuse forever.
 *  - The endpoint LONG-POLLS when the cursor is current. We always race a
 *    timeout and treat it as "no new calls" so one quiet deployment can't
 *    stall the sweep.
 *  - The server-side buffer holds at most BUFFER_CAP raw entries (measured:
 *    fired 1200, got exactly 1000). `saturated` is judged on RAW entries —
 *    Progress spam fills the buffer and displaces Completions, so a
 *    saturated poll means the completion count is a floor, not a total.
 *  - `newCursor` is fractional ms (a float).
 */

/** Measured cap of raw entries one stream_function_logs response returns. */
export const BUFFER_CAP = 1000;

export type PollCallsResult =
  | {
      ok: true;
      /** Completed executions observed this poll. */
      count: number;
      /** Raw entries returned (Completions + Progress etc.). */
      rawCount: number;
      /** Completions bucketed by UTC day ('YYYY-MM-DD') of their timestamp. */
      countsByDay: Record<string, number>;
      /** Float ms cursor to persist (clamp + ceil before storing). */
      newCursor: number;
      /** True when the RAW buffer cap was hit — real count is likely higher. */
      saturated: boolean;
      /** ms between first and last raw entry (0 when rawCount < 2). */
      spanMs: number;
    }
  | { ok: false; error: string };

function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function fetchNewFunctionCalls(
  deployUrl: string,
  deployKey: string,
  /** ms cursor from the previous poll; pass 0 on first poll to count the retained buffer. */
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
      return {
        ok: true,
        count: 0,
        rawCount: 0,
        countsByDay: {},
        newCursor: cursor,
        saturated: false,
        spanMs: 0,
      };
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
  const rawCount = entries.length;

  // Count Completions only (one per finished execution). Schema-drift
  // fallback: if NO entry carries a kind field, count everything.
  const anyKind = entries.some((e) => typeof e.kind === "string");
  const completions = anyKind ? entries.filter((e) => e.kind === "Completion") : entries;

  const countsByDay: Record<string, number> = {};
  let firstTsMs = Number.POSITIVE_INFINITY;
  let lastTsMs = 0;
  let maxRawTsMs = 0; // unclamped — cursor must never regress below a real entry
  const nowMs = Date.now();

  const tsOf = (e: Record<string, unknown>): number =>
    typeof e.timestamp === "number" && e.timestamp > 0 ? e.timestamp * 1000 : nowMs;

  // Span/coverage from ALL raw entries (they share the buffer)…
  for (const e of entries) {
    const rawTsMs = tsOf(e);
    if (rawTsMs > maxRawTsMs) maxRawTsMs = rawTsMs;
    const tsMs = Math.min(rawTsMs, nowMs);
    if (tsMs < firstTsMs) firstTsMs = tsMs;
    if (tsMs > lastTsMs) lastTsMs = tsMs;
  }
  // …but day buckets from Completions only. Clamp to now for BUCKETING: a
  // corrupt future-dated timestamp would otherwise create a future day bucket
  // that inflates the 30-day rollup and outlives pruning.
  for (const e of completions) {
    const day = utcDayKey(Math.min(tsOf(e), nowMs));
    countsByDay[day] = (countsByDay[day] ?? 0) + 1;
  }
  const spanMs = rawCount >= 2 ? Math.max(0, lastTsMs - firstTsMs) : 0;

  // If the payload carries entries but no usable cursor (schema drift), fall
  // back to the newest RAW entry timestamp (unclamped — a clamped fallback
  // could sit below a clock-skewed entry and re-count it next tick). NEVER
  // return the old cursor alongside nonzero entries, or every subsequent tick
  // re-counts the same entries and ratchets the buckets toward a false pause.
  let newCursor: number;
  if (typeof data.newCursor === "number" && Number.isFinite(data.newCursor)) {
    newCursor = data.newCursor;
  } else if (rawCount > 0) {
    newCursor = maxRawTsMs;
  } else {
    newCursor = cursor;
  }

  return {
    ok: true,
    count: completions.length,
    rawCount,
    countsByDay,
    newCursor,
    saturated: rawCount >= BUFFER_CAP,
    spanMs,
  };
}
