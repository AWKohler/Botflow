/**
 * Usage metering for the LLM proxy — the billing plane's ground truth.
 *
 * Everything money-related derives from what the PROXY observes on the wire:
 * provider responses carry authoritative usage (including cache fields), so
 * we never trust anything the sandbox self-reports. Design constraints:
 *
 *  - `meterResponse` uses `body.tee()`: branch A goes back to the client
 *    UNTOUCHED (zero added latency; a parser bug can never corrupt or stall
 *    user traffic — worst case is an undercount, which is a logged revenue
 *    leak, never user harm). Branch B drains through a size-bounded SSE
 *    accumulator feeding the dialect parser; settle fires when B ends OR
 *    errors, so aborted streams still report partial usage.
 *
 *  - Cache dialects differ per provider (the whole reason this module
 *    exists):
 *      anthropic         explicit + billed: message_start carries uncached
 *                        input_tokens + cache_creation/cache_read; writes
 *                        cost extra (calculateCredits prices cacheWrite).
 *      openai-chat       passive; usage only arrives when the request asks —
 *                        rewriteRequestBody INJECTS stream_options.include_
 *                        usage — and reads land in prompt_tokens_details.
 *                        cached_tokens. GPT-5.6+ ALSO bills cache WRITES: it
 *                        reports cache_write_tokens (in the same details block)
 *                        SEPARATELY from prompt_tokens, so we add it back to
 *                        get true total-in — mirroring anthropic above.
 *      openai-responses  passive; response.completed carries
 *                        input_tokens_details.{cached_tokens,cache_write_tokens}.
 *      google            passive; usageMetadata.cachedContentTokenCount.
 *      fireworks/together (openai-chat dialect) often report NOTHING —
 *                        applyClockHeuristic ports /api/agent's timestamp
 *                        method: within the 5-minute cache window with no
 *                        explicit report, assume the prefix was cached.
 *
 * Pure logic + one Redis touch (the heuristic) — unit-testable on fixtures.
 */
import { redis } from "@/lib/redis";
import type { UsageDialect } from "./providers";

/** Mirrors /api/agent's cap (route-local there); env-tunable the same way. */
export const PLATFORM_MAX_OUTPUT_TOKENS =
  Number(process.env.PLATFORM_MAX_OUTPUT_TOKENS) || 32_000;

export interface ObservedUsage {
  /** TOTAL input tokens (cached + uncached) — recordTokenUsage semantics. */
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  /** True when the provider explicitly reported cache figures (the clock
   *  heuristic must not override an explicit zero). */
  explicitCacheReport: boolean;
  /** True when a terminal usage frame was seen (vs. aborted mid-stream). */
  complete: boolean;
}

const EMPTY_USAGE: ObservedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  explicitCacheReport: false,
  complete: false,
};

/* ----------------------------- request rewrite ----------------------------- */

export interface RewriteResult {
  body: string;
  /** Provider-native model id extracted from the request (null when the
   *  dialect carries it in the URL — google). */
  model: string | null;
  /** The output cap in force after the rewrite (for reservation math). */
  effectiveMaxOutput: number;
  streaming: boolean;
}

export interface RewriteRejection {
  rejected: string; // human-readable reason (surfaced in the dialect error)
}

/**
 * Parse + rewrite an outbound request body.
 *  - platform mode (enforceModelAllowlist != null): reject off-allowlist
 *    models; clamp AND insert the output-token cap (opencode does not set
 *    output caps on its own).
 *  - openai-chat streams: inject stream_options.include_usage (overriding a
 *    client that set it false) — no usage frame, no billing.
 * Non-JSON bodies are rejected (every allowlisted endpoint takes JSON).
 */
