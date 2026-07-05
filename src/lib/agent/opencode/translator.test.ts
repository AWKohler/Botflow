/**
 * Fixture tests for the OpenCode translator. Event shapes mirror real
 * opencode 1.17.13 output captured during the integration spike (user-echo
 * parts, accumulated-text part updates, tool state lifecycle).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { UIMessageChunk, UIMessageStreamWriter } from "ai";

import {
  createOpenCodeTranslator,
  normalizeOpenCodeToolName,
  type OpenCodeBridgeEvent,
} from "./translator";

type Chunk = UIMessageChunk & { [k: string]: unknown };

function collect() {
  const chunks: Chunk[] = [];
  const writer = {
    write: (c: UIMessageChunk) => {
      chunks.push(c as Chunk);
    },
  } as unknown as UIMessageStreamWriter;
  return { chunks, writer };
}

function ocPartUpdated(part: Record<string, unknown>, delta?: string): OpenCodeBridgeEvent {
  return {
    type: "oc_event",
    event: {
      type: "message.part.updated",
      properties: { part, ...(delta !== undefined ? { delta } : {}) },
    },
  } as OpenCodeBridgeEvent;
}

function ocMessageUpdated(id: string, role: string): OpenCodeBridgeEvent {
  return {
    type: "oc_event",
    event: { type: "message.updated", properties: { info: { id, role, sessionID: "s1" } } },
  } as OpenCodeBridgeEvent;
}

describe("text streaming", () => {
  test("assistant text streams as prefix-diffed deltas; user echo is filtered", () => {
    const { chunks, writer } = collect();
    const tr = createOpenCodeTranslator(writer);

    // User prompt echo (as seen in the real event stream) — must NOT render.
    tr.push(ocMessageUpdated("m-user", "user"));
    tr.push(ocPartUpdated({ id: "p-echo", messageID: "m-user", type: "text", text: "Say hi" }));

    tr.push(ocMessageUpdated("m-asst", "assistant"));
    tr.push(ocPartUpdated({ id: "p1", messageID: "m-asst", type: "text", text: "Hel" }));
    tr.push(ocPartUpdated({ id: "p1", messageID: "m-asst", type: "text", text: "Hello wor" }));
    tr.push(
      ocPartUpdated({
        id: "p1",
        messageID: "m-asst",
        type: "text",
        text: "Hello world",
        time: { start: 1, end: 2 },
      }),
    );
    tr.push({ type: "end_turn" });

    const textChunks = chunks.filter((c) => String(c.type).startsWith("text-"));
    assert.deepEqual(
      textChunks.map((c) => [c.type, (c as { delta?: string }).delta ?? null]),
      [
        ["text-start", null],
        ["text-delta", "Hel"],
        ["text-delta", "lo wor"],
        ["text-delta", "ld"],
        ["text-end", null],
      ],
    );
    // Exactly one start and one finish.
    assert.equal(chunks.filter((c) => c.type === "start").length, 1);
    assert.equal(chunks.filter((c) => c.type === "finish").length, 1);
  });

  test("delta-only delivery (no part.text) still appends", () => {
    const { chunks, writer } = collect();
    const tr = createOpenCodeTranslator(writer);
    tr.push(ocMessageUpdated("m1", "assistant"));
    tr.push(ocPartUpdated({ id: "p1", messageID: "m1", type: "text" }, "Hi"));
    tr.push(ocPartUpdated({ id: "p1", messageID: "m1", type: "text" }, " there"));
    const deltas = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta?: string }).delta);
    assert.deepEqual(deltas, ["Hi", " there"]);
  });
});

describe("tool lifecycle", () => {
  const toolPart = (status: string, extra: Record<string, unknown> = {}) => ({
    id: "part-t1",
    messageID: "m1",
    type: "tool",
    callID: "call-1",
    tool: "botflow_convex_deploy",
    state: { status, ...extra },
  });

  test("pending → running → completed emits the full chunk sequence with the MCP prefix stripped", () => {
    const { chunks, writer } = collect();
    const tr = createOpenCodeTranslator(writer);
    tr.push(ocMessageUpdated("m1", "assistant"));
    tr.push(ocPartUpdated(toolPart("pending", { input: {} })));
    tr.push(ocPartUpdated(toolPart("running", { input: { a: 1 } })));
    tr.push(ocPartUpdated(toolPart("completed", { input: { a: 1 }, output: "deployed" })));

    const tool = chunks.filter((c) => String(c.type).startsWith("tool-"));
    assert.deepEqual(
      tool.map((c) => c.type),
      ["tool-input-start", "tool-input-available", "tool-output-available"],
    );
    assert.equal((tool[0] as { toolName?: string }).toolName, "convex_deploy");
    assert.deepEqual((tool[1] as { input?: unknown }).input, { a: 1 });
    assert.equal((tool[2] as { output?: unknown }).output, "deployed");
  });

  test("straight-to-completed still emits input first; error state maps to tool-output-error", () => {
    const { chunks, writer } = collect();
    const tr = createOpenCodeTranslator(writer);
    tr.push(ocMessageUpdated("m1", "assistant"));
    tr.push(ocPartUpdated(toolPart("error", { input: { x: 2 }, error: "boom" })));

    const tool = chunks.filter((c) => String(c.type).startsWith("tool-"));
    assert.deepEqual(
      tool.map((c) => c.type),
      ["tool-input-start", "tool-input-available", "tool-output-error"],
    );
    assert.equal((tool[2] as { errorText?: string }).errorText, "boom");
  });
});

describe("turn envelope", () => {
  test("end_turn synthesizes the endTurn tool and finishes once (end() backstop is a no-op)", () => {
    const { chunks, writer } = collect();
    const tr = createOpenCodeTranslator(writer);
    tr.push({ type: "end_turn" });
    tr.end();

    const endTurn = chunks.filter(
      (c) => (c as { toolCallId?: string }).toolCallId === "opencode-end-turn",
    );
    assert.equal(endTurn.length, 2); // input-available + output-available
    assert.equal(chunks.filter((c) => c.type === "finish").length, 1);
  });

  test("aborted end_turn skips the endTurn synthesis but still finishes cleanly", () => {
    const { chunks, writer } = collect();
    const tr = createOpenCodeTranslator(writer);
    tr.push({ type: "end_turn", aborted: true });
    assert.equal(
      chunks.filter((c) => (c as { toolCallId?: string }).toolCallId === "opencode-end-turn").length,
      0,
    );
    assert.equal(chunks.filter((c) => c.type === "finish").length, 1);
    assert.equal((chunks.find((c) => c.type === "finish") as { finishReason?: string }).finishReason, "stop");
  });

  test("error event yields an error chunk and finish(error)", () => {
    const { chunks, writer } = collect();
    const tr = createOpenCodeTranslator(writer);
    tr.push({ type: "error", error: "APIError: nope" });
    assert.equal((chunks.find((c) => c.type === "error") as { errorText?: string }).errorText, "APIError: nope");
    assert.equal((chunks.find((c) => c.type === "finish") as { finishReason?: string }).finishReason, "error");
  });

  test("usage and retry status surface as transient data parts", () => {
    const { chunks, writer } = collect();
    const tr = createOpenCodeTranslator(writer);
    tr.push({
      type: "usage",
      source: "assistant",
      tokens: 1234,
      breakdown: { input: 1000, output: 34, cacheCreate: 100, cacheRead: 100 },
      cost: 0.01,
    });
    tr.push({
      type: "oc_event",
      event: { type: "session.status", properties: { status: { type: "retry", message: "rate limited" } } },
    } as OpenCodeBridgeEvent);

    const usage = chunks.find((c) => c.type === "data-opencode-usage") as {
      data?: { tokens?: number };
      transient?: boolean;
    };
    assert.equal(usage?.data?.tokens, 1234);
    assert.equal(usage?.transient, true);
    const status = chunks.find((c) => c.type === "data-opencode-status") as {
      data?: { status?: string };
    };
    assert.equal(status?.data?.status, "retrying");
  });
});

describe("normalizeOpenCodeToolName", () => {
  test("strips botflow prefixes and passes natives through", () => {
    assert.equal(normalizeOpenCodeToolName("botflow_ask_question"), "ask_question");
    assert.equal(normalizeOpenCodeToolName("botflow.git_status"), "git_status");
    assert.equal(normalizeOpenCodeToolName("bash"), "bash");
  });
});
