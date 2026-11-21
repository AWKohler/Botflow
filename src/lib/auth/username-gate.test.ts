import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, emailOTP, username } from "better-auth/plugins";
import {
  USERNAME_GATE_BAN_REASON,
  gateNewUser,
  isGateBannedUser,
  isGibberishUsername,
} from "./username-gate";

const original = process.env.USERNAME_GATE_ENABLED;
beforeEach(() => {
  process.env.USERNAME_GATE_ENABLED = "true";
});
afterEach(() => {
  process.env.USERNAME_GATE_ENABLED = original;
});

test("literal UUIDs and hex hashes are flagged without a model call", async () => {
  const classify = vi.fn(async () => false);
  for (const u of [
    "3f2b8c1e-9a4d-4e7f-b2c6-1d8e5a0f9c3b",
    "3f2b8c1e9a4d4e7fb2c61d8e5a0f9c3b",
    "a8f3c2e9b71d4f06",
  ])
    expect(await isGibberishUsername(u, classify)).toBe(true);
  expect(classify).not.toHaveBeenCalled();
});

test("other usernames defer to the model, and model failures fail open", async () => {
  expect(await isGibberishUsername("x7f3k9qzp2mv", async () => true)).toBe(true);
  expect(await isGibberishUsername("aronne_k", async () => false)).toBe(false);
  expect(
    await isGibberishUsername("anything", async () => {
      throw new Error("timeout");
    }),
  ).toBe(false);
});

test("the gate is a no-op when the flag is off", async () => {
  process.env.USERNAME_GATE_ENABLED = "false";
  const classify = vi.fn(async () => true);
  expect(await gateNewUser({ name: "aPveyXtWPlzzRzvHwYbEuGT" }, classify)).toBeUndefined();
  expect(classify).not.toHaveBeenCalled();
});

test("the name is checked even when there is no username (the real sign-up form)", async () => {
  const seen: string[] = [];
  const classify = async (u: string) => (seen.push(u), u === "aPveyXtWPlzzRzvHwYbEuGT");
  const res = await gateNewUser({ name: "aPveyXtWPlzzRzvHwYbEuGT", email: "a@b.c" }, classify);
  expect(res?.data.banned).toBe(true);
  expect(seen).toEqual(["aPveyXtWPlzzRzvHwYbEuGT"]);
  expect(await gateNewUser({ name: "Nancy Sayers" }, classify)).toBeUndefined();
});

test("only gate bans suppress email", () => {
  expect(isGateBannedUser({ banned: true, banReason: USERNAME_GATE_BAN_REASON })).toBe(true);
  expect(isGateBannedUser({ banned: true, banReason: "Suspended by account owner" })).toBe(false);
  expect(isGateBannedUser({ banned: false, banReason: USERNAME_GATE_BAN_REASON })).toBe(false);
  expect(isGateBannedUser(undefined)).toBe(false);
});

// Mirrors the wiring in config.ts against a real Better Auth sign-up so hook
// ordering (admin plugin defaults, OTP-on-sign-up inside the transaction) is
// exercised end to end.
function makeAuth(classify: (u: string) => Promise<boolean>) {
  const db: Record<string, unknown[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const sent: { email: string; type: string }[] = [];
  const auth = betterAuth({
    secret: "test-secret-test-secret-test-secret-123",
    baseURL: "http://localhost:3000",
    database: memoryAdapter(db),
    databaseHooks: {
      user: { create: { before: async (user) => gateNewUser(user, classify) } },
    },
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    plugins: [
      username(),
      admin(),
      emailOTP({
        sendVerificationOnSignUp: true,
        overrideDefaultEmailVerification: true,
        async sendVerificationOTP({ email, type }, ctx) {
          const found = await ctx?.context.internalAdapter.findUserByEmail(email);
          if (isGateBannedUser(found?.user as Parameters<typeof isGateBannedUser>[0]))
            return;
          sent.push({ email, type });
        },
      }),
    ],
  });
  return { auth, db, sent };
}

// Same fields the real sign-up form sends: no username.
async function signUp(auth: ReturnType<typeof makeAuth>["auth"], name: string) {
  return auth.api.signUpEmail({
    body: {
      email: `${name.replace(/\s/g, "")}@example.com`,
      password: "correct-horse-battery",
      name,
    },
  });
}

test("a flagged sign-up is created banned, gets no OTP, and sees a normal response", async () => {
  const { auth, db, sent } = makeAuth(async () => true);
  const res = await signUp(auth, "aPveyXtWPlzzRzvHwYbEuGT");
  expect(res.user.email).toBe("apveyxtwplzzrzvhwybeugt@example.com");
  const row = db.user[0] as { banned: boolean; banReason: string; role: string };
  expect(row.banned).toBe(true);
  expect(row.banReason).toBe(USERNAME_GATE_BAN_REASON);
  expect(row.role).toBe("user");
  expect(sent).toEqual([]);

  // Asking for the code again is also silently dropped.
  await auth.api.sendVerificationOTP({
    body: { email: "apveyxtwplzzrzvhwybeugt@example.com", type: "email-verification" },
  });
  expect(sent).toEqual([]);
});

test("a normal sign-up is untouched and gets its OTP", async () => {
  const { auth, db, sent } = makeAuth(async () => false);
  await signUp(auth, "Nancy Sayers");
  expect((db.user[0] as { banned?: boolean }).banned).not.toBe(true);
  expect(sent).toEqual([{ email: "nancysayers@example.com", type: "email-verification" }]);
});
