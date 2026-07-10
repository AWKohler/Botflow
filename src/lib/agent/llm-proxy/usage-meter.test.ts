/**
 * Dialect-fixture matrix for the proxy usage meter. Fixtures are shaped from
 * provider documentation + live captures; each locks the exact cache-field
 * extraction the billing plane depends on. Truncated variants assert that
 * aborted streams settle with partial usage and complete:false.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createUsageParser,
  rewriteRequestBody,
  meterResponse,
  clockHeuristicKey,
  applyClockHeuristic,
  PLATFORM_MAX_OUTPUT_TOKENS,
  type ObservedUsage,
} from "./usage-meter";

const sse = (events: Array<Record<string, unknown> | string>): string =>
  events
    .map((e) => (typeof e === "string" ? e : `data: ${JSON.stringify(e)}`))
    .join("\n\n") + "\n\n";

describe("anthropic dialect", () => {
  const stream = sse([
    "event: message_start",
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100, // UNCACHED input — anthropic reports it directly
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 30000,
          output_tokens: 1,
        },
      },
    },
    { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    { type: "message_delta", usage: { output_tokens: 450 } },
    { type: "message_stop" },
  ]);

  test("stream: cache write+read extracted; input normalized to total; last output wins", () => {
    const p = createUsageParser("anthropic", true);
    p.push(stream);
    const u = p.finish();
    assert.deepEqual(u, {
      inputTokens: 100 + 30000 + 2000,
      outputTokens: 450,
      cachedReadTokens: 30000,
      cacheWriteTokens: 2000,
      explicitCacheReport: true,
      complete: true,
    } satisfies ObservedUsage);
  });

  test("stream truncated after message_start: partial usage, complete:false", () => {
    const p = createUsageParser("anthropic", true);
    p.push(sse([
      {
        type: "message_start",
        message: { usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } },
      },
    ]));
    const u = p.finish();
    assert.equal(u.inputTokens, 500);
    assert.equal(u.complete, false);
    assert.equal(u.explicitCacheReport, true);
  });

  test("non-streaming message body", () => {
    const p = createUsageParser("anthropic", false);
    p.push(JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "hello" }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 7 },
    }));
    const u = p.finish();
    assert.equal(u.inputTokens, 35);
    assert.equal(u.cacheWriteTokens, 5);
    assert.equal(u.cachedReadTokens, 20);
    assert.equal(u.outputTokens, 7);
    assert.equal(u.complete, true);
  });
});

describe("openai-chat dialect", () => {
  test("stream: final usage chunk with prompt_tokens_details.cached_tokens", () => {
    const p = createUsageParser("openai-chat", true);
    p.push(sse([
      { choices: [{ delta: { content: "he" } }], usage: null },
      { choices: [{ delta: { content: "llo" } }], usage: null },
      {
        choices: [],
        usage: {
          prompt_tokens: 12000,
          completion_tokens: 300,
          prompt_tokens_details: { cached_tokens: 11500 },
        },
      },
      "data: [DONE]",
    ]));
    const u = p.finish();
    assert.equal(u.inputTokens, 12000);
    assert.equal(u.cachedReadTokens, 11500);
    assert.equal(u.cacheWriteTokens, 0);
    assert.equal(u.outputTokens, 300);
    assert.equal(u.explicitCacheReport, true);
    assert.equal(u.complete, true);
  });

  test("GPT-5.6: cache_write_tokens is a SUBSET of prompt_tokens (NOT added back) — live-captured cold call", () => {
    const p = createUsageParser("openai-chat", true);
    p.push(sse([
      {
        choices: [],
        usage: {
          // Real capture from gpt-5.6-sol, cold call (whole prefix written).
          prompt_tokens: 10256,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 10253 },
        },
      },
      "data: [DONE]",
    ]));
    const u = p.finish();
    assert.equal(u.inputTokens, 10256);        // prompt_tokens as-is — writes are a subset, NOT +10253
    assert.equal(u.cacheWriteTokens, 10253);
    assert.equal(u.cachedReadTokens, 0);
    assert.equal(u.explicitCacheReport, true);
    // Billing: uncached = in − read − write = 3 plain tokens @1×; the 10253
    // written tokens bill once, at 1.25×. (Add-back would double-count them.)
    assert.equal(u.inputTokens - u.cachedReadTokens - u.cacheWriteTokens, 3);
  });

  test("stream with NO usage frame (fireworks-style silence): zeros, complete:false, no explicit report", () => {
    const p = createUsageParser("openai-chat", true);
    p.push(sse([
      { choices: [{ delta: { content: "hi" } }] },
      "data: [DONE]",
    ]));
    const u = p.finish();
    assert.equal(u.inputTokens, 0);
    assert.equal(u.explicitCacheReport, false);
    assert.equal(u.complete, false);
  });

  test("usage present but no details (together-style): explicit report stays false so the clock heuristic may apply", () => {
    const p = createUsageParser("openai-chat", true);
    p.push(sse([
      { choices: [], usage: { prompt_tokens: 900, completion_tokens: 100 } },
    ]));
    const u = p.finish();
    assert.equal(u.inputTokens, 900);
    assert.equal(u.explicitCacheReport, false);
    assert.equal(u.complete, true);
  });
});

describe("openai-responses dialect", () => {
  test("response.completed carries usage incl cached input details", () => {
    const p = createUsageParser("openai-responses", true);
    p.push(sse([
      { type: "response.output_text.delta", delta: "h" },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 5000,
            input_tokens_details: { cached_tokens: 4096 },
            output_tokens: 250,
          },
        },
      },
    ]));
    const u = p.finish();
    assert.equal(u.inputTokens, 5000);
    assert.equal(u.cachedReadTokens, 4096);
    assert.equal(u.outputTokens, 250);
    assert.equal(u.complete, true);
  });

  test("GPT-5.6: input_tokens_details.cache_write_tokens is a SUBSET of input_tokens (NOT added back)", () => {
    const p = createUsageParser("openai-responses", true);
    p.push(sse([
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 5000,
            input_tokens_details: { cached_tokens: 4096, cache_write_tokens: 400 },
            output_tokens: 250,
          },
        },
      },
    ]));
    const u = p.finish();
    assert.equal(u.inputTokens, 5000);         // input_tokens as-is — writes/reads are subsets
    assert.equal(u.cachedReadTokens, 4096);
    assert.equal(u.cacheWriteTokens, 400);
    assert.equal(u.explicitCacheReport, true);
    // subset invariant: read + write ≤ total
    assert.ok(u.cachedReadTokens + u.cacheWriteTokens <= u.inputTokens);
  });

  test("truncated before response.completed: complete:false", () => {
    const p = createUsageParser("openai-responses", true);
    p.push(sse([{ type: "response.output_text.delta", delta: "partial" }]));
    assert.equal(p.finish().complete, false);
  });
});

describe("google dialect", () => {
  test("last usageMetadata wins; cached + thoughts accounted", () => {
    const p = createUsageParser("google", true);
    p.push(sse([
      { candidates: [{ content: { parts: [{ text: "a" }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 10 } },
      {
        candidates: [{ content: { parts: [{ text: "b" }] } }],
        usageMetadata: {
          promptTokenCount: 800,
          cachedContentTokenCount: 600,
          candidatesTokenCount: 90,
          thoughtsTokenCount: 40,
        },
      },
    ]));
    const u = p.finish();
    assert.equal(u.inputTokens, 800);
    assert.equal(u.cachedReadTokens, 600);
    assert.equal(u.outputTokens, 130);
    assert.equal(u.explicitCacheReport, true);
    assert.equal(u.complete, true);
  });
});

describe("rewriteRequestBody", () => {
  test("platform mode rejects off-allowlist models", () => {
    const out = rewriteRequestBody(JSON.stringify({ model: "gpt-4o", stream: true }), {
      dialect: "openai-chat",
      enforceModelAllowlist: ["gpt-5.6-terra"],
      capOutputTokens: 32000,
    });
    assert.ok("rejected" in out);
  });

  test("injects include_usage even when the client disabled it, and inserts the output cap when absent", () => {
    const out = rewriteRequestBody(
      JSON.stringify({ model: "gpt-5.6-terra", stream: true, stream_options: { include_usage: false } }),
      { dialect: "openai-chat", enforceModelAllowlist: ["gpt-5.6-terra"], capOutputTokens: 32000 },
    );
    assert.ok(!("rejected" in out));
    const body = JSON.parse(out.body);
    assert.equal(body.stream_options.include_usage, true);
    assert.equal(body.max_tokens, 32000);
    assert.equal(out.effectiveMaxOutput, 32000);
    assert.equal(out.streaming, true);
  });

  test("clamps an oversized requested cap (responses dialect field name)", () => {
    const out = rewriteRequestBody(
      JSON.stringify({ model: "gpt-5.6-luna", stream: true, max_output_tokens: 900000 }),
      { dialect: "openai-responses", enforceModelAllowlist: ["gpt-5.6-luna"], capOutputTokens: 32000 },
    );
    assert.ok(!("rejected" in out));
    assert.equal(JSON.parse(out.body).max_output_tokens, 32000);
  });

  test("google: clamps generationConfig.maxOutputTokens; model gate deferred to URL", () => {
    const out = rewriteRequestBody(
      JSON.stringify({ contents: [], generationConfig: { maxOutputTokens: 500000 } }),
      { dialect: "google", enforceModelAllowlist: ["gemini-3.1-pro-preview"], capOutputTokens: 32000 },
    );
    assert.ok(!("rejected" in out));
    assert.equal(JSON.parse(out.body).generationConfig.maxOutputTokens, 32000);
  });

  test("personal-cred mode leaves the body unclamped", () => {
    const out = rewriteRequestBody(
      JSON.stringify({ model: "claude-sonnet-5", stream: true, max_tokens: 64000 }),
      { dialect: "anthropic", enforceModelAllowlist: null, capOutputTokens: null },
    );
    assert.ok(!("rejected" in out));
    assert.equal(JSON.parse(out.body).max_tokens, 64000);
    assert.equal(out.effectiveMaxOutput, 64000);
  });

  test("non-JSON body rejected", () => {
    assert.ok("rejected" in rewriteRequestBody("<xml/>", {
      dialect: "openai-chat",
      enforceModelAllowlist: null,
      capOutputTokens: null,
    }));
  });
});

describe("meterResponse tee", () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
  }

  test("client branch is byte-identical and settle fires once with parsed usage", async () => {
    const chunks = [
      sse([{ type: "message_start", message: { usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 3, output_tokens: 1 } } }]),
      sse([{ type: "message_delta", usage: { output_tokens: 9 } }, { type: "message_stop" }]),
    ];
    let settled: ObservedUsage | null = null;
    let settleCount = 0;
    const client = meterResponse(
      streamOf(chunks),
      createUsageParser("anthropic", true),
      (u) => { settled = u; settleCount += 1; },
    );

    const reader = client.getReader();
    const dec = new TextDecoder();
    let received = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += dec.decode(value, { stream: true });
    }
    assert.equal(received, chunks.join(""));
    // Give the meter branch's microtasks a beat.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(settleCount, 1);
    assert.equal(settled!.inputTokens, 10);
    assert.equal(settled!.outputTokens, 9);
    assert.equal(settled!.complete, true);
  });
});

describe("clock heuristic", () => {
  test("key is namespaced by provider + credMode", () => {
    assert.equal(
      clockHeuristicKey({ provider: "fireworks", credMode: "platform", userId: "u1", projectId: "p1" }),
      "llm-proxy:last_call:fireworks:platform:u1:p1",
    );
  });

  test("no-op Redis stub: usage passes through unchanged (fail-open on the DISCOUNT side)", async () => {
    const usage: ObservedUsage = {
      inputTokens: 1000,
      outputTokens: 50,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      explicitCacheReport: false,
      complete: true,
    };
    const out = await applyClockHeuristic(usage, "llm-proxy:last_call:test", Date.now());
    assert.equal(out.cachedReadTokens, 0); // no prior timestamp ⇒ no discount
  });
});
