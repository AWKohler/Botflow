/**
 * Structured error classification for agent API errors.
 */

export type AgentErrorType =
  | "rate_limit"
  | "quota_exceeded"
  | "auth"
  | "context_overflow"
  | "network"
  | "provider_error"
  /** The model provider's service is down/unreachable (not the user's project). */
  | "provider_unavailable"
  | "unknown";

export interface AgentError {
  type: AgentErrorType;
  message: string;
  retryAfter?: number; // seconds
  details?: string;
}

/**
 * Gateway-level outage text from a model provider: an Envoy "upstream connect
 * error or disconnect/reset before headers" page, a bare 502/503/504, or an
 * overloaded/unavailable notice. These are the provider's side failing — the
 * agent panel shows a plain-language message instead of the raw page.
 */
const PROVIDER_OUTAGE_PATTERN =
  /upstream connect error|disconnect\/reset before headers|service unavailable|bad gateway|gateway time-?out|\b(?:http|status|code)\s*50[234]\b|\boverloaded\b|temporarily unavailable/i;

export function isProviderOutage(text: string): boolean {
  return PROVIDER_OUTAGE_PATTERN.test(text);
}

/** "OpenAI's ChatGPT service is temporarily unavailable…" */
export function providerOutageMessage(providerLabel: string): string {
  return `${providerLabel} is temporarily unavailable — this is on their side, not your project. Try again in a moment.`;
}

/** Pull responseBody string off AI SDK errors (AI_APICallError or AI_RetryError → lastError) */
function extractResponseBody(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.responseBody === "string") return e.responseBody;
  if (e.lastError && typeof e.lastError === "object") {
    const last = e.lastError as Record<string, unknown>;
    if (typeof last.responseBody === "string") return last.responseBody;
  }
  return undefined;
}

/** Pull response headers off AI SDK errors (AI_APICallError or AI_RetryError → lastError) */
function extractResponseHeaders(err: unknown): Record<string, string> | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  // AI_APICallError has responseHeaders directly
  if (e.responseHeaders && typeof e.responseHeaders === "object") {
    return e.responseHeaders as Record<string, string>;
  }
  // AI_RetryError wraps the last error in lastError
  if (e.lastError && typeof e.lastError === "object") {
    const last = e.lastError as Record<string, unknown>;
    if (last.responseHeaders && typeof last.responseHeaders === "object") {
      return last.responseHeaders as Record<string, string>;
    }
  }
  return undefined;
}

function formatTimeUntilReset(seconds: number): string {
  if (seconds >= 86_400) {
    const days = Math.ceil(seconds / 86_400);
    return `~${days} day${days > 1 ? "s" : ""}`;
  }
  if (seconds >= 3_600) {
    const hours = Math.ceil(seconds / 3_600);
    return `~${hours} hour${hours > 1 ? "s" : ""}`;
  }
  const mins = Math.ceil(seconds / 60);
  return `~${mins} minute${mins > 1 ? "s" : ""}`;
}

/**
 * Classify an error from a provider API call into a structured AgentError.
 */
export function classifyError(err: unknown): AgentError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // Extract response headers for richer context (AI SDK attaches these)
  const headers = extractResponseHeaders(err);

  // Extract and parse responseBody for provider-specific detail messages
  const rawBody = extractResponseBody(err);
  const bodyDetail: string | undefined = (() => {
    if (!rawBody) return undefined;
    try { return (JSON.parse(rawBody) as Record<string, unknown>).detail as string | undefined; } catch { return undefined; }
  })();

  // OpenAI OAuth (Codex): model not available on this ChatGPT account
  if (bodyDetail?.includes("not supported when using Codex")) {
    return {
      type: "auth",
      message: `This model is not available with your ChatGPT account. Try a different model or add an OpenAI API key in Settings.`,
      details: bodyDetail,
    };
  }
  const retryAfterSecs = headers?.["retry-after"] ? parseInt(headers["retry-after"], 10) : undefined;

  // ── Anthropic / provider weekly quota exhaustion ──────────────────────────
  // Detected by: 7-day rate limit header rejected, OR message "would exceed your account's rate limit"
  const is7dQuotaExhausted =
    headers?.["anthropic-ratelimit-unified-7d-status"] === "rejected" ||
    lower.includes("would exceed your account");

  if (is7dQuotaExhausted) {
    const resetIn = retryAfterSecs ? ` Resets in ${formatTimeUntilReset(retryAfterSecs)}.` : "";
    return {
      type: "quota_exceeded",
      message: `Your Claude subscription has used up its weekly usage quota.${resetIn} Use a different model or add an Anthropic API key in Settings.`,
      retryAfter: retryAfterSecs,
      details: message,
    };
  }

  // Rate limiting
  if (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("429") ||
    lower.includes("too many requests")
  ) {
    const retryAfter = retryAfterSecs ?? extractRetryAfter(message);
    return {
      type: "rate_limit",
      message: "Rate limited by the provider. Retrying shortly…",
      retryAfter,
      details: message,
    };
  }

  // Auth errors
  if (
    lower.includes("unauthorized") ||
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid_api_key") ||
    lower.includes("authentication") ||
    lower.includes("permission denied")
  ) {
    return {
      type: "auth",
      message: "Authentication error. Check your API key.",
      details: message,
    };
  }

  // Context overflow
  if (
    lower.includes("context length") ||
    lower.includes("context_length") ||
    lower.includes("maximum context") ||
    lower.includes("token limit") ||
    lower.includes("too many tokens") ||
    lower.includes("max_tokens") ||
    lower.includes("context window")
  ) {
    return {
      type: "context_overflow",
      message: "Context too large for the model.",
      details: message,
    };
  }

  // Network errors
  if (
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("fetch failed") ||
    lower.includes("socket hang up") ||
    lower.includes("dns") ||
    err instanceof TypeError // fetch throws TypeError on network failure
  ) {
    return {
      type: "network",
      message: "Network error. Please check your connection.",
      details: message,
    };
  }

  // Provider-specific errors (non-retryable)
  if (
    lower.includes("400") ||
    lower.includes("bad request") ||
    lower.includes("invalid_request") ||
    lower.includes("overloaded") ||
    lower.includes("500") ||
    lower.includes("503")
  ) {
    return {
      type: "provider_error",
      message: `Provider error: ${message.slice(0, 200)}`,
      details: message,
    };
  }

  return {
    type: "unknown",
    message: message.slice(0, 300),
    details: message,
  };
}

/** Try to extract a retry-after value (in seconds) from error messages */
function extractRetryAfter(message: string): number | undefined {
  // Look for patterns like "retry after 30s", "retry-after: 30", "wait 60 seconds"
  const patterns = [
    /retry[- ]?after[:\s]*(\d+)/i,
    /wait\s+(\d+)\s*s/i,
    /(\d+)\s*seconds?\s*(?:until|before|to)/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return parseInt(match[1], 10);
    }
  }

  return undefined;
}

/** Format an AgentError for the client-side response */
export function formatErrorResponse(error: AgentError): {
  error: string;
  errorType: AgentErrorType;
  retryAfter?: number;
  details?: string;
} {
  return {
    error: error.message,
    errorType: error.type,
    ...(error.retryAfter && { retryAfter: error.retryAfter }),
    ...(error.details && { details: error.details }),
  };
}