export function rewriteRequestBody(
  raw: string,
  opts: {
    dialect: UsageDialect;
    enforceModelAllowlist: string[] | null;
    capOutputTokens: number | null;
  },
): RewriteResult | RewriteRejection {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { rejected: "Request body is not valid JSON" };
  }

  const model = typeof parsed.model === "string" ? parsed.model : null;
  if (opts.enforceModelAllowlist) {
    // google carries the model in the URL, not the body — the route checks
    // it there; body-model dialects are enforced here.
    if (opts.dialect !== "google") {
      if (!model || !opts.enforceModelAllowlist.includes(model)) {
        return {
          rejected: `Model ${model ?? "(missing)"} is not permitted for this turn`,
        };
      }
    }
  }

  const streaming = opts.dialect === "google"
    ? true // streamGenerateContent is stream-by-URL; generateContent handled as non-stream by the parser
    : parsed.stream === true;

  if (opts.dialect === "openai-chat" && streaming) {
    const existing = (parsed.stream_options ?? {}) as Record<string, unknown>;
    parsed.stream_options = { ...existing, include_usage: true };
  }

  let effectiveMaxOutput = opts.capOutputTokens ?? PLATFORM_MAX_OUTPUT_TOKENS;
  if (opts.capOutputTokens !== null) {
    const cap = opts.capOutputTokens;
    if (opts.dialect === "google") {
      const gen = (parsed.generationConfig ?? {}) as Record<string, unknown>;
      const requested = typeof gen.maxOutputTokens === "number" ? gen.maxOutputTokens : null;
      gen.maxOutputTokens = requested !== null ? Math.min(requested, cap) : cap;
      parsed.generationConfig = gen;
      effectiveMaxOutput = gen.maxOutputTokens as number;
    } else {
      // The dialects disagree on the field name; clamp whichever is present
      // and insert the canonical one when none is.
      const fields = ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const;
      let clamped: number | null = null;
      for (const field of fields) {
        if (typeof parsed[field] === "number") {
          parsed[field] = Math.min(parsed[field] as number, cap);
          clamped = parsed[field] as number;
        }
      }
      if (clamped === null) {
        const canonical = opts.dialect === "openai-responses" ? "max_output_tokens" : "max_tokens";
        parsed[canonical] = cap;
        clamped = cap;
      }
      effectiveMaxOutput = clamped;
    }
  } else {
    // Personal-cred modes: no clamp; reservation isn't used either, so the
    // effective figure is informational.
    const requested =
      (typeof parsed.max_tokens === "number" && parsed.max_tokens) ||
      (typeof parsed.max_output_tokens === "number" && parsed.max_output_tokens) ||
      (typeof parsed.max_completion_tokens === "number" && parsed.max_completion_tokens) ||
      null;
    if (requested) effectiveMaxOutput = requested;
  }

  return { body: JSON.stringify(parsed), model, effectiveMaxOutput, streaming };
}

/* ------------------------------ usage parsing ------------------------------ */

interface UsageParser {
  push(chunkText: string): void;
  finish(): ObservedUsage;
}

/** Cap on accumulated PARSE state (a single SSE data line / non-stream body
 *  buffer) — the stream itself is never bounded or buffered. */
const MAX_PARSE_BUFFER = 512 * 1024;

function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Self-verification for the GPT-5.6 cache-write arithmetic. When
 *  LLM_PROXY_DEBUG_OPENAI_CACHE=true, log the raw token-details block and the
 *  buckets we derived from it, so the first live 5.6 requests confirm that
 *  cache_write_tokens really is reported OUTSIDE prompt_tokens (the assumption
 *  behind adding it back). Off by default — zero overhead in normal operation. */
const DEBUG_OPENAI_CACHE = process.env.LLM_PROXY_DEBUG_OPENAI_CACHE === "true";
function debugOpenAICache(
  dialect: string,
  rawUsage: Record<string, unknown>,
  details: Record<string, unknown> | undefined,
  acc: ObservedUsage,
): void {
  if (!DEBUG_OPENAI_CACHE) return;
  const totalField = dialect === "openai-responses" ? "input_tokens" : "prompt_tokens";
  console.log(
    JSON.stringify({
      tag: "llm-proxy",
      event: "openai_cache_probe",
      dialect,
      rawTotalField: totalField,
      rawTotal: toNumber(rawUsage[totalField]),
      rawDetails: details ?? null,
      derived: {
        inputTokens: acc.inputTokens,
        cachedReadTokens: acc.cachedReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens,
        // If writes are truly OUTSIDE the total, this equals rawTotal + write.
        // If OpenAI actually nests them INSIDE, this over-counts by `write`.
        uncachedForBilling: Math.max(
          0,
          acc.inputTokens - acc.cachedReadTokens - acc.cacheWriteTokens,
        ),
      },
    }),
  );
}

