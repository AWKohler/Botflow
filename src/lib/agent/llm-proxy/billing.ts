/**
 * Billing at the LLM proxy — the ONLY component allowed to turn observed
 * usage into money. Same machinery /api/agent has always used
 * (calculateCredits / reserveWeeklyCredits / adjustWeeklyCredits /
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
  reserveWeeklyCredits,
  adjustWeeklyCredits,
  getWeeklyLimit,
} from "@/lib/credits";
import { recordTokenUsage } from "@/lib/usage";
import { MODEL_CONFIGS, type ModelId } from "@/lib/agent/models";
import { TOGETHER_KIMI_MODEL } from "@/lib/agent/opencode/models";
import type { Tier } from "@/lib/tier";
import type { LlmProxyBinding } from "./token";
import type { LlmProxyProvider } from "./providers";
import type { ObservedUsage } from "./usage-meter";

/* ------------------------------ pure helpers ------------------------------ */

/** Worst-case credit estimate for a request about to be forwarded: input from
 *  body size (chars/4, bounded by the model's context window — base64 images
 *  over-count ~3x, the bound keeps that sane) + the post-clamp output cap. */
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
    outputTokens: effectiveMaxOutput,
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
): Promise<{ ok: true; reserved: number } | { ok: false }> {
  const reserved = estimateRequestCredits(
    binding.modelId,
    estimate.bodyBytes,
    estimate.effectiveMaxOutput,
  );
  const ok = await reserveWeeklyCredits(binding.userId, reserved, getWeeklyLimit(tier));
  return ok ? { ok: true, reserved } : { ok: false };
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
      // zero-usage failures).
      await adjustWeeklyCredits(binding.userId, credits - reserved).catch(() => {});
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

const EXHAUSTED_MESSAGE =
  "Botflow credits exhausted — your weekly credit budget is used up. Upgrade your plan or wait for the weekly reset.";

/** 402 in the PROVIDER'S native error dialect so the in-sandbox agent
 *  surfaces the message verbatim as a provider error. */
export function creditsExhaustedResponse(provider: LlmProxyProvider): Response {
  return dialectErrorResponse(provider, 402, EXHAUSTED_MESSAGE, "insufficient_quota");
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
