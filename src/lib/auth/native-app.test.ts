import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { createUser } from "@/test/auth";
import { currentIdentityPool, setupTestDb } from "@/test/db";
import { createIdentityAuth } from "./config";

setupTestDb();

const ORIGIN = "https://botflow.test";

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
  vi.stubEnv("TURNSTILE_SECRET_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** A real browser session for `userId`, as the cookie header a browser would send. */
async function browserSession(auth: ReturnType<typeof createIdentityAuth>, userId: string, extra: Record<string, unknown> = {}) {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId, false, extra);
  const signed = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;
  return { session, cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(signed)}` };
}

function post(path: string, body: unknown, cookie?: string) {
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function mintCode(auth: ReturnType<typeof createIdentityAuth>, cookie: string, challenge: string) {
  const res = await auth.handler(post("/native/authorize", { challenge }, cookie));
  expect(res.status).toBe(200);
  return ((await res.json()) as { code: string }).code;
}

describe("native app sign-in", () => {
  test("a confirmed code and its verifier become a separate session for the same user", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    await createUser({ id: "u1", email: "sam@example.test", name: "Sam" });
    const browser = await browserSession(auth, "u1");
    const { verifier, challenge } = pkce();

    const code = await mintCode(auth, browser.cookie, challenge);
    const res = await auth.handler(post("/native/token", { code, verifier, deviceName: "Sam’s iPhone" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { id: string } }).user.id).toBe("u1");

    const setCookie = res.headers.get("set-cookie") ?? "";
    const cookiePair = setCookie.split(";")[0];
    expect(cookiePair).toContain("session_token=");

    // The app's cookie authenticates as the same user, on its own session row.
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookiePair }) });
    expect(session?.user.id).toBe("u1");
    expect(session?.session.id).not.toBe(browser.session.id);
    expect(session?.session.userAgent).toBe("Botflow for iOS (Sam’s iPhone)");
  });

  test("the code is stored hashed", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    await createUser({ id: "u1" });
    const browser = await browserSession(auth, "u1");
    const code = await mintCode(auth, browser.cookie, pkce().challenge);
    const { rows } = await currentIdentityPool().query("SELECT identifier, value FROM identity_verification");
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  test("a wrong verifier is refused and burns the code", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    await createUser({ id: "u1" });
    const browser = await browserSession(auth, "u1");
    const { verifier, challenge } = pkce();
    const code = await mintCode(auth, browser.cookie, challenge);

    const stolen = await auth.handler(post("/native/token", { code, verifier: pkce().verifier }));
    expect(stolen.status).toBe(401);
    expect(stolen.headers.get("set-cookie")).toBeNull();

    // The rightful app can no longer use it either: start over.
    const retry = await auth.handler(post("/native/token", { code, verifier }));
    expect(retry.status).toBe(401);
  });

  test("a code works once", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    await createUser({ id: "u1" });
    const browser = await browserSession(auth, "u1");
    const { verifier, challenge } = pkce();
    const code = await mintCode(auth, browser.cookie, challenge);
    expect((await auth.handler(post("/native/token", { code, verifier }))).status).toBe(200);
    expect((await auth.handler(post("/native/token", { code, verifier }))).status).toBe(401);
  });

  test("an expired code is refused", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    await createUser({ id: "u1" });
    const browser = await browserSession(auth, "u1");
    const { verifier, challenge } = pkce();
    const code = await mintCode(auth, browser.cookie, challenge);
    await currentIdentityPool().query(`UPDATE identity_verification SET "expiresAt" = now() - interval '1 minute'`);
    expect((await auth.handler(post("/native/token", { code, verifier }))).status).toBe(401);
  });

  test("minting a code needs a signed-in browser", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    const res = await auth.handler(post("/native/authorize", { challenge: pkce().challenge }));
    expect(res.status).toBe(401);
  });

  test("an impersonation session cannot sign the app in", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    await createUser({ id: "u1" });
    await createUser({ id: "admin" });
    const browser = await browserSession(auth, "u1", { impersonatedBy: "admin" });
    const res = await auth.handler(post("/native/authorize", { challenge: pkce().challenge }, browser.cookie));
    expect(res.status).toBe(403);
  });

  test("a malformed challenge is rejected", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    await createUser({ id: "u1" });
    const browser = await browserSession(auth, "u1");
    const res = await auth.handler(post("/native/authorize", { challenge: "short" }, browser.cookie));
    expect(res.status).toBe(400);
  });
});
