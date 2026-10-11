/**
 * Decision-table tests for deriveAgentBackend (with the Anthropic OAuth flag
 * on, so the Anthropic tree is exercised in its production shape).
 *
 * Only the in-sandbox agents exist: non-Anthropic → OpenCode unconditionally
 * (credentials pick the MODE, tier gates platform mode); Anthropic personal
 * creds (OAuth or BYOK) → Claude Code; Anthropic platform-key (paid) →
 * OpenCode platform mode; non-sandbox platforms → not runnable.
 *
 * Env is set BEFORE the modules under test load: static imports hoist, so the
 * modules are pulled in lazily via dynamic import inside the tests.
 *
 * Run: node --import tsx --test src/lib/agent/derive-backend.test.ts
 */
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
  return import("./derive-backend");
}

describe("deriveAgentBackend — non-Anthropic models", () => {
  test("openai model + Codex OAuth → opencode (codex_oauth_opencode)", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "gpt-6.1-sol",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasCodexOAuth: true },
    });
    assert.deepEqual(out, {
      backend: "opencode",
      runnable: true,
      reason: "codex_oauth_opencode",
    });
  });

  test("openai model + OpenAI BYOK only → opencode (byok_opencode)", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "gpt-6.1-sol",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasOpenAIKey: true },
    });
    assert.equal(out.backend, "opencode");
    assert.equal(out.reason, "byok_opencode");
  });

  test("openai model + NO personal creds → opencode PLATFORM mode for paid tiers", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "gpt-6.1-sol",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
      tier: "pro",
    });
    assert.deepEqual(out, {
      backend: "opencode",
      runnable: true,
      reason: "platform_key_opencode",
    });
  });

  test("tier gate: free tier can't run pro platform models (tier_too_low, hidden); free models pass", async () => {
    const { deriveAgentBackend } = await load();
    const gated = deriveAgentBackend({
      model: "gpt-6.1-sol",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
      tier: "free",
    });
    assert.equal(gated.backend, "opencode");
    assert.equal(gated.runnable, false);
    assert.equal(gated.reason, "tier_too_low");

    const freeModel = deriveAgentBackend({
      model: "fireworks-minimax-m3",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
      tier: "free",
    });
    assert.equal(freeModel.backend, "opencode");
    assert.equal(freeModel.runnable, true);
    assert.equal(freeModel.reason, "platform_key_opencode");
  });

  test("google model: key → byok mode; no key → platform mode", async () => {
    const { deriveAgentBackend } = await load();
    const withKey = deriveAgentBackend({
      model: "gemini-3.1-pro-preview",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasGoogleKey: true },
    });
    assert.equal(withKey.reason, "byok_opencode");

    const withoutKey = deriveAgentBackend({
      model: "gemini-3.1-pro-preview",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasOpenAIKey: true, hasFireworksKey: true }, // wrong providers
      tier: "pro",
    });
    assert.equal(withoutKey.backend, "opencode");
    assert.equal(withoutKey.reason, "platform_key_opencode");
  });

  test("kimi honors USE_TOGETHER_KIMI for the BYOK mode; missing key falls to platform mode", async () => {
    const { deriveAgentBackend } = await load();
    const togetherOnWithTogetherKey = deriveAgentBackend({
      model: "fireworks-kimi-k2p7",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasTogetherKey: true },
      useTogetherKimi: true,
    });
    assert.equal(togetherOnWithTogetherKey.reason, "byok_opencode");

    const togetherOnWithOnlyFireworksKey = deriveAgentBackend({
      model: "fireworks-kimi-k2p7",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasFireworksKey: true },
      useTogetherKimi: true,
      tier: "free",
    });
    assert.equal(togetherOnWithOnlyFireworksKey.backend, "opencode");
    assert.equal(togetherOnWithOnlyFireworksKey.reason, "platform_key_opencode");

    const togetherOffWithFireworksKey = deriveAgentBackend({
      model: "fireworks-kimi-k2p7",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasFireworksKey: true },
      useTogetherKimi: false,
    });
    assert.equal(togetherOffWithFireworksKey.reason, "byok_opencode");
  });

  test("non-sandbox platform has no agent, whatever the creds", async () => {
    const { deriveAgentBackend } = await load();
    for (const model of ["gpt-6.1-sol", "claude-sonnet-5-5"] as const) {
      const out = deriveAgentBackend({
        model,
        platform: "web",
        creds: { ...NO_CREDS, hasClaudeOAuth: true, hasCodexOAuth: true, hasOpenAIKey: true },
        tier: "max",
      });
      assert.equal(out.runnable, false);
      assert.equal(out.reason, "unsupported_platform");
    }
  });
});

