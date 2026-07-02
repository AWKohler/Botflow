"use client";

import { useEffect, useRef } from "react";

/**
 * Shared polling loop for the workspace's background state checks.
 *
 * Exists because six independent setInterval loops (2–4s each) kept firing
 * from every open workspace tab — visible or not — which is what saturated the
 * per-user rate limit in production (a hidden tab polls exactly as hard as a
 * focused one, and eight windows poll eight times as hard). This hook is the
 * client-side half of that fix; the server half is the dedicated poll buckets
 * in src/lib/rate-limit-classify.ts.
 *
 * Behavior:
 * - Pauses entirely while the document is hidden; ticks immediately (and
 *   resumes the loop) when the tab becomes visible again.
 * - Never overlaps ticks — the next one is scheduled only after the current
 *   one settles, so a slow request can't stack requests behind it.
 * - Jitters each delay ±10% so N windows opened together don't synchronize
 *   into request bursts.
 * - Lets a tick push the next one out (return a ms delay) — used to honor
 *   Retry-After on 429 instead of hammering a closed door.
 * - Aborts the in-flight request on unmount/disable via the passed signal.
 */
export function useWorkspacePoll(
  tick: (signal: AbortSignal) => Promise<number | void> | number | void,
  baseMs: number,
  enabled: boolean,
) {
  // Latest-callback ref so the effect doesn't tear down and restart the loop
  // every render (the tick closures capture fresh state each render anyway).
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const schedule = (ms: number) => {
      if (stopped) return;
      const jittered = ms * (0.9 + Math.random() * 0.2);
      timer = setTimeout(run, jittered);
    };

    const run = async () => {
      if (stopped) return;
      // Hidden tab: stop the loop here. The visibilitychange listener below
      // restarts it the moment the tab is shown, so nothing polls while unseen.
      if (document.visibilityState === "hidden") return;

      controller = new AbortController();
      let delay = baseMs;
      try {
        const override = await tickRef.current(controller.signal);
        if (typeof override === "number" && override > 0) {
          delay = Math.max(delay, override);
        }
      } catch {
        // Aborts and network blips are fine; the next tick catches up.
      }
      schedule(delay);
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      // Catch up immediately after being backgrounded, then resume the cadence.
      clearTimeout(timer);
      void run();
    };

    document.addEventListener("visibilitychange", onVisibility);
    void run();

    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, baseMs]);
}

/**
 * Delay to return from a poll tick that got a 429 — honors Retry-After when
 * the server sent one, else backs off a conservative 30s.
 */
export function rateLimitDelayMs(res: Response): number {
  const retryAfter = Number(res.headers.get("Retry-After"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000;
}
