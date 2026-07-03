import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveAnthropicProxyToken,
  shouldProxyAnthropic,
  anthropicProxyOrigin,
} from "./anthropic-proxy-token";

const ENV_KEYS = [
  "ANTHROPIC_PROXY_ENABLED",
  "ANTHROPIC_PROXY_PROJECT_IDS",
  "ANTHROPIC_PROXY_ORIGIN",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("shouldProxyAnthropic gating", () => {
  test("off by default — no flag, no proxying", () => {
    assert.equal(shouldProxyAnthropic("11111111-1111-1111-1111-111111111111"), false);
  });

  test("flag alone is not enough — project must be allowlisted", () => {
    process.env.ANTHROPIC_PROXY_ENABLED = "true";
    assert.equal(shouldProxyAnthropic("11111111-1111-1111-1111-111111111111"), false);
  });

  test("flag + allowlisted project (csv with whitespace) proxies", () => {
    process.env.ANTHROPIC_PROXY_ENABLED = "1";
    process.env.ANTHROPIC_PROXY_PROJECT_IDS = " aaa , bbb ,ccc";
    assert.equal(shouldProxyAnthropic("bbb"), true);
    assert.equal(shouldProxyAnthropic("ddd"), false);
  });

  test("allowlist alone (flag off) does not proxy", () => {
    process.env.ANTHROPIC_PROXY_PROJECT_IDS = "aaa";
    assert.equal(shouldProxyAnthropic("aaa"), false);
  });
});

describe("resolveAnthropicProxyToken fails closed", () => {
  test("rejects tokens without the bfap_ prefix before touching Redis", async () => {
    assert.equal(await resolveAnthropicProxyToken("sk-ant-oat01-realtoken"), null);
    assert.equal(await resolveAnthropicProxyToken(""), null);
  });

  test("unknown bfap_ token resolves null (no-op Redis stub → fail closed)", async () => {
    assert.equal(await resolveAnthropicProxyToken("bfap_doesnotexist"), null);
  });
});

describe("anthropicProxyOrigin", () => {
  test("defaults to the request origin", () => {
    assert.equal(anthropicProxyOrigin("https://botflow.io"), "https://botflow.io");
  });

  test("env override wins", () => {
    process.env.ANTHROPIC_PROXY_ORIGIN = "https://proxy.botflow.io";
    assert.equal(anthropicProxyOrigin("https://botflow.io"), "https://proxy.botflow.io");
  });
});
