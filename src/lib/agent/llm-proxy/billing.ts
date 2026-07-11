/**
 * Billing at the LLM proxy — the ONLY component allowed to turn observed
 * usage into money. Same machinery /api/agent has always used
 * (calculateCredits / reservePlatformCredits / adjustPlatformCredits /
 * recordTokenUsage), moved to the trustworthy vantage point.
 *
 * Modes:
 *  - platform  — worst-case per-request reservation (atomic INCRBY against
 *                the weekly budget) before forwarding, reconciled down to
 *                the meter's observed usage after. Monthly + tier gates are
 *                NOT checked here (a Neon SUM per LLM call is too hot) —
 *                the agent routes check them at token-mint time; the weekly
 *                reservation is the binding per-request limiter, exactly
 *                the split /api/agent uses.
 *  - byok/oauth — no reservation, credits=0; usage still recorded for the
 *                audit trail (parity with /api/agent's personal-cred rule).
 *
 * The pure money math lives in exported helpers so tests can pin it against
 * a transliteration of /api/agent's onFinish formula without any I/O fakes.
 */
import {
  calculateCredits,
  reservePlatformCredits,
  adjustPlatformCredits,
  getWeeklyLimit,
  getMonthlyLimit,
} from "@/lib/credits";
import { recordTokenUsage } from "@/lib/usage";
import { MODEL_CONFIGS, type ModelId } from "@/lib/agent/models";
import { TOGETHER_KIMI_MODEL } from "@/lib/agent/opencode/models";
import type { Tier } from "@/lib/tier";
import type { LlmProxyBinding } from "./token";
import type { LlmProxyProvider } from "./providers";
import type { ObservedUsage } from "./usage-meter";

/* ------------------------------ pure helpers ------------------------------ */

/** Output-token figure used for RESERVATION math. Deliberately smaller than
 *  the hard output CAP (PLATFORM_MAX_OUTPUT_TOKENS): reserving the full 32K
 *  cap would exceed the free tier's entire default weekly budget on
 *  high-output-multiplier models (32K × MiniMax's 4.0 ≈ 128K credits vs a
 *  125K weekly default) and 402 every request. Typical agent-loop responses
 *  are far below the cap; when one runs long, settlement adjusts UP — the
 *  overshoot is bounded to (cap − estimate) × outputPrice for the one
 *  in-flight request. */
const RESERVE_OUTPUT_TOKENS =
  Number(process.env.LLM_PROXY_RESERVE_OUTPUT_TOKENS) || 8_192;

/** Credit estimate for a request about to be forwarded: input from body size
 *  (chars/4, bounded by the model's context window — base64 images over-count
 *  ~3x, the bound keeps that sane) + the reservation output estimate. */
