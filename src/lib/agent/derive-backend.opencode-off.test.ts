/**
 * Flag-OFF regression matrix: with NEXT_PUBLIC_OPENCODE_BACKEND_ENABLED unset,
 * every routing decision must be byte-identical to pre-OpenCode behavior —
 * non-Anthropic models never leave the Botflow engine, regardless of personal
 * credentials.
 *
 * Companion to derive-backend.opencode-on.test.ts (separate file = separate
 * process, which is what lets the module-level flag consts differ).
 *
 * Run: node --import tsx --test src/lib/agent/derive-backend.opencode-off.test.ts
 */
delete process.env.NEXT_PUBLIC_OPENCODE_BACKEND_ENABLED;
process.env.NEXT_PUBLIC_CLAUDE_CODE_ENABLED = "true";
process.env.NEXT_PUBLIC_ANTHROPIC_OAUTH_ENABLED = "true";

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const NO_CREDS = {
  hasClaudeOAuth: false,
  hasAnthropicKey: false,
  hasCodexOAuth: false,
  hasOpenAIKey: false,
  hasFireworksKey: false,
  hasGoogleKey: false,
  hasTogetherKey: false,
};

async function load() {
  const derive = await import("./derive-backend");
  const resolution = await import("./backend-resolution");
  return { ...derive, ...resolution };
}

describe("flag off — OpenCode never routes", () => {
  test("openai model + full personal creds → botflow, exactly as before", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "gpt-5.6-terra",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasCodexOAuth: true, hasOpenAIKey: true },
      useTogetherKimi: true,
    });
    assert.deepEqual(out, {
      backend: "botflow",
      runnable: true,
      reason: "non_anthropic_model",
    });
  });

  test("resolveBackends: non-Anthropic → botflow-locked with legacy reason", async () => {
    const { resolveBackends } = await load();
    const res = resolveBackends({
      model: "fireworks-glm-5p2",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasFireworksKey: true },
    });
    assert.deepEqual(res.available, ["botflow"]);
    assert.equal(res.locked, "botflow");
    assert.equal(res.reason, "non_anthropic_model");
  });

  test("Anthropic OAuth still routes to claude-code (CC flag independent)", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "claude-sonnet-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasClaudeOAuth: true },
    });
    assert.equal(out.backend, "claude-code");
  });

  test("legacy Botflow-branded copy is preserved with the flag off", async () => {
    const { describeDerivation } = await load();
    assert.equal(describeDerivation("non_anthropic_model").title, "Running on Botflow");
    assert.match(describeDerivation("platform_key_botflow").title, /Botflow/);
  });
});