describe("deriveAgentBackend — Anthropic tree", () => {
  test("Claude OAuth on sandbox → claude-code", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "claude-sonnet-5-5",
      platform: "sandboxed-web",
      // Codex creds present too — must not distract the Anthropic tree.
      creds: { ...NO_CREDS, hasClaudeOAuth: true, hasCodexOAuth: true },
    });
    assert.deepEqual(out, {
      backend: "claude-code",
      runnable: true,
      reason: "oauth_claude_code",
    });
  });

  test("Anthropic BYOK is locked to claude-code", async () => {
    const { deriveAgentBackend } = await load();
    const byok = deriveAgentBackend({
      model: "claude-opus-5-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasAnthropicKey: true },
    });
    assert.equal(byok.backend, "claude-code");
    assert.equal(byok.reason, "byok_claude_code");
  });

  test("no Anthropic creds: paid tier → opencode PLATFORM mode; free tier → not runnable", async () => {
    const { deriveAgentBackend } = await load();
    const paid = deriveAgentBackend({
      model: "claude-sonnet-5-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
      tier: "pro",
    });
    assert.equal(paid.backend, "opencode");
    assert.equal(paid.runnable, true);
    assert.equal(paid.reason, "platform_key_opencode");

    const maxOnly = deriveAgentBackend({
      model: "claude-fable-5-1",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
      tier: "pro", // fable requires max on platform credits
    });
    assert.equal(maxOnly.runnable, false);
    assert.equal(maxOnly.reason, "tier_too_low");

    const free = deriveAgentBackend({
      model: "claude-sonnet-5-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
      tier: "free",
    });
    assert.equal(free.runnable, false);
    assert.equal(free.reason, "no_credentials");
  });
});

describe("deriveAgentBackend — only in-sandbox agents", () => {
  test("every model × cred × tier × platform combination yields claude-code or opencode", async () => {
    const { deriveAgentBackend } = await load();
    const { MODEL_CONFIGS } = await import("./models");
    const credSets = [
      { ...NO_CREDS },
      { ...NO_CREDS, hasClaudeOAuth: true },
      { ...NO_CREDS, hasAnthropicKey: true },
      { ...NO_CREDS, hasCodexOAuth: true },
      { ...NO_CREDS, hasOpenAIKey: true, hasFireworksKey: true, hasGoogleKey: true },
    ];
    for (const model of Object.keys(MODEL_CONFIGS) as Array<keyof typeof MODEL_CONFIGS>) {
      for (const creds of credSets) {
        for (const tier of [undefined, "free", "pro", "max"] as const) {
          for (const platform of ["sandboxed-web", "swift", "web", null]) {
            const out = deriveAgentBackend({ model, platform, creds, tier });
            assert.ok(
              out.backend === "claude-code" || out.backend === "opencode",
              `${model}/${platform}/${tier} → ${out.backend}`,
            );
          }
        }
      }
    }
  });
});

describe("describeDerivation — copy", () => {
  test("opencode + claude-code reasons carry their agent branding", async () => {
    const { describeDerivation } = await load();
    assert.match(describeDerivation("codex_oauth_opencode").title, /OpenCode/);
    assert.match(describeDerivation("byok_opencode").title, /OpenCode/);
    assert.match(describeDerivation("platform_key_opencode").body, /OpenCode/);
    assert.match(describeDerivation("byok_claude_code").title, /Claude Code/);
  });

  test("proxied copy never claims keys enter the sandbox", async () => {
    const { describeDerivation } = await load();
    assert.match(describeDerivation("platform_key_opencode").body, /never enter the sandbox/);
  });
});
