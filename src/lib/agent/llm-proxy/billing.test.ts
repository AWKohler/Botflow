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
      computeSettlementCredits(usageOf(50_000, 2_000, 10_000, 0), "gpt-5.6-terra", "byok"),
      0,
    );
    assert.equal(
      computeSettlementCredits(usageOf(50_000, 2_000, 10_000, 0), "claude-sonnet-5", "oauth"),
      0,
    );
  });

  test("long-context surcharge triggers off uncached+cachedRead (gemini past 200K)", () => {
    const below = computeSettlementCredits(usageOf(200_000, 1_000, 100_000, 0), "gemini-3.1-pro-preview", "platform");
    const above = computeSettlementCredits(usageOf(300_000, 1_000, 200_000, 0), "gemini-3.1-pro-preview", "platform");
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

  test("GPT-5.6 cache WRITES bill at the 1.25× premium (> same tokens as plain input)", () => {
    // usageOf's first arg is prompt_tokens (the total) — reads AND writes are
    // SUBSETS of it, not added on top (live-verified). Reclassifying 800 tokens
    // from plain uncached (1×) to cache-WRITE (1.25×) must cost strictly more.
    const asWrite = computeSettlementCredits(usageOf(12_800, 300, 11_500, 800), "gpt-5.6-sol", "platform");
    const asPlainInput = computeSettlementCredits(usageOf(12_800, 300, 11_500, 0), "gpt-5.6-sol", "platform");
    // Writes cost 1.25× input, so reclassifying them as 1× plain input is cheaper.
    assert.ok(asWrite > asPlainInput, `write premium should exceed plain input: ${asWrite} vs ${asPlainInput}`);
    // And Terra/Luna price writes proportionally to their own input rate.
    assert.ok(
      computeSettlementCredits(usageOf(2_000, 100, 0, 1_600), "gpt-5.6-luna", "platform") >
      computeSettlementCredits(usageOf(2_000, 100, 0, 0), "gpt-5.6-luna", "platform"),
    );
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
