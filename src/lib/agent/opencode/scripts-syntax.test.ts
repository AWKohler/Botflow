/**
 * Syntax gate for the generated sandbox scripts: write each source to a temp
 * file and run `node --check` on it. Template-literal escaping bugs (a bare
 * ${ or backtick in the embedded JS) bit the CC bridge before — this catches
 * them at test time instead of inside a live sandbox.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { OPENCODE_BRIDGE_SOURCE } from "./bridge-script";
import { OPENCODE_MCP_SCRIPT_SOURCE } from "./mcp-script";

function checkSyntax(name: string, source: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "botflow-oc-scripts-"));
  const file = path.join(dir, name);
  writeFileSync(file, source, "utf-8");
  // Throws (with stderr attached) on a syntax error.
  execFileSync(process.execPath, ["--check", file], { encoding: "utf-8" });
}

test("opencode bridge script parses as valid ESM", () => {
  assert.doesNotThrow(() => checkSyntax("opencode-bridge.mjs", OPENCODE_BRIDGE_SOURCE));
});

test("botflow MCP script parses as valid ESM", () => {
  assert.doesNotThrow(() => checkSyntax("botflow-mcp.mjs", OPENCODE_MCP_SCRIPT_SOURCE));
});

test("MCP script embeds every host-tool definition", async () => {
  const { HOST_TOOL_DEFINITIONS } = await import("@/lib/agent/host-tools/definitions");
  for (const name of Object.keys(HOST_TOOL_DEFINITIONS)) {
    assert.ok(
      OPENCODE_MCP_SCRIPT_SOURCE.includes(`"${name}"`),
      `definition for ${name} missing from generated MCP script`,
    );
  }
});