function extractFromDialect(dialect: UsageDialect, obj: Record<string, unknown>, acc: ObservedUsage): void {
  if (dialect === "anthropic") {
    // message_start: {type, message: {usage: {input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens?}}}
    // message_delta: {type, usage: {output_tokens}}
    const type = obj.type;
    if (type === "message_start") {
      const usage = (obj.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
      if (usage) {
        const uncached = toNumber(usage.input_tokens);
        acc.cacheWriteTokens = toNumber(usage.cache_creation_input_tokens);
        acc.cachedReadTokens = toNumber(usage.cache_read_input_tokens);
        // Anthropic reports UNCACHED input directly; normalize to total-in.
        acc.inputTokens = uncached + acc.cachedReadTokens + acc.cacheWriteTokens;
        acc.outputTokens = toNumber(usage.output_tokens);
        acc.explicitCacheReport = true;
      }
    } else if (type === "message_delta") {
      const usage = obj.usage as Record<string, unknown> | undefined;
      if (usage && usage.output_tokens !== undefined) {
        acc.outputTokens = toNumber(usage.output_tokens);
      }
    } else if (type === "message_stop") {
      acc.complete = true;
    } else if (obj.usage && obj.type === "message") {
      // Non-streaming: the whole message object.
      const usage = obj.usage as Record<string, unknown>;
      const uncached = toNumber(usage.input_tokens);
      acc.cacheWriteTokens = toNumber(usage.cache_creation_input_tokens);
      acc.cachedReadTokens = toNumber(usage.cache_read_input_tokens);
      acc.inputTokens = uncached + acc.cachedReadTokens + acc.cacheWriteTokens;
      acc.outputTokens = toNumber(usage.output_tokens);
      acc.explicitCacheReport = true;
      acc.complete = true;
    }
    return;
  }

  if (dialect === "openai-chat") {
    // Final stream chunk (or non-streaming body): {usage: {prompt_tokens, completion_tokens, prompt_tokens_details?: {cached_tokens, cache_write_tokens}}}
    const usage = obj.usage as Record<string, unknown> | undefined | null;
    if (usage) {
      const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
      // GPT-5.6+ reports cache WRITES separately from prompt_tokens (unlike
      // cached reads, which are a subset of it). Add writes back so inputTokens
      // is the true total and billing's uncached = in − read − write isolates
      // plain input. Absent on older models ⇒ 0 ⇒ unchanged behavior.
      const cacheWrite = details ? toNumber(details.cache_write_tokens) : 0;
      acc.inputTokens = toNumber(usage.prompt_tokens) + cacheWrite;
      acc.outputTokens = toNumber(usage.completion_tokens);
      acc.cacheWriteTokens = cacheWrite;
      if (details && (details.cached_tokens !== undefined || details.cache_write_tokens !== undefined)) {
        acc.cachedReadTokens = toNumber(details.cached_tokens);
        acc.explicitCacheReport = true;
      }
      acc.complete = true;
      debugOpenAICache("openai-chat", usage, details, acc);
    }
    return;
  }

  if (dialect === "openai-responses") {
    // {type:"response.completed", response:{usage:{input_tokens, input_tokens_details:{cached_tokens, cache_write_tokens}, output_tokens}}}
    const isCompleted = obj.type === "response.completed";
    const response = (isCompleted ? obj.response : obj.usage ? obj : null) as Record<string, unknown> | null;
    if (response) {
      const usage = response.usage as Record<string, unknown> | undefined;
      if (usage) {
        const details = usage.input_tokens_details as Record<string, unknown> | undefined;
        // GPT-5.6+ cache writes: reported separately from input_tokens — add
        // back for true total-in (see openai-chat above). 0 on older models.
        const cacheWrite = details ? toNumber(details.cache_write_tokens) : 0;
        acc.inputTokens = toNumber(usage.input_tokens) + cacheWrite;
        acc.outputTokens = toNumber(usage.output_tokens);
        acc.cacheWriteTokens = cacheWrite;
        if (details && (details.cached_tokens !== undefined || details.cache_write_tokens !== undefined)) {
          acc.cachedReadTokens = toNumber(details.cached_tokens);
          acc.explicitCacheReport = true;
        }
        acc.complete = true;
        debugOpenAICache("openai-responses", usage, details, acc);
      }
    }
    return;
  }

  // google: every chunk may carry usageMetadata; keep the LAST one.
  const meta = obj.usageMetadata as Record<string, unknown> | undefined;
  if (meta) {
    acc.inputTokens = toNumber(meta.promptTokenCount);
    acc.outputTokens = toNumber(meta.candidatesTokenCount) + toNumber(meta.thoughtsTokenCount);
    if (meta.cachedContentTokenCount !== undefined) {
      acc.cachedReadTokens = toNumber(meta.cachedContentTokenCount);
      acc.explicitCacheReport = true;
    }
    acc.complete = true; // last chunk wins; presence of usage marks completeness
  }
}

export function createUsageParser(dialect: UsageDialect, isStreaming: boolean): UsageParser {
  const acc: ObservedUsage = { ...EMPTY_USAGE };

  if (!isStreaming) {
    // Non-streaming: accumulate the (small) whole body, parse once.
    let buffer = "";
    return {
      push(chunkText) {
        if (buffer.length < MAX_PARSE_BUFFER) buffer += chunkText;
      },
      finish() {
        try {
          extractFromDialect(dialect, JSON.parse(buffer) as Record<string, unknown>, acc);
        } catch {
          // Unparseable body — settle with whatever we have (zeros).
        }
        return acc;
      },
    };
  }

  // Streaming: incremental SSE — split frames on blank lines, JSON-parse
  // `data:` payloads, discard everything else immediately.
  let buffer = "";
  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      extractFromDialect(dialect, JSON.parse(payload) as Record<string, unknown>, acc);
    } catch {
      // Torn/non-JSON frame — ignore.
    }
  };

  return {
    push(chunkText) {
      buffer += chunkText;
      if (buffer.length > MAX_PARSE_BUFFER) {
        // Pathological single line (giant base64 in a data frame) — drop up
        // to the last newline to bound state; usage frames are tiny so this
        // never discards one.
        const lastNewline = buffer.lastIndexOf("\n");
        if (lastNewline > 0) buffer = buffer.slice(lastNewline + 1);
        else buffer = buffer.slice(-1024);
      }
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        handleLine(line);
        idx = buffer.indexOf("\n");
      }
    },
    finish() {
      if (buffer) handleLine(buffer.replace(/\r$/, ""));
      return acc;
    },
  };
}

