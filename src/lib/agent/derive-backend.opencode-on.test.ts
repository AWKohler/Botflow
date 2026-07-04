/**
 * Decision-table tests for deriveAgentBackend / resolveBackends with the
 * OpenCode backend flag ON (plus the Claude Code + Anthropic OAuth flags, so
 * the Anthropic tree is exercised in its production shape).
 *
 * Env is set BEFORE the modules under test load: static imports hoist, so the
 * modules are pulled in lazily via dynamic import inside the tests. The
 * flag-OFF matrix lives in a separate file — node --test runs each file in its
 * own process, which is what makes the module-level flag consts testable.
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

describe("deriveAgentBackend — OpenCode arm (flag on)", () => {
  test("openai model + Codex OAuth → opencode (codex_oauth_opencode)", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "gpt-5.4",
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

  test("openai model + no personal creds → botflow engine (platform key stays server-side)", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "gpt-5.4",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
      tier: "pro",
    });
    assert.deepEqual(out, {
      backend: "botflow",
      runnable: true,
      reason: "non_anthropic_model",
    });
  });

  test("google model routes by Google key", async () => {
    const { deriveAgentBackend } = await load();
    const withKey = deriveAgentBackend({
      model: "gemini-3.1-pro-preview",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasGoogleKey: true },
    });
    assert.equal(withKey.backend, "opencode");
    assert.equal(withKey.reason, "byok_opencode");

    const withOtherKeys = deriveAgentBackend({
      model: "gemini-3.1-pro-preview",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasOpenAIKey: true, hasFireworksKey: true },
    });
    assert.equal(withOtherKeys.backend, "botflow");
  });

  test("fireworks model routes by Fireworks key", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "fireworks-glm-5p2",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasFireworksKey: true },
    });
    assert.equal(out.backend, "opencode");
  });

  test("kimi honors USE_TOGETHER_KIMI: Together key required when on, Fireworks key when off", async () => {
    const { deriveAgentBackend } = await load();
    const togetherOnWithTogetherKey = deriveAgentBackend({
      model: "fireworks-kimi-k2p7",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasTogetherKey: true },
      useTogetherKimi: true,
    });
    assert.equal(togetherOnWithTogetherKey.backend, "opencode");

    const togetherOnWithOnlyFireworksKey = deriveAgentBackend({
      model: "fireworks-kimi-k2p7",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasFireworksKey: true },
      useTogetherKimi: true,
    });
    assert.equal(togetherOnWithOnlyFireworksKey.backend, "botflow");

    const togetherOffWithFireworksKey = deriveAgentBackend({
      model: "fireworks-kimi-k2p7",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasFireworksKey: true },
      useTogetherKimi: false,
    });
    assert.equal(togetherOffWithFireworksKey.backend, "opencode");
  });

  test("non-sandbox platform never routes to opencode", async () => {
    const { deriveAgentBackend } = await load();
    const out = deriveAgentBackend({
      model: "gpt-5.4",
      platform: "web",
      creds: { ...NO_CREDS, hasCodexOAuth: true, hasOpenAIKey: true },
    });
    assert.equal(out.backend, "botflow");
    assert.equal(out.reason, "non_anthropic_model");
  });
});

describe("deriveAgentBackend — Anthropic tree unchanged by the OpenCode flag", () => {
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

  test("Anthropic BYOK defaults to botflow, preference picks claude-code", async () => {
    const { deriveAgentBackend } = await load();
    const byok = deriveAgentBackend({
      model: "claude-opus-4-8",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasAnthropicKey: true },
    });
    assert.equal(byok.backend, "botflow");
    assert.equal(byok.reason, "byok_botflow");

    const pref = deriveAgentBackend({
      model: "claude-opus-4-8",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasAnthropicKey: true },
      preferredAnthropicBackend: "claude-code",
    });
    assert.equal(pref.backend, "claude-code");
    assert.equal(pref.reason, "byok_preference_claude_code");
  });

  test("no Anthropic creds: paid tier → botflow runnable; free tier → not runnable", async () => {
    const { deriveAgentBackend } = await load();
    const paid = deriveAgentBackend({
      model: "claude-sonnet-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
      tier: "pro",
    });
    assert.equal(paid.backend, "botflow");
    assert.equal(paid.runnable, true);

    const free = deriveAgentBackend({
      model: "claude-sonnet-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
      tier: "free",
    });
    assert.equal(free.runnable, false);
  });
});

describe("resolveBackends — drop-in replacement semantics (flag on)", () => {
  test("eligible non-Anthropic → locked to opencode, no user choice", async () => {
    const { resolveBackends } = await load();
    const res = resolveBackends({
      model: "gpt-5.4",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasCodexOAuth: true },
    });
    assert.deepEqual(res.available, ["opencode"]);
    assert.equal(res.locked, "opencode");
    assert.equal(res.defaultBackend, "opencode");
    assert.equal(res.reason, "opencode_replaces_botflow");
  });

  test("non-eligible non-Anthropic → botflow-locked", async () => {
    const { resolveBackends } = await load();
    const res = resolveBackends({
      model: "gpt-5.4",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS },
    });
    assert.deepEqual(res.available, ["botflow"]);
    assert.equal(res.locked, "botflow");
  });

  test("Anthropic BYOK matrix unchanged: user picks between botflow and claude-code", async () => {
    const { resolveBackends } = await load();
    const res = resolveBackends({
      model: "claude-sonnet-5",
      platform: "sandboxed-web",
      creds: { ...NO_CREDS, hasAnthropicKey: true },
    });
    assert.deepEqual(res.available, ["botflow", "claude-code"]);
    assert.equal(res.locked, null);
  });

  test("isAgentBackend accepts the new value and still rejects junk", async () => {
    const { isAgentBackend } = await load();
    assert.equal(isAgentBackend("opencode"), true);
    assert.equal(isAgentBackend("claude-code"), true);
    assert.equal(isAgentBackend("copilot"), false);
  });
});

describe("describeDerivation — copy for the new reasons (flag on)", () => {
  test("opencode reasons have OpenCode-branded copy", async () => {
    const { describeDerivation } = await load();
    assert.match(describeDerivation("codex_oauth_opencode").title, /OpenCode/);
    assert.match(describeDerivation("byok_opencode").title, /OpenCode/);
  });

  test("fallback-engine copy drops the Botflow agent brand under the flag", async () => {
    const { describeDerivation } = await load();
    const nonAnthropic = describeDerivation("non_anthropic_model");
    assert.doesNotMatch(nonAnthropic.title, /Botflow/);
    const platformKey = describeDerivation("platform_key_botflow");
    assert.doesNotMatch(platformKey.title, /Botflow/);
  });
});
