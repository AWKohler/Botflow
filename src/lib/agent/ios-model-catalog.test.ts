/**
 * The iOS app keeps its own copy of the model lineup
 * (ios/Botflow/Core/ModelCatalog.swift). This reads that Swift source and
 * checks it against MODEL_CONFIGS / MODEL_TIER_REQUIREMENT /
 * resolveModelId, so a lineup change can't ship to one client only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { MODEL_CONFIGS, DEFAULT_MODEL_ID, resolveModelId } from "@/lib/agent/models";
import { MODEL_TIER_REQUIREMENT } from "@/lib/tier-shared";

const swift = readFileSync(
  path.join(__dirname, "../../../ios/Botflow/Core/ModelCatalog.swift"),
  "utf8",
);

interface SwiftModel {
  id: string;
  name: string;
  provider: string;
  contextTokens: number;
  personalContextTokens?: number;
  costMultiplier: number;
  requiredTier: string;
  supportsImages: boolean;
}

function parseModels(): SwiftModel[] {
  const rows = [...swift.matchAll(/AIModel\((id: "[^"]+"[^\n]*)\)/g)].map((m) => m[1]);
  return rows.map((row) => {
    const str = (key: string) => new RegExp(`${key}: "([^"]+)"`).exec(row)?.[1];
    const num = (key: string) => {
      const v = new RegExp(`${key}: ([\\d_.]+)`).exec(row)?.[1];
      return v === undefined ? undefined : Number(v.replace(/_/g, ""));
    };
    return {
      id: str("id")!,
      name: str("name")!,
      provider: /provider: \.(\w+)/.exec(row)![1],
      contextTokens: num("contextTokens")!,
      personalContextTokens: num("personalContextTokens"),
      costMultiplier: num("costMultiplier")!,
      requiredTier: /requiredTier: \.(\w+)/.exec(row)![1],
      supportsImages: !/supportsImages: false/.test(row),
    };
  });
}

function parseAliases(): Record<string, string> {
  const block = /private static let aliases: \[String: String\] = \[([\s\S]*?)\n {4}\]/.exec(swift)?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/"([^"]+)": "([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

describe("iOS ModelCatalog mirrors the web registry", () => {
  const models = parseModels();

  test("same model ids, and the same default", () => {
    assert.deepEqual(
      models.map((m) => m.id).sort(),
      Object.keys(MODEL_CONFIGS).sort(),
    );
    assert.equal(/static let defaultId = "([^"]+)"/.exec(swift)?.[1], DEFAULT_MODEL_ID);
  });

  test("each model's name, provider, window, images, cost and tier match", () => {
    for (const m of models) {
      const c = MODEL_CONFIGS[m.id as keyof typeof MODEL_CONFIGS];
      assert.equal(m.name, c.displayName, m.id);
      assert.equal(m.provider, c.provider, m.id);
      assert.equal(m.contextTokens, c.maxContextTokens, m.id);
      assert.equal(m.personalContextTokens, c.personalCredContextTokens, m.id);
      assert.equal(m.supportsImages, c.supportsImages, m.id);
      assert.equal(m.costMultiplier, c.costMultiplier, m.id);
      assert.equal(m.requiredTier, MODEL_TIER_REQUIREMENT[m.id] ?? "free", m.id);
    }
  });

  test("listed cheapest first, like the web selector", () => {
    const costs = models.map((m) => m.costMultiplier);
    assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
  });

  test("every iOS alias resolves to the same successor as the web", () => {
    const aliases = parseAliases();
    assert.ok(Object.keys(aliases).length > 0, "no aliases parsed");
    for (const [from, to] of Object.entries(aliases)) {
      assert.equal(to, resolveModelId(from), from);
    }
  });
});
