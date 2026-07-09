/**
 * Billing-math parity: the proxy's settle formula must equal a
 * transliteration of /api/agent's onFinish path (uncached = max(0, in − read
 * − write) → calculateCredits, personal creds ⇒ 0) for every priced model,
 * including the long-context surcharges keyed off uncached+cachedRead.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { calculateCredits, MODEL_PRICING } from "@/lib/credits";
import { MODEL_CONFIGS, type ModelId } from "@/lib/agent/models";
import {
  computeSettlementCredits,
  estimateRequestCredits,
  modelIdForProviderModel,
  creditsExhaustedResponse,
  dialectErrorResponse,
} from "./billing";
import type { ObservedUsage } from "./usage-meter";

function usageOf(input: number, out: number, read: number, write: number): ObservedUsage {
  return {
    inputTokens: input,
    outputTokens: out,
    cachedReadTokens: read,
    cacheWriteTokens: write,
    explicitCacheReport: true,
    complete: true,
  };
}

/** Transliteration of /api/agent route.ts onFinish (the pre-proxy billing). */
function legacyOnFinishCredits(
  model: ModelId,
  tokensIn: number,
  tokensOut: number,
  cachedRead: number,
  cachedWrite: number,
  personalCreds: boolean,
): number {
  if (personalCreds) return 0;
  const uncachedInput = Math.max(0, tokensIn - cachedRead - cachedWrite);
  return calculateCredits({
    model,
    inputTokens: uncachedInput,
    outputTokens: tokensOut,
    cachedReadTokens: cachedRead,
    cacheWriteTokens: cachedWrite,
  });
}

describe("settlement credit parity with /api/agent", () => {
  const scenarios = [
    { in: 32_100, out: 450, read: 30_000, write: 2_000 }, // anthropic cache-heavy
    { in: 12_000, out: 300, read: 11_500, write: 0 },     // openai warm cache
    { in: 900, out: 100, read: 900, write: 0 },           // clock-heuristic full-cache
    { in: 50_000, out: 8_000, read: 0, write: 0 },        // cold
    { in: 300_000, out: 4_000, read: 280_000, write: 0 }, // long-context surcharge territory
  ];

  test("platform mode equals the legacy formula for every priced model", () => {
    for (const modelId of Object.keys(MODEL_PRICING)) {
      if (!(modelId in MODEL_CONFIGS)) continue; // pricing table may carry aliases
      for (const s of scenarios) {
        const proxy = computeSettlementCredits(
          usageOf(s.in, s.out, s.read, s.write),
          modelId as ModelId,
          "platform",
        );
        const legacy = legacyOnFinishCredits(
          modelId as ModelId, s.in, s.out, s.read, s.write, false,
        );
        assert.equal(proxy, legacy, `${modelId} ${JSON.stringify(s)}`);
      }
    }
  });

  test("personal-cred modes bill zero, exactly like isUsingPersonalCredentials", () => {
    assert.equal(
      computeSettlementCredits(usageOf(50_000, 2_000, 10_000, 0), "gpt-5.4", "byok"),
      0,
    );
    assert.equal(
      computeSettlementCredits(usageOf(50_000, 2_000, 10_000, 0), "claude-sonnet-5", "oauth"),
      0,
    );
  });

  test("long-context surcharge triggers off uncached+cachedRead (gpt-5.4 past 272K)", () => {
    const below = computeSettlementCredits(usageOf(200_000, 1_000, 100_000, 0), "gpt-5.4", "platform");
    const above = computeSettlementCredits(usageOf(300_000, 1_000, 200_000, 0), "gpt-5.4", "platform");
    // Same output; above-threshold input must be priced strictly steeper than
    // a linear scale of the below-threshold rate.
    const belowPerToken = below / 200_000;
    const abovePerToken = above / 300_000;
    assert.ok(abovePerToken > belowPerToken, `expected surcharge: ${abovePerToken} > ${belowPerToken}`);
  });

  test("anthropic cache WRITES are billed (never free)", () => {
    const withWrite = computeSettlementCredits(usageOf(10_000, 100, 0, 8_000), "claude-opus-4-8", "platform");
    const withoutWrite = computeSettlementCredits(usageOf(2_000, 100, 0, 0), "claude-opus-4-8", "platform");
    assert.ok(withWrite > withoutWrite);
  });

  test("grok-4.5 credits reconcile to xAI's live billing (captured cost_in_usd_ticks)", () => {
    // Real cold call captured from api.x.ai (1 tick = 1e-10 USD):
    //   prompt_tokens=7755 (cached_tokens=128, a subset), output=completion(1)+reasoning(177)=178
    //   cost_in_usd_ticks=163_860_000 → $0.016386
    // 1 credit = $0.30/MTok = $3e-7, so $0.016386 / 3e-7 = 54_620 credits.
    const credits = computeSettlementCredits(usageOf(7755, 178, 128, 0), "grok-4.5", "platform");
    const dollarsFromTicks = 163_860_000 * 1e-10;      // $0.016386
    const expected = dollarsFromTicks / 3e-7;           // 54_620 credits ($3e-7 = 1 credit)
    // calculateCredits Math.ceil's the FP sum, so allow the ≤1-credit ceil artifact.
    assert.ok(Math.abs(credits - expected) <= 1, `grok credits ${credits} vs xAI-derived ${expected}`);
  });
});

