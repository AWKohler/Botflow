/**
 * Run: node --import tsx --test src/lib/agent/errors.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isProviderOutage, providerOutageMessage } from "./errors";

describe("isProviderOutage", () => {
  test("recognizes the Envoy gateway page OpenAI returned", () => {
    assert.equal(
      isProviderOutage(
        "APIError: Service Unavailable: upstream connect error or disconnect/reset before headers. reset reason: remote connection failure",
      ),
      true,
    );
  });
  test("recognizes bare gateway statuses and overload notices", () => {
    for (const text of ["502 Bad Gateway", "Gateway Timeout", "HTTP 504", "Overloaded", "The server is temporarily unavailable"]) {
      assert.equal(isProviderOutage(text), true, text);
    }
  });
  test("leaves the user's own errors alone", () => {
    for (const text of [
      "Invalid API key",
      "Rate limited. Please wait",
      "context_length_exceeded: maximum context length is 1050000 tokens",
      "Build failed at line 503 of src/App.tsx",
      "Turn stopped (superseded by a new turn or stopped by the user).",
    ]) {
      assert.equal(isProviderOutage(text), false, text);
    }
  });
});

describe("providerOutageMessage", () => {
  test("names the provider and says it's not the user's project", () => {
    const msg = providerOutageMessage("OpenAI's ChatGPT service");
    assert.match(msg, /^OpenAI's ChatGPT service is temporarily unavailable/);
    assert.match(msg, /not your project/);
  });
});
