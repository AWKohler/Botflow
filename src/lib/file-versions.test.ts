import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { sha256Hex, recentForeignWriteWarning, touchWriteBreadcrumb } from "./file-versions";

describe("sha256Hex", () => {
  test("deterministic and content-sensitive", () => {
    assert.equal(sha256Hex("hello"), sha256Hex("hello"));
    assert.notEqual(sha256Hex("hello"), sha256Hex("hello "));
    // Known vector: sha256("") — guards against accidental encoding changes.
    assert.equal(
      sha256Hex(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("unicode hashes by utf-8 bytes, not code units", () => {
    // NFC (composed) vs NFD (combining accent): same rendered text,
    // different bytes — CAS must treat them as different content.
    assert.notEqual(sha256Hex("café"), sha256Hex("café"));
  });
});

describe("write breadcrumbs (no-op Redis stub → fail safe)", () => {
  test("recentForeignWriteWarning returns null when no breadcrumb exists", async () => {
    const warning = await recentForeignWriteWarning("proj-x", "/src/App.tsx", {
      type: "agent",
      userId: "user-a",
    });
    assert.equal(warning, null);
  });

  test("touchWriteBreadcrumb never throws without Redis", async () => {
    await assert.doesNotReject(
      touchWriteBreadcrumb("proj-x", "/src/App.tsx", { type: "user", userId: "user-a" }),
    );
  });
});
