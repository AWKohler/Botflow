/**
 * Unit tests for the mount-time unfinished-turn detector.
 *
 * Run with: node --import tsx --test src/lib/agent/transcript-tail.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { transcriptHasUnfinishedTail } from "./transcript-tail";

describe("transcriptHasUnfinishedTail", () => {
  test("empty transcript has no unfinished tail", () => {
    assert.equal(transcriptHasUnfinishedTail([]), false);
  });

  test("transcript ending on an assistant message is finished", () => {
    assert.equal(
      transcriptHasUnfinishedTail([
        { role: "user" },
        { role: "assistant" },
      ]),
      false,
    );
  });

  test("transcript ending on a user message is unfinished", () => {
    assert.equal(
      transcriptHasUnfinishedTail([
        { role: "user" },
        { role: "assistant" },
        { role: "user" },
      ]),
      true,
    );
  });

  test("single user message (turn cut before any assistant output persisted)", () => {
    assert.equal(transcriptHasUnfinishedTail([{ role: "user" }]), true);
  });

  test("system tail does not count as unfinished", () => {
    assert.equal(
      transcriptHasUnfinishedTail([{ role: "user" }, { role: "system" }]),
      false,
    );
  });
});
