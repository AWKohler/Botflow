/**
 * Decision-table tests for deriveAgentBackend / resolveBackends with the
 * OpenCode backend flag ON (plus the Claude Code + Anthropic OAuth flags, so
 * the Anthropic tree is exercised in its production shape).
 *
 * The LLM-proxy decision table: non-Anthropic → OpenCode unconditionally
 * (credentials pick the MODE, tier gates platform mode); Anthropic personal
 * creds (OAuth or BYOK) → Claude Code locked; Anthropic platform-key (paid)
 * → OpenCode platform mode.
 *
 * Env is set BEFORE the modules under test load: static imports hoist, so the
 * modules are pulled in lazily via dynamic import inside the tests. The
 * flag-OFF matrix lives in a separate file — node --test runs each file in
 * its own process, which is what makes the module-level flag consts testable.
 *
 * Run: node --import tsx --test src/lib/agent/derive-backend.opencode-on.test.ts
 */
process.env.NEXT_PUBLIC_OPENCODE_BACKEND_ENABLED = "true";
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

describe("deriveAgentBackend — non-Anthropic models (flag on)", () => {
  test("openai model + Codex OAuth → opencode (codex_oauth_opencode)", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "gpt-5.6-terra",
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
      model: "gpt-5.5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasOpenAIKey: true },
    });
    assert.equal(out.backend, "opencode");
    assert.equal(out.reason, "byok_opencode");
  });

  test("openai model + NO personal creds → opencode PLATFORM mode for paid tiers", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "gpt-5.6-terra",
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
      model: "gpt-5.6-terra",
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

  test("kimi honors USE_TOGETHER_KIMI for the BYOK mode; missing key falls to platform, never botflow", async () => {
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

  test("non-sandbox platform never routes to opencode", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "gpt-5.6-terra",
      platform: "web",
      creds: { ...NO_CREDS, hasCodexOAuth: true, hasOpenAIKey: true },
    });
    assert.equal(out.backend, "botflow");
    assert.equal(out.reason, "non_anthropic_model");
  });
});

describe("deriveAgentBackend — Anthropic tree (flag on)", () => {
  test("Claude OAuth on sandbox → claude-code", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "claude-sonnet-5",
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

  test("Anthropic BYOK is LOCKED to claude-code (preference retired)", async () => {
    const { deriveAgentBackend } = await load();
    const byok = deriveAgentBackend({
      model: "claude-opus-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasAnthropicKey: true },
    });
    assert.equal(byok.backend, "claude-code");
    assert.equal(byok.reason, "byok_claude_code");

    // The deprecated preference input is ignored entirely.
    const withStalePreference = deriveAgentBackend({
      model: "claude-opus-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasAnthropicKey: true },
      preferredAnthropicBackend: "botflow",
    });
    assert.equal(withStalePreference.backend, "claude-code");
  });

  test("no Anthropic creds: paid tier → opencode PLATFORM mode; free tier → not runnable", async () => {
    const { deriveAgentBackend } = await load();
    const paid = deriveAgentBackend({
      model: "claude-sonnet-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
      tier: "pro",
    });
    assert.equal(paid.backend, "opencode");
    assert.equal(paid.runnable, true);
    assert.equal(paid.reason, "platform_key_opencode");

    const maxOnly = deriveAgentBackend({
      model: "claude-fable-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
      tier: "pro", // fable requires max on platform credits
    });
    assert.equal(maxOnly.runnable, false);
    assert.equal(maxOnly.reason, "tier_too_low");

    const free = deriveAgentBackend({
      model: "claude-sonnet-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
      tier: "free",
    });
    assert.equal(free.runnable, false);
    assert.equal(free.reason, "no_credentials");
  });
});

describe("resolveBackends — drop-in replacement semantics (flag on)", () => {
  test("non-Anthropic → locked to opencode regardless of creds", async () => {
    const { resolveBackends } = await load();
    for (const creds of [{ ...NO_CREDS, hasCodexOAuth: true }, { ...NO_CREDS }]) {
      const res = resolveBackends({
        model: "gpt-5.6-terra",
        platform: "sandboxed-web",
        creds,
      });
      assert.deepEqual(res.available, ["opencode"]);
      assert.equal(res.locked, "opencode");
      assert.equal(res.reason, "opencode_replaces_botflow");
    }
  });

  test("Anthropic BYOK → claude-code locked (no more two-backend choice)", async () => {
    const { resolveBackends } = await load();
    const res = resolveBackends({
      model: "claude-sonnet-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasAnthropicKey: true },
    });
    assert.deepEqual(res.available, ["claude-code"]);
    assert.equal(res.locked, "claude-code");
  });

  test("Anthropic no personal creds → opencode locked (platform via proxy)", async () => {
    const { resolveBackends } = await load();
    const res = resolveBackends({
      model: "claude-sonnet-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
    });
    assert.deepEqual(res.available, ["opencode"]);
    assert.equal(res.locked, "opencode");
  });

  test("isAgentBackend accepts the new value and still rejects junk", async () => {
    const { isAgentBackend } = await load();
    assert.equal(isAgentBackend("opencode"), true);
    assert.equal(isAgentBackend("claude-code"), true);
    assert.equal(isAgentBackend("copilot"), false);
  });
});

describe("describeDerivation — copy (flag on)", () => {
  test("opencode + claude-code reasons carry their agent branding", async () => {
    const { describeDerivation } = await load();
    assert.match(describeDerivation("codex_oauth_opencode").title, /OpenCode/);
    assert.match(describeDerivation("byok_opencode").title, /OpenCode/);
    assert.match(describeDerivation("platform_key_opencode").body, /OpenCode/);
    assert.match(describeDerivation("byok_claude_code").title, /Claude Code/);
  });

  test("proxied copy never claims keys enter the sandbox; Botflow brand stays out of fallback copy", async () => {
    const { describeDerivation } = await load();
    assert.match(describeDerivation("platform_key_opencode").body, /never enter the sandbox/);
    assert.doesNotMatch(describeDerivation("non_anthropic_model").title, /Botflow/);
    assert.doesNotMatch(describeDerivation("platform_key_botflow").title, /Botflow/);
  });
});
