/**
 * Pure thread rules: status precedence, titles, and the cross-agent
 * awareness note.
 *
 * Run: npx vitest run src/lib/agent/threads.test.ts
 */
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { awarenessNote, computeThreadStatus, deriveThreadTitle } from "./threads";

describe("computeThreadStatus", () => {
  test("needs-input wins over a live turn (the agent is blocked on the user)", () => {
    assert.equal(computeThreadStatus({ live: true, needsInput: true, lastTurnError: null }), "needs_input");
  });
  test("a live turn is running even if the previous one failed", () => {
    assert.equal(computeThreadStatus({ live: true, needsInput: false, lastTurnError: "boom" }), "running");
  });
  test("an ended turn with an error is red", () => {
    assert.equal(computeThreadStatus({ live: false, needsInput: false, lastTurnError: "boom" }), "error");
  });
  test("otherwise idle", () => {
    assert.equal(computeThreadStatus({ live: false, needsInput: false, lastTurnError: null }), "idle");
  });
});

describe("deriveThreadTitle", () => {
  test("collapses whitespace", () => {
    assert.equal(deriveThreadTitle("  Build a\n\ttodo   app "), "Build a todo app");
  });
  test("caps long prompts with an ellipsis", () => {
    const title = deriveThreadTitle("x".repeat(200))!;
    assert.equal(title.length, 80);
    assert.ok(title.endsWith("…"));
  });
  test("system notes and empty prompts don't name a thread", () => {
    assert.equal(deriveThreadTitle("[system-note] Automatic continuation"), null);
    assert.equal(deriveThreadTitle("   "), null);
  });
});

describe("awarenessNote", () => {
  test("absent when no other agent runs", () => {
    assert.equal(awarenessNote([]), null);
  });
  test("names the other threads and asks to re-read before editing", () => {
    const note = awarenessNote(["Fix login", "Add billing page"])!;
    assert.match(note, /- Fix login/);
    assert.match(note, /- Add billing page/);
    assert.match(note, /Re-read any file right before you edit it/);
  });
});