export function estimateRequestCredits(
  modelId: ModelId,
  bodyBytes: number,
  effectiveMaxOutput: number,
): number {
  const maxContext = MODEL_CONFIGS[modelId]?.maxContextTokens ?? 200_000;
  const inputEstimate = Math.min(Math.ceil(bodyBytes / 4), maxContext);
  return calculateCredits({
    model: modelId,
    inputTokens: inputEstimate,
    outputTokens: Math.min(effectiveMaxOutput, RESERVE_OUTPUT_TOKENS),
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

/** The settle-side money math — /api/agent's onFinish formula verbatim:
 *  uncached = max(0, in − read − write); personal creds bill zero. */
export function computeSettlementCredits(
  usage: ObservedUsage,
  modelId: ModelId,
  credMode: LlmProxyBinding["credMode"],
): number {
  if (credMode !== "platform") return 0;
  const uncachedInput = Math.max(
    0,
    usage.inputTokens - usage.cachedReadTokens - usage.cacheWriteTokens,
  );
  return calculateCredits({
    model: modelId,
    inputTokens: uncachedInput,
    outputTokens: usage.outputTokens,
    cachedReadTokens: usage.cachedReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  });
}

/** Reverse-map a provider-native model id onto our pricing ModelId. Personal
 *  modes may legitimately carry models we don't price (Claude Code's
 *  Haiku-class background calls) — those return null and skip the usage row. */
export function modelIdForProviderModel(providerModel: string | null): ModelId | null {
  if (!providerModel) return null;
  if (providerModel === TOGETHER_KIMI_MODEL) return "fireworks-kimi-k2p7";
  for (const config of Object.values(MODEL_CONFIGS)) {
    if (config.apiModelId === providerModel) return config.id;
  }
  return null;
}

/* ------------------------------ reservations ------------------------------ */

export async function reserveForRequest(
  binding: LlmProxyBinding,
  tier: Tier,
  estimate: { bodyBytes: number; effectiveMaxOutput: number },
): Promise<
  | { ok: true; reserved: number }
  | { ok: false; reason: "weekly_exhausted" | "monthly_exceeded" }
> {
  const reserved = estimateRequestCredits(
    binding.modelId,
    estimate.bodyBytes,
    estimate.effectiveMaxOutput,
  );
  // Weekly pacing with monthly spillover: a request that straddles the weekly
  // boundary is allowed (the overshoot draws on monthly headroom); the monthly
  // budget is the hard ceiling. See reservePlatformCredits for the paradigm.
  const res = await reservePlatformCredits(
    binding.userId,
    reserved,
    getWeeklyLimit(tier),
    getMonthlyLimit(tier),
  );
  return res.ok ? { ok: true, reserved } : { ok: false, reason: res.reason };
}

/**
 * Exactly-once settlement handle for one proxied request. The route calls
 * `settle(usage, observedModel)` from the meter's onDone AND from error
 * paths; only the first call wins. Unsettled reservations self-expire with
 * the weekly key's TTL (same exposure /api/agent accepts on process death).
 */
export function createSettlement(
  binding: LlmProxyBinding,
  reserved: number, // 0 in personal modes
) {
  let settled = false;
  return async function settle(
    usage: ObservedUsage | null,
    observedProviderModel: string | null,
  ): Promise<void> {
    if (settled) return;
    settled = true;

    const effective = usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      explicitCacheReport: false,
      complete: false,
    };

    // Personal-mode requests can run models outside our registry; bill-side
    // rows are keyed by pricing ModelId, so unmapped models skip the row.
    // Platform mode always maps (the allowlist made sure of it) — fall back
    // to the binding's modelId defensively.
    const rowModelId =
      modelIdForProviderModel(observedProviderModel) ??
      (binding.credMode === "platform" ? binding.modelId : null);

    const credits = rowModelId
      ? computeSettlementCredits(effective, rowModelId, binding.credMode)
      : 0;

    if (binding.credMode === "platform") {
      // Reconcile the worst-case reservation down (or release it entirely on
      // zero-usage failures) — both KV counters together.
      await adjustPlatformCredits(binding.userId, credits - reserved).catch(() => {});
    }

    if (rowModelId && (effective.inputTokens > 0 || effective.outputTokens > 0)) {
      await recordTokenUsage(
        binding.userId,
        rowModelId,
        effective.inputTokens,
        effective.outputTokens,
        credits,
        effective.cachedReadTokens,
        effective.cacheWriteTokens,
        { countTurn: false }, // turns are marked once at spawn by the agent routes
      ).catch(() => {});
    } else if (!rowModelId && observedProviderModel) {
      console.log(
        JSON.stringify({
          tag: "llm-proxy",
          event: "unpriced_model_skipped",
          provider: binding.provider,
          credMode: binding.credMode,
          model: observedProviderModel,
        }),
      );
    }
  };
}

/* ------------------------------ error shapes ------------------------------ */

const EXHAUSTED_MESSAGES = {
  weekly_exhausted:
    "Botflow credits exhausted — your weekly credit budget is used up. Upgrade your plan or wait for the weekly reset.",
  monthly_exceeded:
    "Botflow credits exhausted — this request doesn't fit your remaining monthly credit budget. Upgrade your plan or wait for the monthly reset.",
} as const;

/** 402 in the PROVIDER'S native error dialect so the in-sandbox agent
 *  surfaces the message verbatim as a provider error. */
export function creditsExhaustedResponse(
  provider: LlmProxyProvider,
  reason: keyof typeof EXHAUSTED_MESSAGES = "weekly_exhausted",
): Response {
  return dialectErrorResponse(provider, 402, EXHAUSTED_MESSAGES[reason], "insufficient_quota");
}

export function dialectErrorResponse(
  provider: LlmProxyProvider,
  status: number,
  message: string,
  code: string,
): Response {
  let body: unknown;
  if (provider === "anthropic") {
    body = { type: "error", error: { type: "invalid_request_error", message } };
  } else if (provider === "google") {
    body = { error: { code: status, message, status: "RESOURCE_EXHAUSTED" } };
  } else {
    body = { error: { message, type: code, code } };
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
