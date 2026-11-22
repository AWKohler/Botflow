import { afterEach, describe, expect, test, vi } from "vitest";
import { createUser } from "@/test/auth";
import { currentIdentityPool, setupTestDb } from "@/test/db";
import { getPaidTier } from "@/lib/billing/entitlements";
import {
  AppStoreError,
  appAccountTokenFor,
  applyAppleUpdate,
  getAppleTier,
  recordAppleTransaction,
  verifyAppStoreJws,
  type AppStoreTransaction,
} from "./app-store";
import { FORGED_SIGNATURE, NOTIFICATION, ROOT_SHA256, SANDBOX, VALID, WRONG_ISSUER } from "./app-store.fixtures";

setupTestDb();
afterEach(() => vi.unstubAllEnvs());

const trust = { trustedRoots: [ROOT_SHA256] };

describe("verifying Apple's signature", () => {
  test("a payload signed through a trusted chain is returned", () => {
    const tx = verifyAppStoreJws<AppStoreTransaction>(VALID, trust);
    expect(tx).toMatchObject({ bundleId: "io.botflow.app", productId: "io.botflow.pro.monthly", environment: "Production" });
  });

  test("a chain that does not end at Apple's root is refused by default", () => {
    expect(() => verifyAppStoreJws(VALID)).toThrow("not signed by Apple");
  });

  test("a certificate not issued by the next one in the chain is refused", () => {
    expect(() => verifyAppStoreJws(WRONG_ISSUER, trust)).toThrow(AppStoreError);
  });

  test("a signature made with another key is refused", () => {
    expect(() => verifyAppStoreJws(FORGED_SIGNATURE, trust)).toThrow("signature is invalid");
  });

  test("an edited payload is refused", () => {
    const [header, , signature] = VALID.split(".");
    const edited = Buffer.from(JSON.stringify({ bundleId: "io.botflow.app", productId: "io.botflow.max.yearly" })).toString("base64url");
    expect(() => verifyAppStoreJws(`${header}.${edited}.${signature}`, trust)).toThrow("signature is invalid");
  });

  test("certificates past their dates are refused", () => {
    expect(() => verifyAppStoreJws(VALID, { ...trust, now: Date.UTC(2090, 0, 1) })).toThrow("validity period");
  });

  test("an unsigned or malformed token is refused", () => {
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${VALID.split(".")[1]}.`;
    expect(() => verifyAppStoreJws(none, trust)).toThrow(AppStoreError);
    expect(() => verifyAppStoreJws("not-a-jws", trust)).toThrow(AppStoreError);
  });
});

describe("recording a purchase", () => {
  const tx = () => verifyAppStoreJws<AppStoreTransaction>(VALID, trust);

  test("a verified subscription raises the buyer's plan", async () => {
    await createUser({ id: "u1" });
    expect(await getPaidTier("u1")).toBe("free");
    const row = await recordAppleTransaction("u1", tx());
    expect(row).toMatchObject({ plan: "pro", interval: "month", user_id: "u1" });
    expect(await getPaidTier("u1")).toBe("pro");
  });

  test("recording the same transaction again changes nothing", async () => {
    await createUser({ id: "u1" });
    await recordAppleTransaction("u1", tx());
    await recordAppleTransaction("u1", tx());
    const { rows } = await currentIdentityPool().query("SELECT count(*)::int AS n FROM botflow_apple_subscription");
    expect(rows[0]).toMatchObject({ n: 1 });
  });

  test("one Apple subscription cannot give a plan to a second account", async () => {
    await createUser({ id: "u1" });
    await createUser({ id: "u2" });
    await recordAppleTransaction("u1", tx());
    await expect(recordAppleTransaction("u2", tx())).rejects.toMatchObject({ status: 409 });
    expect(await getPaidTier("u2")).toBe("free");
  });

  test("a purchase tagged for another account is refused", async () => {
    await createUser({ id: "u1" });
    await createUser({ id: "u2" });
    await expect(recordAppleTransaction("u2", { ...tx(), appAccountToken: appAccountTokenFor("u1") })).rejects.toMatchObject({ status: 409 });
    await expect(recordAppleTransaction("u1", { ...tx(), appAccountToken: appAccountTokenFor("u1").toUpperCase() })).resolves.toBeTruthy();
  });

  test("the account token is a stable, well-formed UUID", () => {
    expect(appAccountTokenFor("user_abc")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // The iOS app derives the same value (ios/BotflowTests/CoreTests.swift).
    expect(appAccountTokenFor("user_abc")).toBe("4815155e-12b5-5da2-9210-f893594485dd");
    expect(appAccountTokenFor("user_abc")).not.toBe(appAccountTokenFor("user_abd"));
  });

  test("sandbox purchases, which are free, grant nothing unless allowed", async () => {
    await createUser({ id: "u1" });
    const sandbox = verifyAppStoreJws<AppStoreTransaction>(SANDBOX, trust);
    await expect(recordAppleTransaction("u1", sandbox)).rejects.toMatchObject({ status: 403 });
    vi.stubEnv("APPLE_IAP_ALLOW_SANDBOX", "true");
    await expect(recordAppleTransaction("u1", sandbox)).resolves.toMatchObject({ plan: "pro" });
  });

  test("another app's purchase, an unknown product and a non-subscription are refused", async () => {
    await createUser({ id: "u1" });
    await expect(recordAppleTransaction("u1", { ...tx(), bundleId: "com.example.other" })).rejects.toBeInstanceOf(AppStoreError);
    await expect(recordAppleTransaction("u1", { ...tx(), productId: "io.botflow.unknown" })).rejects.toBeInstanceOf(AppStoreError);
    await expect(recordAppleTransaction("u1", { ...tx(), expiresDate: undefined })).rejects.toBeInstanceOf(AppStoreError);
  });

  test("an expired or refunded subscription no longer counts", async () => {
    await createUser({ id: "u1" });
    await recordAppleTransaction("u1", { ...tx(), expiresDate: Date.now() + 60_000 });
    expect(await getAppleTier("u1")).toBe("pro");
    expect(await getAppleTier("u1", Date.now() + 120_000)).toBe("free");
    await applyAppleUpdate({ ...tx(), revocationDate: Date.now() });
    expect(await getAppleTier("u1")).toBe("free");
  });

  test("the higher of a Stripe plan and an App Store plan wins", async () => {
    await createUser({ id: "u1", plan: "max" });
    await recordAppleTransaction("u1", tx());
    expect(await getPaidTier("u1")).toBe("max");
  });
});

describe("renewals reported by Apple", () => {
  test("a renewal extends a known subscription and can change its plan", async () => {
    await createUser({ id: "u1" });
    await recordAppleTransaction("u1", verifyAppStoreJws<AppStoreTransaction>(VALID, trust));
    const notification = verifyAppStoreJws<{ data: { signedTransactionInfo: string } }>(NOTIFICATION, trust);
    const renewal = verifyAppStoreJws<AppStoreTransaction>(notification.data.signedTransactionInfo, trust);
    expect(await applyAppleUpdate(renewal)).toBe(true);
    expect(await getPaidTier("u1")).toBe("max");
  });

  test("a subscription nobody claimed is ignored", async () => {
    expect(await applyAppleUpdate(verifyAppStoreJws<AppStoreTransaction>(VALID, trust))).toBe(false);
  });
});
