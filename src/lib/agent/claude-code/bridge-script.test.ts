/**
 * Syntax gate for the Claude Code bridge: the script is one template literal,
 * so a stray backtick or `${` in a tool description breaks it only inside a
 * live sandbox. Same check the OpenCode scripts get (opencode/scripts-syntax).
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BRIDGE_SCRIPT_SOURCE } from "./bridge-script";

test("claude code bridge script parses as valid ESM", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "botflow-cc-bridge-")), "bridge.mjs");
  writeFileSync(file, BRIDGE_SCRIPT_SOURCE, "utf-8");
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", file], { encoding: "utf-8" }));
});

test("the RevenueCat tools are registered with the literal package keys intact", () => {
  for (const name of [
    "initialize_revenuecat_payments",
    "get_revenuecat_products",
    "create_revenuecat_product",
    "remove_revenuecat_package",
  ]) {
    assert.ok(BRIDGE_SCRIPT_SOURCE.includes(`makeHostToolHandler("${name}")`), name);
  }
  // "$rc_monthly" must survive the template literal (no accidental interpolation).
  assert.ok(BRIDGE_SCRIPT_SOURCE.includes("$rc_monthly"));
});
