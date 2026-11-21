import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { acquireSession, forceEndSession, releaseSession } from "./swift-preview-session-pool";
import { resetLocalConnection } from "./local-simulator-client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; resetLocalConnection(); });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Stop during provisioning deletes the session once it resolves", async () => {
  const requests: string[] = [];
  let resolveStart!: (response: Response) => void;
  globalThis.fetch = async (input) => {
    const url = String(input); requests.push(url);
    return url.endsWith("/start") ? new Promise((resolve) => { resolveStart = resolve; }) : new Response(null, { status: 204 });
  };
  const pending = acquireSession("pending-stop");
  forceEndSession("pending-stop");
  resolveStart(Response.json({ sessionId: "late-session", wsUrl: "ws://example.test" }));
  await pending; await tick();
  assert.ok(requests.some((url) => url.endsWith("/late-session")));
});

test("Strict Mode release and reacquire share one session", async () => {
  let starts = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/start")) { starts++; return Response.json({ sessionId: "shared", wsUrl: "ws://example.test" }); }
    return new Response(null, { status: 204 });
  };
  const first = acquireSession("strict-mode");
  releaseSession("strict-mode");
  const second = acquireSession("strict-mode");
  assert.equal(first, second);
  await second;
  assert.equal(starts, 1);
  forceEndSession("strict-mode");
});

test("local mode uploads source and cleans up locally without cloud allocation", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); requests.push(url);
    if (url.endsWith("/connect")) return Response.json({ token: "test-token" });
    if (url.endsWith("/sessions")) return Response.json({ sessionId: "local-one", wsUrl: "ws://127.0.0.1:17322/stream" });
    if (url.endsWith("/source")) return new Response("archive");
    return new Response(null, { status: 204 });
  };
  try {
    const result = await acquireSession("local-project", { provider: "local" });
    assert.equal(result.provider, "local");
    forceEndSession("local-project", { provider: "local" });
    await tick();
    assert.ok(requests.some((url) => url.endsWith("/source")));
    assert.ok(requests.includes("http://127.0.0.1:17322/sessions/local-one/build"));
    assert.ok(requests.includes("http://127.0.0.1:17322/sessions/local-one"));
    assert.ok(!requests.some((url) => url.includes("/swift-preview/start") || url.includes("/swift-preview/rebuild")));
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
