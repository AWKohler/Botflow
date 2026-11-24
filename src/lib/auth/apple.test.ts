import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { http, HttpResponse } from "msw";
import { signEs256Jwt } from "@/lib/asc-jwt";
import { createUser } from "@/test/auth";
import { currentIdentityPool, setupTestDb } from "@/test/db";
import { server } from "@/test/network";
import { appleClientSecret, appleConfig } from "./apple";
import { createIdentityAuth } from "./config";

setupTestDb();

const ORIGIN = "https://botflow.test";
const BUNDLE_ID = "io.botflow.app";
const SERVICE_ID = "io.botflow.web";

/** Stands in for Apple's identity-token signing key (published at /auth/keys). */
const apple = generateKeyPairSync("ec", { namedCurve: "P-256" });
const APPLE_KID = "apple-test-kid";
const applePem = apple.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
/** Botflow's own .p8, used to mint client secrets. */
const botflowKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

type AppleRequest = Record<string, string>;
let tokenRequests: AppleRequest[];
let revokeRequests: AppleRequest[];

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
  vi.stubEnv("TURNSTILE_SECRET_KEY", "");
  vi.stubEnv("AUTH_APPLE_TEAM_ID", "TEAM123456");
  vi.stubEnv("AUTH_APPLE_KEY_ID", "KEY1234567");
  // As pasted into an env store: newlines flattened to "\n".
  vi.stubEnv("AUTH_APPLE_PRIVATE_KEY", botflowKey.replace(/\n/g, "\\n"));
  vi.stubEnv("AUTH_APPLE_SERVICE_ID", SERVICE_ID);
  tokenRequests = [];
  revokeRequests = [];
  server.use(
    http.get("https://appleid.apple.com/auth/keys", () =>
      HttpResponse.json({
        keys: [{ ...apple.publicKey.export({ format: "jwk" }), kid: APPLE_KID, alg: "ES256", use: "sig" }],
      }),
    ),
    http.post("https://appleid.apple.com/auth/token", async ({ request }) => {
      tokenRequests.push(Object.fromEntries(new URLSearchParams(await request.text())));
      return HttpResponse.json({ access_token: "apple-access", refresh_token: "apple-refresh", id_token: "x", token_type: "Bearer", expires_in: 3600 });
    }),
    http.post("https://appleid.apple.com/auth/revoke", async ({ request }) => {
      revokeRequests.push(Object.fromEntries(new URLSearchParams(await request.text())));
      return new HttpResponse(null, { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllEnvs());

function identityToken(claims: Record<string, unknown> = {}, nonce = "a-raw-nonce-from-the-app") {
  const now = Math.floor(Date.now() / 1000);
  return signEs256Jwt({
    p8: applePem,
    keyId: APPLE_KID,
    payload: {
      iss: "https://appleid.apple.com",
      aud: BUNDLE_ID,
      iat: now,
      exp: now + 600,
      sub: "001234.apple-user.0001",
      email: "sam@privaterelay.appleid.com",
      email_verified: true,
      is_private_email: true,
      nonce: createHash("sha256").update(nonce).digest("hex"),
      ...claims,
    },
  });
}

function post(path: string, body: unknown, cookie?: string) {
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function signInWithApple(auth: ReturnType<typeof createIdentityAuth>, body: Record<string, unknown> = {}) {
  return auth.handler(
    post("/native/apple", {
      identityToken: identityToken(),
      nonce: "a-raw-nonce-from-the-app",
      deviceName: "Sam’s iPhone",
      ...body,
    }),
  );
}

function cookieFrom(res: Response) {
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

describe("Sign in with Apple from the iOS app", () => {
  test("a first sign-in creates the account with Apple's name and an iOS session", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    const res = await signInWithApple(auth, { givenName: "Sam", familyName: "Rivera" });
    expect(res.status).toBe(200);

    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookieFrom(res) }) });
    expect(session?.user.email).toBe("sam@privaterelay.appleid.com");
    expect(session?.user.name).toBe("Sam Rivera");
    expect(session?.user.emailVerified).toBe(true);
    expect(session?.session.userAgent).toBe("Botflow for iOS (Sam’s iPhone)");

    // The profile row other features depend on exists, as for any new user.
    const profile = await currentIdentityPool().query("SELECT 1 FROM identity_profile WHERE user_id=$1", [session!.user.id]);
    expect(profile.rows).toHaveLength(1);
  });

  test("signing in again finds the same account", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    const first = await signInWithApple(auth, { givenName: "Sam" });
    const again = await signInWithApple(auth);
    const a = await auth.api.getSession({ headers: new Headers({ cookie: cookieFrom(first) }) });
    const b = await auth.api.getSession({ headers: new Headers({ cookie: cookieFrom(again) }) });
    expect(b?.user.id).toBe(a?.user.id);
    // A later sign-in without a name keeps the one Apple shared the first time.
    expect(b?.user.name).toBe("Sam");
  });

  test("an Apple ID with the same verified email joins the existing account", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    await createUser({ id: "u1", email: "sam@example.test", name: "Sam" });
    const res = await signInWithApple(auth, { identityToken: identityToken({ email: "sam@example.test", is_private_email: false }) });
    expect(res.status).toBe(200);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookieFrom(res) }) });
    expect(session?.user.id).toBe("u1");
  });

  test("the authorization code is exchanged and only the refresh token is kept, encrypted", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    expect((await signInWithApple(auth, { authorizationCode: "c0de" })).status).toBe(200);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toMatchObject({ client_id: BUNDLE_ID, code: "c0de", grant_type: "authorization_code" });
    const { rows } = await currentIdentityPool().query(
      `SELECT "refreshToken" FROM identity_account WHERE "providerId"='apple'`,
    );
    expect(rows[0].refreshToken).toBeTruthy();
    expect(rows[0].refreshToken).not.toContain("apple-refresh");
  });

  test("a token for the wrong nonce is refused", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    const res = await signInWithApple(auth, { nonce: "some-other-nonce-value" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("a token issued to another app is refused", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    const res = await signInWithApple(auth, { identityToken: identityToken({ aud: "com.someone.else" }) });
    expect(res.status).toBe(401);
  });

  test("a token not signed by Apple is refused", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    const forged = signEs256Jwt({
      p8: botflowKey,
      keyId: APPLE_KID,
      payload: JSON.parse(Buffer.from(identityToken().split(".")[1], "base64url").toString()),
    });
    expect((await signInWithApple(auth, { identityToken: forged })).status).toBe(401);
  });

  test("without Apple keys configured the endpoint is unavailable", async () => {
    vi.stubEnv("AUTH_APPLE_PRIVATE_KEY", "");
    const auth = createIdentityAuth(vi.fn(async () => {}));
    expect((await signInWithApple(auth)).status).toBe(404);
  });

  test("deleting the account revokes Botflow's Apple access", async () => {
    const deliver = vi.fn<(to: string, subject: string, body: string) => Promise<void>>(async () => {});
    const auth = createIdentityAuth(deliver);
    const res = await signInWithApple(auth, { authorizationCode: "c0de" });
    const cookie = cookieFrom(res);

    expect((await auth.handler(post("/delete-user", {}, cookie))).status).toBe(200);
    const token = decodeURIComponent(/delete_token=([^ ]+)/.exec(deliver.mock.calls[0][2])![1]);
    expect((await auth.handler(post("/delete-user", { token }, cookie))).status).toBe(200);

    expect(revokeRequests).toHaveLength(1);
    expect(revokeRequests[0]).toMatchObject({ client_id: BUNDLE_ID, token: "apple-refresh", token_type_hint: "refresh_token" });
    const { rows } = await currentIdentityPool().query("SELECT 1 FROM identity_user");
    expect(rows).toHaveLength(0);
  });
});

describe("Sign in with Apple on the website", () => {
  test("the button sends people to Apple with the Services ID and a form_post return", async () => {
    const auth = createIdentityAuth(vi.fn(async () => {}));
    const res = await auth.handler(post("/sign-in/social", { provider: "apple", callbackURL: "/" }));
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.origin + url.pathname).toBe("https://appleid.apple.com/auth/authorize");
    expect(url.searchParams.get("client_id")).toBe(SERVICE_ID);
    expect(url.searchParams.get("response_mode")).toBe("form_post");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/apple`);
  });
});

describe("Apple client secret", () => {
  test("is an ES256 JWT for the given client, valid for under six months", () => {
    const config = appleConfig()!;
    const [header, payload] = appleClientSecret(config, SERVICE_ID)
      .split(".")
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, "base64url").toString()));
    expect(header).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
    expect(payload).toMatchObject({ iss: "TEAM123456", aud: "https://appleid.apple.com", sub: SERVICE_ID });
    expect(payload.exp - payload.iat).toBeLessThan(183 * 24 * 60 * 60);
  });
});
