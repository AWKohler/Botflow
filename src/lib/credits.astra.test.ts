/**
 * Pricing gates for GPT-6 Astra — the one model in the registry whose rates
 * change with prompt size, and the first OpenAI model whose long-context tier
 * has to account for billed cache WRITES.
 *
 * OpenAI's published rates ($/MTok):
 *   standard (≤272K input):  10 in / 1 cached / 12.50 cache-write / 50 out
 *   long context (>272K):    20 in / 2 cached / 25    cache-write / 75 out
 * Credits are $/MTok ÷ 0.30 (the MiniMax input base), applied per token.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { calculateCredits, MODEL_PRICING, MODEL_COST_MULTIPLIER } from "@/lib/credits";
import { MODEL_CONFIGS } from "@/lib/agent/models";
import { MODEL_TIER_REQUIREMENT } from "@/lib/tier-shared";

describe("gpt-6-astra pricing", () => {
  test("standard rates apply at or below the 272K input threshold", () => {
    // 272K exactly is still standard — the tier is strictly greater-than.
    const credits = calculateCredits({
      model: "gpt-6-astra",
      inputTokens: 272_000,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
    });
    const expected = Math.ceil(272_000 * (10 / 0.3) + 1_000 * (50 / 0.3));
    assert.equal(credits, expected);
  });

  test("every axis matches the published standard rates", () => {
    const p = MODEL_PRICING["gpt-6-astra"];
    assert.equal(Math.round(p.input * 0.3 * 100) / 100, 10);
    assert.equal(Math.round(p.cachedInput * 0.3 * 100) / 100, 1);
    assert.equal(Math.round((p.cacheWrite ?? 0) * 0.3 * 100) / 100, 12.5);
    assert.equal(Math.round(p.output * 0.3 * 100) / 100, 50);
  });

  test("past 272K the WHOLE request reprices: 2x in/cache, 1.5x out", () => {
    const inputTokens = 272_001;
    const outputTokens = 10_000;
    const credits = calculateCredits({
      model: "gpt-6-astra",
      inputTokens,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens,
    });
    // Long-context rates applied to the entire request, not just the overage.
    const expected = Math.ceil(inputTokens * (20 / 0.3) + outputTokens * (75 / 0.3));
    assert.equal(credits, expected);

    const standard = Math.ceil(inputTokens * (10 / 0.3) + outputTokens * (50 / 0.3));
    assert.ok(credits > standard, "long-context request must cost more than standard");
  });

  test("the threshold counts cache reads and writes, not just uncached input", () => {
    // Three disjoint slices summing to 272,003 — none large enough alone.
    const overByCacheSlices = calculateCredits({
      model: "gpt-6-astra",
      inputTokens: 100_000,
      cachedReadTokens: 100_000,
      cacheWriteTokens: 72_003,
      outputTokens: 0,
    });
    const atLongContextRates = Math.ceil(
      100_000 * (20 / 0.3) + 100_000 * (2 / 0.3) + 72_003 * (25 / 0.3),
    );
    assert.equal(
      overByCacheSlices,
      atLongContextRates,
      "a prompt pushed over 272K by cached/written tokens must still trip the tier",
    );
  });

  test("registry, tier and cost multiplier agree with the pricing", () => {
    assert.equal(MODEL_CONFIGS["gpt-6-astra"].maxContextTokens, 1_050_000);
    assert.equal(MODEL_CONFIGS["gpt-6-astra"].supportsImages, true);
    assert.equal(MODEL_CONFIGS["gpt-6-astra"].apiModelId, "gpt-6-astra");
    // Max-only on the platform key: identical rates to Claude Fable 5.
    assert.equal(MODEL_TIER_REQUIREMENT["gpt-6-astra"], "max");
    assert.equal(MODEL_COST_MULTIPLIER["gpt-6-astra"], MODEL_COST_MULTIPLIER["claude-fable-5"]);
    assert.deepEqual(MODEL_PRICING["gpt-6-astra"], MODEL_PRICING["claude-fable-5"]);
  });
});

describe("long-context threshold regression — cache writes are counted", () => {
  test("gemini and grok are unaffected (they never report cache writes)", () => {
    // Guard on the shared totalInputTokens expression: adding cacheWriteTokens
    // must stay a no-op for the two models whose dialects always report 0.
    for (const model of ["gemini-3.1-pro-preview", "grok-4.5"] as const) {
      const under = calculateCredits({
        model,
        inputTokens: 200_000,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1_000,
      });
      const p = MODEL_PRICING[model];
      assert.equal(
        under,
        Math.ceil(200_000 * p.input + 1_000 * p.output),
        `${model} at exactly 200K must still use standard rates`,
      );
    }
  });
});
