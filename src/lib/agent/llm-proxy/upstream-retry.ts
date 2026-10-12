/**
 * Short retries for transient upstream failures in the LLM proxy.
 *
 * Providers' edges occasionally answer 502/503/504 — e.g. an Envoy
 * "upstream connect error or disconnect/reset before headers" page when their
 * gateway briefly can't reach the model servers — or the connection fails
 * outright. Those blips are usually gone within a second or two, so the proxy
 * retries a couple of times before passing the failure through to the agent.
 *
 * Safe because nothing has been streamed yet: every retryable outcome happens
 * before the provider returned a success response, and the request body is a
 * string we can resend verbatim.
 */

/** Statuses worth retrying: gateway-level failures, not the model's answer. */
export const RETRYABLE_UPSTREAM_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export interface UpstreamRetryOptions {
  /** Total attempts including the first (default 3 → up to 2 retries). */
  attempts?: number;
  /** Backoff base; attempt n waits base × 3^n plus jitter (default 400ms). */
  baseDelayMs?: number;
  /** A provider Retry-After longer than this isn't worth waiting for in-request. */
  maxRetryAfterMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry (for logging). */
  onRetry?: (info: { attempt: number; status: number | null; delayMs: number; error?: unknown }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * Run `doFetch`, retrying network errors and 502/503/504 responses. Returns
 * the first non-retryable response, or the last response / rethrows the last
 * error once attempts run out.
 */
export async function fetchWithUpstreamRetry(
  doFetch: () => Promise<Response>,
  options: UpstreamRetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const base = options.baseDelayMs ?? 400;
  const maxRetryAfter = options.maxRetryAfterMs ?? 5_000;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    const last = attempt === attempts - 1;
    const backoff = base * 3 ** attempt + Math.floor(Math.random() * base);

    let res: Response;
    try {
      res = await doFetch();
    } catch (error) {
      if (last) throw error;
      options.onRetry?.({ attempt, status: null, delayMs: backoff, error });
      await sleep(backoff);
      continue;
    }

    if (last || !RETRYABLE_UPSTREAM_STATUSES.has(res.status)) return res;

    const hinted = retryAfterMs(res);
    if (hinted !== null && hinted > maxRetryAfter) return res; // provider says "much later"
    const delayMs = hinted ?? backoff;
    // Release the failed response's connection before trying again.
    await res.body?.cancel().catch(() => {});
    options.onRetry?.({ attempt, status: res.status, delayMs });
    await sleep(delayMs);
  }
}