describe("reservation estimate", () => {
  test("input bounded by the model's context window (base64 blobs can't over-reserve)", () => {
    const huge = estimateRequestCredits("claude-sonnet-5", 100 * 1024 * 1024, 32_000);
    const atContext = estimateRequestCredits(
      "claude-sonnet-5",
      MODEL_CONFIGS["claude-sonnet-5"].maxContextTokens * 4,
      32_000,
    );
    assert.equal(huge, atContext);
  });

  test("estimate is an upper bound for typical settled cost of the same request", () => {
    const bodyBytes = 40_000; // ~10K tokens estimated
    const reserved = estimateRequestCredits("fireworks-minimax-m3", bodyBytes, 32_000);
    const settled = computeSettlementCredits(
      usageOf(9_000, 4_000, 8_000, 0), // real usage under the estimate
      "fireworks-minimax-m3",
      "platform",
    );
    assert.ok(reserved >= settled);
  });

  test("free tier can afford a typical opencode request (32K inserted cap must NOT reserve the whole weekly budget)", () => {
    // opencode sets no max_tokens; the rewrite inserts the 32K cap. The
    // reservation must use the realistic output estimate, not the cap —
    // otherwise MiniMax's 4.0 output multiplier alone (128K credits) exceeds
    // the free tier's default 125K weekly budget and every call 402s.
    const reserved = estimateRequestCredits("fireworks-minimax-m3", 20_000, 32_000);
    const FREE_WEEKLY_DEFAULT = 500_000 / 4;
    assert.ok(
      reserved < FREE_WEEKLY_DEFAULT,
      `reservation ${reserved} would exceed the free weekly budget ${FREE_WEEKLY_DEFAULT}`,
    );
  });
});

describe("model reverse-mapping", () => {
  test("apiModelIds map back; Together kimi maps to the fireworks pricing id", () => {
    assert.equal(modelIdForProviderModel("accounts/fireworks/models/kimi-k2p7-code"), "fireworks-kimi-k2p7");
    assert.equal(modelIdForProviderModel("moonshotai/Kimi-K2.7-Code"), "fireworks-kimi-k2p7");
    assert.equal(modelIdForProviderModel("claude-sonnet-5"), "claude-sonnet-5");
    assert.equal(modelIdForProviderModel("claude-haiku-4-5-20251001"), null); // CC background model — skip row
    assert.equal(modelIdForProviderModel(null), null);
  });
});

describe("dialect error shapes", () => {
  test("402 bodies match each provider's native error envelope", async () => {
    const anthropic = creditsExhaustedResponse("anthropic");
    assert.equal(anthropic.status, 402);
    const aBody = await anthropic.json();
    assert.equal(aBody.type, "error");
    assert.match(aBody.error.message, /credits exhausted/i);

    const openai = creditsExhaustedResponse("openai");
    const oBody = await openai.json();
    assert.equal(oBody.error.code, "insufficient_quota");

    const google = dialectErrorResponse("google", 402, "nope", "insufficient_quota");
    const gBody = await google.json();
    assert.equal(gBody.error.status, "RESOURCE_EXHAUSTED");
  });
});
