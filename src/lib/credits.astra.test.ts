/**
 * Pricing gates for GPT-6.2 Astra — the priciest OpenAI model in the
 * registry, whose rates change with prompt size and whose long-context tier
 * has to account for billed cache WRITES.
 *
 * OpenAI's published rates ($/MTok):
 *   standard (≤272K input):   8 in / 0.40 cached / 10 cache-write / 40 out
 *   long context (>272K):    16 in / 0.80 cached / 20 cache-write / 60 out
 * Credits are $/MTok ÷ 0.30 (the MiniMax input base), applied per token.
 */
import { test, describe } from "vitest";
import assert from "node:assert/strict";

import { calculateCredits, MODEL_PRICING, MODEL_COST_MULTIPLIER, costMultiplierFromPricing } from "@/lib/credits";
import { MODEL_CONFIGS } from "@/lib/agent/models";
import { MODEL_TIER_REQUIREMENT } from "@/lib/tier-shared";

describe("gpt-6.2-astra pricing", () => {
  test("standard rates apply at or below the 272K input threshold", () => {
    // 272K exactly is still standard — the tier is strictly greater-than.
    const credits = calculateCredits({
      model: "gpt-6.2-astra",
      inputTokens: 272_000,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
    });
    const expected = Math.ceil(272_000 * (8 / 0.3) + 1_000 * (40 / 0.3));
    assert.equal(credits, expected);
  });

  test("every axis matches the published standard rates", () => {
    const p = MODEL_PRICING["gpt-6.2-astra"];
    assert.equal(Math.round(p.input * 0.3 * 100) / 100, 8);
    assert.equal(Math.round(p.cachedInput * 0.3 * 100) / 100, 0.4);
    assert.equal(Math.round((p.cacheWrite ?? 0) * 0.3 * 100) / 100, 10);
    assert.equal(Math.round(p.output * 0.3 * 100) / 100, 40);
  });

  test("past 272K the WHOLE request reprices: 2x in/cache, 1.5x out", () => {
    const inputTokens = 272_001;
    const outputTokens = 10_000;
    const credits = calculateCredits({
      model: "gpt-6.2-astra",
      inputTokens,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens,
    });
    // Long-context rates applied to the entire request, not just the overage.
    const expected = Math.ceil(inputTokens * (16 / 0.3) + outputTokens * (60 / 0.3));
    assert.equal(credits, expected);

    const standard = Math.ceil(inputTokens * (8 / 0.3) + outputTokens * (40 / 0.3));
    assert.ok(credits > standard, "long-context request must cost more than standard");
  });

  test("the threshold counts cache reads and writes, not just uncached input", () => {
    // Three disjoint slices summing to 272,003 — none large enough alone.
    const overByCacheSlices = calculateCredits({
      model: "gpt-6.2-astra",
      inputTokens: 100_000,
      cachedReadTokens: 100_000,
      cacheWriteTokens: 72_003,
      outputTokens: 0,
    });
    const atLongContextRates = Math.ceil(
      100_000 * (16 / 0.3) + 100_000 * (0.8 / 0.3) + 72_003 * (20 / 0.3),
    );
    assert.equal(
      overByCacheSlices,
      atLongContextRates,
      "a prompt pushed over 272K by cached/written tokens must still trip the tier",
    );
  });

  test("registry, tier and cost multiplier agree with the pricing", () => {
    assert.equal(MODEL_CONFIGS["gpt-6.2-astra"].maxContextTokens, 1_050_000);
    assert.equal(MODEL_CONFIGS["gpt-6.2-astra"].supportsImages, true);
    assert.equal(MODEL_CONFIGS["gpt-6.2-astra"].apiModelId, "gpt-6.2-astra");
    // Max-only on the platform key (Fable-class $8/$40 list price).
    assert.equal(MODEL_TIER_REQUIREMENT["gpt-6.2-astra"], "max");
    assert.equal(MODEL_COST_MULTIPLIER["gpt-6.2-astra"], costMultiplierFromPricing("gpt-6.2-astra"));
  });
});

describe("long-context threshold regression — cache writes are counted", () => {
  test("grok is unaffected (it never reports cache writes)", () => {
    // Guard on the shared totalInputTokens expression: adding cacheWriteTokens
    // must stay a no-op for a dialect that always reports 0. xAI bills long
    // once the prompt REACHES 200K, so 199,999 is its last short-rate prompt.
    for (const [model, lastShort] of [["grok-4.7", 199_999]] as const) {
      const under = calculateCredits({
        model,
        inputTokens: lastShort,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1_000,
      });
      const p = MODEL_PRICING[model];
      assert.equal(
        under,
        Math.ceil(lastShort * p.input + 1_000 * p.output),
        `${model} at ${lastShort} must still use standard rates`,
      );
    }
  });
});