/* ------------------------------ response tee ------------------------------ */

/**
 * Tee the upstream body: returns the client branch untouched; drains the
 * meter branch through the parser and invokes `onDone` exactly once with the
 * final ObservedUsage — including on error/abort (partial usage settles).
 */
export function meterResponse(
  upstreamBody: ReadableStream<Uint8Array>,
  parser: UsageParser,
  onDone: (usage: ObservedUsage) => void,
): ReadableStream<Uint8Array> {
  const [clientBranch, meterBranch] = upstreamBody.tee();

  void (async () => {
    const decoder = new TextDecoder();
    const reader = meterBranch.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
    } catch {
      // Upstream error/abort — fall through and settle with partials.
    } finally {
      try {
        onDone(parser.finish());
      } catch {
        // Settlement errors must never propagate into the stream machinery.
      }
    }
  })();

  return clientBranch;
}

/* ---------------------------- clock heuristic ---------------------------- */

const CACHE_WINDOW_MS = 5 * 60 * 1000;
const LAST_CALL_TTL_SECONDS = 86_400;

/**
 * /api/agent's passive-cache clock heuristic, ported: providers that cache
 * by prefix but don't report it (fireworks, together) get their input billed
 * as cached when the previous call on the same key was within the cache
 * window. Keys are namespaced by provider + credMode so a BYOK call (user's
 * key ⇒ different provider-side cache) never marks the PLATFORM key's cache
 * warm — the legacy `last_call:${userId}:${projectId}` key is deliberately
 * not shared (cross-engine under-detection during the bake window
 * over-charges slightly, never under).
 */
export function clockHeuristicKey(input: {
  provider: string;
  credMode: string;
  userId: string;
  projectId: string;
}): string {
  return `llm-proxy:last_call:${input.provider}:${input.credMode}:${input.userId}:${input.projectId}`;
}

export async function applyClockHeuristic(
  usage: ObservedUsage,
  key: string,
  requestStartMs: number,
): Promise<ObservedUsage> {
  let adjusted = usage;
  if (!usage.explicitCacheReport && usage.cachedReadTokens === 0 && usage.inputTokens > 0) {
    const lastCallMs = (await redis.get<number>(key).catch(() => null)) ?? 0;
    if (lastCallMs > 0 && requestStartMs - Number(lastCallMs) < CACHE_WINDOW_MS) {
      adjusted = { ...usage, cachedReadTokens: usage.inputTokens };
    }
  }
  redis.setex(key, LAST_CALL_TTL_SECONDS, requestStartMs).catch(() => {});
  return adjusted;
}
