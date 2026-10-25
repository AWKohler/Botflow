/**
 * Run: npx vitest run src/lib/agent/llm-proxy/upstream-retry.test.ts
 */
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { fetchWithUpstreamRetry } from "./upstream-retry";

const ENVOY_503 =
  "upstream connect error or disconnect/reset before headers. reset reason: remote connection failure";

function sequence(...steps: Array<number | Error>) {
  let calls = 0;
  const doFetch = async () => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls++;
    if (step instanceof Error) throw step;
    return new Response(step === 200 ? "ok" : ENVOY_503, { status: step });
  };
  return { doFetch, calls: () => calls };
}

const noSleep = { sleep: async () => {} };

describe("fetchWithUpstreamRetry", () => {
  test("a transient Envoy 503 is retried and the success is returned", async () => {
    const s = sequence(503, 200);
    const res = await fetchWithUpstreamRetry(s.doFetch, noSleep);
    assert.equal(res.status, 200);
    assert.equal(s.calls(), 2);
  });

  test("network errors are retried too", async () => {
    const s = sequence(new TypeError("fetch failed"), 200);
    const res = await fetchWithUpstreamRetry(s.doFetch, noSleep);
    assert.equal(res.status, 200);
    assert.equal(s.calls(), 2);
  });

  test("gives up after the attempt budget and passes the last failure through", async () => {
    const s = sequence(503, 502, 504);
    const res = await fetchWithUpstreamRetry(s.doFetch, noSleep);
    assert.equal(res.status, 504);
    assert.equal(s.calls(), 3);
    assert.match(await res.text(), /upstream connect error/);
  });

  test("a persistent network error is rethrown after the budget", async () => {
    const s = sequence(new TypeError("fetch failed"));
    await assert.rejects(fetchWithUpstreamRetry(s.doFetch, noSleep), /fetch failed/);
    assert.equal(s.calls(), 3);
  });

  test("the model's own errors (4xx, 500, 529) are never retried", async () => {
    for (const status of [400, 401, 429, 500, 529]) {
      const s = sequence(status, 200);
      const res = await fetchWithUpstreamRetry(s.doFetch, noSleep);
      assert.equal(res.status, status);
      assert.equal(s.calls(), 1, `status ${status}`);
    }
  });

  test("honors a short Retry-After and skips the retry for a long one", async () => {
    const waits: number[] = [];
    let calls = 0;
    const short = await fetchWithUpstreamRetry(
      async () => (calls++ === 0 ? new Response("", { status: 503, headers: { "retry-after": "1" } }) : new Response("ok")),
      { sleep: async (ms) => void waits.push(ms) },
    );
    assert.equal(short.status, 200);
    assert.deepEqual(waits, [1000]);

    let longCalls = 0;
    const long = await fetchWithUpstreamRetry(
      async () => {
        longCalls++;
        return new Response("", { status: 503, headers: { "retry-after": "120" } });
      },
      noSleep,
    );
    assert.equal(long.status, 503);
    assert.equal(longCalls, 1);
  });
});
