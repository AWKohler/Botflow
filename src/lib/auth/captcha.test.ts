import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { currentIdentityPool, setupTestDb } from "@/test/db";
import { server } from "@/test/network";
import { CAPTCHA_ENDPOINTS } from "./captcha";
import { createIdentityAuth } from "./config";

setupTestDb();

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ORIGIN = "https://botflow.test";

function post(path: string, body: unknown, token?: string) {
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(token ? { "x-captcha-response": token } : {}),
    },
    body: JSON.stringify(body),
  });
}

const SIGN_UP = {
  email: "victim@example.com",
  password: "a-long-test-passphrase",
  name: "KMadINUpOFWRikcg",
};

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
});
afterEach(() => vi.unstubAllEnvs());

describe("with a Turnstile secret configured", () => {
  beforeEach(() => vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret"));

  test.each(CAPTCHA_ENDPOINTS)("%s rejects a request with no token", async (path) => {
    const deliver = vi.fn(async () => {});
    const response = await createIdentityAuth(deliver).handler(
      post(path, { ...SIGN_UP, type: "sign-in" }),
    );
    expect(response.status).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("a trailing slash does not get around the check", async () => {
    const response = await createIdentityAuth(vi.fn(async () => {})).handler(
      post("/sign-up/email/", SIGN_UP),
    );
    expect(response.status).toBe(400);
  });

  test("a token Turnstile rejects creates no account and sends no email", async () => {
    server.use(
      http.post(SITEVERIFY, () =>
        HttpResponse.json({ success: false, "error-codes": ["invalid-input-response"] }),
      ),
    );
    const deliver = vi.fn(async () => {});
    const auth = createIdentityAuth(deliver);
    const response = await auth.handler(post("/sign-up/email", SIGN_UP, "forged"));
    expect(response.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
    const { rows } = await currentIdentityPool().query(
      "SELECT 1 FROM identity_user WHERE email=$1",
      [SIGN_UP.email],
    );
    expect(rows).toHaveLength(0);
  });

  test("fails closed when Turnstile is unreachable", async () => {
    server.use(http.post(SITEVERIFY, () => HttpResponse.error()));
    const deliver = vi.fn(async () => {});
    const response = await createIdentityAuth(deliver).handler(
      post("/sign-up/email", SIGN_UP, "any"),
    );
    expect(response.status).toBe(500);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("a valid token reaches sign-up and sends the verification code", async () => {
    let verified: Record<string, unknown> | undefined;
    server.use(
      http.post(SITEVERIFY, async ({ request }) => {
        verified = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ success: true });
      }),
    );
    const deliver = vi.fn(async () => {});
    const response = await createIdentityAuth(deliver).handler(
      post("/sign-up/email", SIGN_UP, "good-token"),
    );
    expect(response.status).toBe(200);
    expect(verified).toMatchObject({ secret: "test-secret", response: "good-token" });
    await vi.waitFor(() =>
      expect(deliver).toHaveBeenCalledWith(
        SIGN_UP.email,
        "Your Botflow verification code",
        expect.any(String),
      ),
    );
  });

  test("password sign-in needs no token", async () => {
    const response = await createIdentityAuth(vi.fn(async () => {})).handler(
      post("/sign-in/email", { email: SIGN_UP.email, password: "wrong-password" }),
    );
    // Reaches the credential check (no such user) rather than the CAPTCHA gate.
    expect(response.status).toBe(401);
  });
});

// The plugin matches exact paths, so a typo here would silently leave a route open.
test.each(CAPTCHA_ENDPOINTS)("%s is a real auth route", async (path) => {
  vi.stubEnv("TURNSTILE_SECRET_KEY", "");
  const response = await createIdentityAuth(vi.fn(async () => {})).handler(
    post(path, { ...SIGN_UP, type: "sign-in" }),
  );
  expect(response.status).not.toBe(404);
});

test("without a secret the check is off, so dev and previews keep working", async () => {
  vi.stubEnv("TURNSTILE_SECRET_KEY", "");
  const deliver = vi.fn(async () => {});
  const response = await createIdentityAuth(deliver).handler(post("/sign-up/email", SIGN_UP));
  expect(response.status).toBe(200);
});
