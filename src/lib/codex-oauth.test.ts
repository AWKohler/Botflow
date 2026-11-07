/**
 * Codex (ChatGPT-plan) token handling on the OpenCode path.
 *
 * Regression for "UnknownError: Token refresh failed: 401" that survived a
 * sign-out/sign-in: the sandbox got a fresh access token paired with the
 * pre-rotation (dead) refresh token and a stale expiry, and every following
 * turn re-adopted that dead pair from the sandbox over the stored one.
 */
import { http, HttpResponse } from "msw";
import { describe, expect, test, vi } from "vitest";
import { getUserCredentials, setUserCredentials } from "@/lib/user-credentials";
import { createUser } from "@/test/auth";
import { setupTestDb } from "@/test/db";
import { server } from "@/test/network";
import {
  codexNeedsRefresh,
  getFreshCodexCredentials,
  shouldAdoptSandboxCodexAuth,
} from "./codex-oauth";

setupTestDb();

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const EXPIRED = {
  codexOAuthAccessToken: "a1",
  codexOAuthRefreshToken: "r1",
  codexOAuthExpiresAt: NOW - HOUR,
};

describe("shouldAdoptSandboxCodexAuth", () => {
  test("adopts a NEWER pair OpenCode rotated mid-turn", () => {
    expect(
      shouldAdoptSandboxCodexAuth(
        { access: "a2", refresh: "r2", expires: NOW + 10 * 24 * HOUR },
        { refreshToken: "r1", expiresAt: NOW + HOUR },
      ),
    ).toBe(true);
  });

  test("never adopts the older pair left in the sandbox after a refresh or a fresh sign-in", () => {
    // The incident: the sandbox still holds the pre-rotation pair (expired);
    // the stored pair is the new one from the sign-in.
    expect(
      shouldAdoptSandboxCodexAuth(
        { access: "old-access", refresh: "dead-refresh", expires: NOW - HOUR },
        { refreshToken: "fresh-refresh", expiresAt: NOW + 10 * 24 * HOUR },
      ),
    ).toBe(false);
  });

  test("ignores identical, incomplete, or missing sandbox auth", () => {
    const stored = { refreshToken: "r1", expiresAt: NOW + HOUR };
    expect(shouldAdoptSandboxCodexAuth({ access: "a", refresh: "r1", expires: NOW + 9 * HOUR }, stored)).toBe(false);
    expect(shouldAdoptSandboxCodexAuth({ refresh: "r2", expires: NOW + 9 * HOUR }, stored)).toBe(false);
    expect(shouldAdoptSandboxCodexAuth(null, stored)).toBe(false);
  });
});

describe("codexNeedsRefresh", () => {
  test("refreshes within 5 minutes of expiry, not before; unknown expiry never forces it", () => {
    expect(codexNeedsRefresh(NOW + 2 * 60 * 1000, NOW)).toBe(true);
    expect(codexNeedsRefresh(NOW - HOUR, NOW)).toBe(true);
    expect(codexNeedsRefresh(NOW + HOUR, NOW)).toBe(false);
    expect(codexNeedsRefresh(null, NOW)).toBe(false);
  });
});

describe("getFreshCodexCredentials", () => {
  function mockRefresh(status: number, body: object) {
    const called = vi.fn();
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        called(Object.fromEntries(new URLSearchParams(await request.text())));
        return HttpResponse.json(body, { status });
      }),
    );
    return called;
  }

  test("a still-valid sign-in is returned as one complete set (no network)", async () => {
    const out = await getFreshCodexCredentials(
      { codexOAuthAccessToken: "a1", codexOAuthRefreshToken: "r1", codexOAuthExpiresAt: NOW + HOUR },
      "user",
    );
    expect(out).toEqual({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW + HOUR });
  });

  test("a refresh returns the WHOLE rotated set, never the old refresh token or expiry", async () => {
    await createUser({ id: "u1" });
    const called = mockRefresh(200, { access_token: "a2", refresh_token: "r2", expires_in: 864000 });

    const out = await getFreshCodexCredentials(EXPIRED, "u1");

    expect(called).toHaveBeenCalledWith({
      grant_type: "refresh_token",
      refresh_token: "r1",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
    expect(out?.accessToken).toBe("a2");
    expect(out?.refreshToken).toBe("r2");
    // OpenCode refreshes for itself once `expires` passes, so a past value
    // here is what sent it back to OpenAI with a dead token.
    expect(out?.expiresAt).toBeGreaterThan(Date.now());

    const stored = await getUserCredentials("u1");
    expect(stored.codexOAuthRefreshToken).toBe("r2");
    expect(stored.codexOAuthExpiresAt).toBe(out?.expiresAt);
  });

  test("the rotated set survives a failed save, so the turn still works", async () => {
    // No createUser: saving to a missing user fails after the rotation.
    mockRefresh(200, { access_token: "a2", refresh_token: "r2", expires_in: 864000 });
    const out = await getFreshCodexCredentials(EXPIRED, "no-such-user");
    expect(out?.refreshToken).toBe("r2");
  });

  test("a rejected refresh returns null, never the expired token", async () => {
    await createUser({ id: "u2" });
    await setUserCredentials("u2", EXPIRED);
    mockRefresh(401, { error: { code: "refresh_token_expired" } });
    expect(await getFreshCodexCredentials(EXPIRED, "u2")).toBeNull();
  });

  test("losing a refresh race uses the winner's set instead of asking to reconnect", async () => {
    await createUser({ id: "u3" });
    const winnerExpiry = NOW + 10 * 24 * HOUR;
    await setUserCredentials("u3", {
      codexOAuthAccessToken: "winner-access",
      codexOAuthRefreshToken: "winner-refresh",
      codexOAuthExpiresAt: winnerExpiry,
    });
    mockRefresh(401, { error: { code: "refresh_token_reused" } });

    expect(await getFreshCodexCredentials(EXPIRED, "u3")).toEqual({
      accessToken: "winner-access",
      refreshToken: "winner-refresh",
      expiresAt: winnerExpiry,
    });
  });

  test.each([429, 500, 503])("an OpenAI %i keeps the existing set rather than forcing a reconnect", async (status) => {
    mockRefresh(status, { error: "unavailable" });
    expect(await getFreshCodexCredentials(EXPIRED, "user")).toEqual({
      accessToken: "a1",
      refreshToken: "r1",
      expiresAt: EXPIRED.codexOAuthExpiresAt,
    });
  });

  test("a network failure keeps the existing set", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.error()));
    expect((await getFreshCodexCredentials(EXPIRED, "user"))?.refreshToken).toBe("r1");
  });

  test("near expiry with no refresh token asks for a reconnect", async () => {
    expect(
      await getFreshCodexCredentials({ ...EXPIRED, codexOAuthRefreshToken: null }, "user"),
    ).toBeNull();
  });

  test("no sign-in → null", async () => {
    expect(
      await getFreshCodexCredentials(
        { codexOAuthAccessToken: null, codexOAuthRefreshToken: null, codexOAuthExpiresAt: null },
        "user",
      ),
    ).toBeNull();
  });
});
