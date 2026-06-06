// Refcounted session pool for the Swift simulator preview.
//
// Problem this solves:
//   React Strict Mode (dev) invokes effects twice — mount → cleanup → mount.
//   The original implementation POSTed `/swift-preview/start` on each mount,
//   producing two sessions per page open. One of them got async-deleted by
//   the cancelled-flag path, but during a narrow window we'd have:
//     • two builds running on the host (slot pressure)
//     • the UI's WebSocket bound to the about-to-die session
//     • the pill stuck on "Provisioning…" until the right race resolved
//
// Fix:
//   Acquire a session by projectId. Strict-mode's second mount sees the
//   in-flight promise, increments the refcount, and gets the same sessionId.
//   When the LAST consumer releases, we defer the DELETE by a grace window
//   so a follow-up mount within the same tick can re-claim. Real unmounts
//   (navigate away) wait the grace and then issue the DELETE.
//
// The Stop button bypasses the pool's grace window via `forceEndSession`
// so user intent to stop is honored immediately.

interface PooledSession {
  sessionId: string;
  wsUrl: string;
}

export interface SessionOptions {
  deviceModel?: "iPhone-16-Pro" | "iPad-Pro";
  orientation?: "portrait" | "landscape";
}

interface PoolEntry {
  projectId: string;
  refcount: number;
  promise: Promise<PooledSession>;
  resolved: PooledSession | null;
  failed: Error | null;
  /** Pending DELETE timer for when refcount hits zero. Cleared on re-claim. */
  endTimer: ReturnType<typeof setTimeout> | null;
}

const pool = new Map<string, PoolEntry>();

// The pool key folds the device family into the projectId so switching device
// (iPhone ↔ iPad needs a different simulator) starts a fresh session and tears
// the old one down, while Strict-Mode's same-device remount still dedupes to
// one session. Orientation is NOT in the key — it's set at creation and then
// changed live via the `set_orientation` control path (no rebuild).
function poolKey(projectId: string, opts: SessionOptions): string {
  return `${projectId}::${opts.deviceModel ?? "iPhone-16-Pro"}`;
}

// Grace window between "last consumer released" and "issue DELETE." React
// Strict Mode's mount → cleanup → mount cycle finishes in <50ms, so 250ms is
// safely longer than any legitimate re-claim while staying short enough not
// to leak resources when the user actually leaves the page.
const DELETE_GRACE_MS = 250;

/**
 * Get-or-create a shared session for this projectId. Multiple callers for
 * the same projectId receive the SAME PooledSession; the pool tracks how
 * many consumers there are.
 *
 * Throws if provisioning fails. The pool entry is removed on failure so a
 * retry mounts a fresh provisioning attempt.
 */
export function acquireSession(
  projectId: string,
  opts: SessionOptions = {},
): Promise<PooledSession> {
  const key = poolKey(projectId, opts);
  let entry = pool.get(key);
  if (!entry) {
    const promise = startSession(projectId, opts);
    entry = {
      projectId,
      refcount: 0,
      promise,
      resolved: null,
      failed: null,
      endTimer: null,
    };
    pool.set(key, entry);
    // Track outcome on the entry so future inspections (and the eventual
    // DELETE) know the sessionId or failure.
    promise.then(
      (data) => {
        if (pool.get(key) === entry) entry!.resolved = data;
      },
      (err: Error) => {
        if (pool.get(key) === entry) {
          entry!.failed = err;
          // Failed provisioning shouldn't stick — let the next acquire retry.
          pool.delete(key);
        }
      },
    );
  }
  // If a DELETE was queued, cancel it: someone wants this session again.
  if (entry.endTimer) {
    clearTimeout(entry.endTimer);
    entry.endTimer = null;
  }
  entry.refcount += 1;
  return entry.promise;
}

/**
 * Decrement the refcount for a session. When it hits zero we DON'T DELETE
 * immediately — we wait `DELETE_GRACE_MS` so a re-acquire (Strict Mode
 * remount) can re-claim. On real unmount the timer fires and we DELETE.
 */
export function releaseSession(projectId: string, opts: SessionOptions = {}): void {
  const key = poolKey(projectId, opts);
  const entry = pool.get(key);
  if (!entry) return;
  entry.refcount = Math.max(0, entry.refcount - 1);
  if (entry.refcount > 0) return;
  if (entry.endTimer) clearTimeout(entry.endTimer);
  entry.endTimer = setTimeout(() => {
    // Re-check: a re-acquire during the grace window would have cancelled
    // this timer, but double-check refcount as belt-and-suspenders.
    const current = pool.get(key);
    if (current !== entry || current.refcount > 0) return;
    pool.delete(key);
    if (entry.resolved) {
      void fetch(
        `/api/projects/${projectId}/swift-preview/${entry.resolved.sessionId}`,
        { method: "DELETE", keepalive: true },
      ).catch(() => undefined);
    }
  }, DELETE_GRACE_MS);
}

/**
 * Immediately end the session for this projectId, regardless of refcount.
 * Used by the Stop button so the user's intent to stop is honored without
 * the grace-window delay.
 */
export function forceEndSession(projectId: string, opts: SessionOptions = {}): void {
  const key = poolKey(projectId, opts);
  const entry = pool.get(key);
  if (!entry) return;
  if (entry.endTimer) clearTimeout(entry.endTimer);
  pool.delete(key);
  if (entry.resolved) {
    void fetch(
      `/api/projects/${projectId}/swift-preview/${entry.resolved.sessionId}`,
      { method: "DELETE", keepalive: true },
    ).catch(() => undefined);
  }
}

async function startSession(
  projectId: string,
  opts: SessionOptions,
): Promise<PooledSession> {
  const res = await fetch(`/api/projects/${projectId}/swift-preview/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceModel: opts.deviceModel ?? "iPhone-16-Pro",
      ...(opts.orientation ? { orientation: opts.orientation } : {}),
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as PooledSession;
}
