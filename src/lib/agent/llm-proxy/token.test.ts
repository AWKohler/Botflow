/**
 * Contracts ported from the Phase-0 spike's anthropic-proxy-token tests,
 * adapted to the generalized lib: prefix check short-circuits before Redis,
 * fail-closed resolution with the no-op Redis stub, origin override. Gating
 * tests dropped — the gating helper was deliberately deleted (the proxy
 * route is always on; possession of a token is the gate).
 *
 * Runs with Upstash env UNSET so `redis` is the no-op stub — resolution must
 * fail closed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  resolveLlmProxyToken,
  llmProxyOrigin,
} from "./token";
import { isLlmProxyProvider, proxyProviderForOpenCodeId, LLM_PROXY_PROVIDERS } from "./providers";

describe("resolveLlmProxyToken — fail closed", () => {
  test("rejects tokens without the bfap_ prefix before touching Redis", async () => {
    assert.equal(await resolveLlmProxyToken("sk-ant-real-key-oops"), null);
    assert.equal(await resolveLlmProxyToken("tok_something"), null);
  });

  test("empty string resolves null", async () => {
    assert.equal(await resolveLlmProxyToken(""), null);
  });

  test("unknown bfap_ token resolves null (no-op Redis stub = fail closed)", async () => {
    assert.equal(await resolveLlmProxyToken("bfap_definitely-not-minted"), null);
  });
});

describe("llmProxyOrigin", () => {
  test("defaults to the request origin", () => {
    delete process.env.LLM_PROXY_ORIGIN;
    assert.equal(llmProxyOrigin("https://botflow.io"), "https://botflow.io");
  });

  test("LLM_PROXY_ORIGIN overrides", () => {
    process.env.LLM_PROXY_ORIGIN = "https://botflow.io";
    assert.equal(llmProxyOrigin("https://preview-abc.vercel.app"), "https://botflow.io");
    delete process.env.LLM_PROXY_ORIGIN;
  });
});

describe("provider registry", () => {
  test("isLlmProxyProvider accepts registry keys and rejects junk", () => {
    assert.equal(isLlmProxyProvider("anthropic"), true);
    assert.equal(isLlmProxyProvider("google"), true);
    assert.equal(isLlmProxyProvider("codex"), false); // documented exception — no entry
    assert.equal(isLlmProxyProvider("__proto__"), false);
  });

  test("opencode catalog ids map onto proxy providers", () => {
    assert.equal(proxyProviderForOpenCodeId("fireworks-ai"), "fireworks");
    assert.equal(proxyProviderForOpenCodeId("togetherai"), "together");
    assert.equal(proxyProviderForOpenCodeId("anthropic"), "anthropic");
    assert.equal(proxyProviderForOpenCodeId("unknown-provider"), null);
  });

  test("path allowlists admit the known agent surfaces and refuse traversal", () => {
    const p = LLM_PROXY_PROVIDERS;
    assert.ok(p.anthropic.pathAllowlist.test("v1/messages"));
    assert.ok(p.anthropic.pathAllowlist.test("v1/messages/count_tokens"));
    assert.ok(!p.anthropic.pathAllowlist.test("admin/keys"));
    assert.ok(p.openai.pathAllowlist.test("v1/responses"));
    assert.ok(p.openai.pathAllowlist.test("v1/chat/completions"));
    assert.ok(!p.openai.pathAllowlist.test("v1/files"));
    assert.ok(p.fireworks.pathAllowlist.test("v1/chat/completions"));
    assert.ok(p.together.pathAllowlist.test("v1/chat/completions"));
    assert.ok(!p.together.pathAllowlist.test("v1/models"));
    assert.ok(p.google.pathAllowlist.test("v1beta/models/gemini-3.1-pro-preview:streamGenerateContent"));
    assert.ok(!p.google.pathAllowlist.test("v1beta/models/../secrets:generateContent"));
  });

  test("openai dialect switches on path", () => {
    assert.equal(LLM_PROXY_PROVIDERS.openai.dialectForPath("v1/responses"), "openai-responses");
    assert.equal(LLM_PROXY_PROVIDERS.openai.dialectForPath("v1/chat/completions"), "openai-chat");
  });
});
