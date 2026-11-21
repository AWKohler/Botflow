/**
 * Server-side turn assembly: replaying a bridge event file must produce the
 * same assistant message the live stream did — deterministic id, text + tool
 * parts — and report how the turn ended.
 *
 * Run: npx vitest run src/lib/agent/turn-persistence.test.ts
 */
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { assembleTurnMessage, assistantMessageIdForTurn } from "./turn-persistence";

function line(event: unknown): string {
  return JSON.stringify(event);
}

const assistantText = (text: string) =>
  line({
    type: "sdk_message",
    message: {
      type: "assistant",
      message: { id: "m1", role: "assistant", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    },
  });

describe("assembleTurnMessage", () => {
  test("rebuilds a finished Claude Code turn under the turn's message id", async () => {
    const ndjson = [
      line({ type: "ready" }),
      line({ type: "session_started", sessionId: "s1" }),
      assistantText("Added the login page."),
      line({ type: "end_turn" }),
    ].join("\n");
    const out = await assembleTurnMessage(ndjson, "claude-code", "abc123");
    assert.equal(out.sawEndTurn, true);
    assert.equal(out.errorText, null);
    assert.ok(out.message);
    assert.equal(out.message!.id, assistantMessageIdForTurn("abc123"));
    assert.equal(out.message!.role, "assistant");
    const text = out.message!.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("");
    assert.match(text, /Added the login page\./);
    // The synthetic endTurn marker is part of the saved message, exactly as
    // the live stream delivers it to the browser.
    assert.ok(out.message!.parts.some((p) => JSON.stringify(p).includes("endTurn")));
  });

  test("reports a bridge error and keeps the partial reply", async () => {
    const ndjson = [assistantText("Starting…"), line({ type: "error", error: "provider overloaded" })].join("\n");
    const out = await assembleTurnMessage(ndjson, "claude-code", "err1");
    assert.equal(out.sawEndTurn, false);
    assert.equal(out.errorText, "provider overloaded");
    assert.ok(out.message);
  });

  test("tolerates a torn final line from a killed bridge", async () => {
    const ndjson = [assistantText("Half"), '{"type":"sdk_mess'].join("\n");
    const out = await assembleTurnMessage(ndjson, "claude-code", "torn1");
    assert.equal(out.sawEndTurn, false);
    assert.equal(out.errorText, null);
    assert.ok(out.message);
  });

  test("an empty event file yields no message", async () => {
    const out = await assembleTurnMessage("", "opencode", "empty1");
    assert.equal(out.message, null);
  });
});
