import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import { MAX_USER_TURN_CHARS, oversizedTurnError } from "./turn-input";

const userMsg = (text: string): UIMessage =>
  ({ id: "u1", role: "user", parts: [{ type: "text", text }] }) as UIMessage;

test("accepts a turn at the limit", () => {
  assert.equal(oversizedTurnError([userMsg("x".repeat(MAX_USER_TURN_CHARS))]), null);
});

test("rejects a turn one char over the limit", async () => {
  const res = oversizedTurnError([userMsg("x".repeat(MAX_USER_TURN_CHARS + 1))]);
  assert.ok(res, "expected a rejection");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /limit is/);
});

test("sums every text part of the current turn", () => {
  const half = "x".repeat(MAX_USER_TURN_CHARS / 2 + 1);
  const msg = {
    id: "u1",
    role: "user",
    parts: [
      { type: "text", text: half },
      { type: "text", text: half },
    ],
  } as UIMessage;
  assert.ok(oversizedTurnError([msg]), "two oversized parts must not slip through");
});

test("ignores history — only the current turn is measured", () => {
  const huge = "x".repeat(MAX_USER_TURN_CHARS + 1);
  const messages = [
    userMsg(huge),
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "ok" }] } as UIMessage,
    userMsg("short follow-up"),
  ];
  assert.equal(
    oversizedTurnError(messages),
    null,
    "an already-accepted long turn in history must not wedge the conversation",
  );
});

test("skips validation when the last message isn't from the user", () => {
  const messages = [
    userMsg("hi"),
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "y".repeat(MAX_USER_TURN_CHARS + 1) }] } as UIMessage,
  ];
  assert.equal(oversizedTurnError(messages), null);
});

test("ignores file parts — image payloads are capped separately", () => {
  const msg = {
    id: "u1",
    role: "user",
    parts: [
      { type: "text", text: "look at this" },
      { type: "file", url: `https://cdn.example/${"u".repeat(MAX_USER_TURN_CHARS)}.png`, mediaType: "image/png" },
    ],
  } as UIMessage;
  assert.equal(oversizedTurnError([msg]), null);
});

test("rejects a non-array messages body", async () => {
  for (const bad of [undefined, null, "hello", 42, { messages: [] }]) {
    const res = oversizedTurnError(bad);
    assert.ok(res, `expected rejection for ${JSON.stringify(bad)}`);
    assert.equal(res.status, 400);
  }
});

test("tolerates malformed parts without throwing", () => {
  for (const parts of [undefined, null, "not-an-array", 7, [{ type: "text" }, null]]) {
    assert.doesNotThrow(() =>
      oversizedTurnError([{ id: "u1", role: "user", parts } as unknown as UIMessage]),
    );
  }
});
