/**
 * The selector's "xN" hint must stay in sync with the pricing table:
 * ModelConfig.costMultiplier is hand-written (client-safe), the formula lives
 * in credits.ts. Update both together when a price changes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { costMultiplierFromPricing } from "@/lib/credits";
import { MODEL_CONFIGS, type ModelId } from "@/lib/agent/models";

describe("selector cost multiplier", () => {
  for (const id of Object.keys(MODEL_CONFIGS) as ModelId[]) {
    test(`${id}: costMultiplier matches its pricing`, () => {
      assert.equal(MODEL_CONFIGS[id].costMultiplier, costMultiplierFromPricing(id));
    });
  }

  test("MiniMax-M3 is the x1 anchor", () => {
    assert.equal(costMultiplierFromPricing("fireworks-minimax-m3"), 1);
  });
});
