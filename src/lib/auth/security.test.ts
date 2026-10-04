import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptPrivateData, decryptPrivateData } from "./crypto";
import { safeRedirect, requireSameOrigin, ownerIds } from "./policy";
import { password } from "./password";
import { hash } from "bcryptjs";
import { subscriptionTier } from "../billing/entitlements";

test("encrypted private metadata is authenticated and bound to its user", () => {
  process.env.IDENTITY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const payload = { apiKey: "test-only-secret", nested: { token: "example" } };
  const encrypted = encryptPrivateData(payload, "profile:one");
  assert.ok(!encrypted.includes("test-only-secret"));
  assert.deepEqual(decryptPrivateData(encrypted, "profile:one"), payload);
  assert.throws(() => decryptPrivateData(encrypted, "profile:two"));
  const parts = encrypted.split(".");
  parts[3] = Buffer.alloc(Buffer.from(parts[3], "base64").length).toString(
    "base64",
  );
  assert.throws(() => decryptPrivateData(parts.join("."), "profile:one"));
});
test("local redirects reject scheme-relative, backslash, and control-character destinations", () => {
  for (const redirect of [
    "//evil.example",
    "https://evil.example",
    "/\\evil.example",
    "/ok\r\nLocation: evil",
  ])
    assert.equal(safeRedirect(redirect), "/");
  assert.equal(
    safeRedirect("/workspace/123?tab=settings"),
    "/workspace/123?tab=settings",
  );
});
test("mutations require an exact same-origin request", () => {
  assert.equal(
    requireSameOrigin(
      new Request("https://botflow.io/api/billing/checkout", {
        headers: { origin: "https://evil.example" },
      }),
    ),
    false,
  );
  assert.equal(
    requireSameOrigin(new Request("https://botflow.io/api/billing/checkout")),
    false,
  );
  assert.equal(
    requireSameOrigin(
      new Request("https://botflow.io/api/billing/checkout", {
        headers: { origin: "https://botflow.io" },
      }),
    ),
    true,
  );
});
test("an explicitly empty owner allowlist fails closed", () => {
  const original = process.env.PANEL_ADMIN_USER_IDS;
  process.env.PANEL_ADMIN_USER_IDS = " , ";
  assert.deepEqual(ownerIds(), []);
  if (original === undefined) delete process.env.PANEL_ADMIN_USER_IDS;
  else process.env.PANEL_ADMIN_USER_IDS = original;
});
test("imported bcrypt and newly generated scrypt passwords both verify", async () => {
  const legacy = await hash("migration-test-passphrase", 10);
  assert.equal(
    await password.verify({
      hash: legacy,
      password: "migration-test-passphrase",
    }),
    true,
  );
  assert.equal(
    await password.verify({ hash: legacy, password: "wrong" }),
    false,
  );
  const fresh = await password.hash("new-test-passphrase");
  assert.equal(
    await password.verify({ hash: fresh, password: "new-test-passphrase" }),
    true,
  );
  assert.equal(
    await password.verify({ hash: fresh, password: "wrong" }),
    false,
  );
});
test("paid tiers expire, canceled paid time is honored, and delinquent plans do not grant access", () => {
  const now = Date.now();
  const base = {
    plan: "pro",
    status: "active",
    period_end: new Date(now + 60000),
  };
  assert.equal(subscriptionTier(base, now), "pro");
  assert.equal(subscriptionTier({ ...base, status: "canceled" }, now), "pro");
  assert.equal(
    subscriptionTier({ ...base, period_end: new Date(now - 1) }, now),
    "free",
  );
  assert.equal(subscriptionTier({ ...base, status: "past_due" }, now), "free");
  assert.equal(subscriptionTier({ ...base, plan: "max" }, now), "max");
  assert.equal(subscriptionTier(null, now), "free");
  assert.equal(
    subscriptionTier({ ...base, source: "stripe", status: "canceled" }, now),
    "free",
  );
  assert.equal(
    subscriptionTier({ ...base, source: "clerk", status: "canceled" }, now),
    "pro",
  );
});
