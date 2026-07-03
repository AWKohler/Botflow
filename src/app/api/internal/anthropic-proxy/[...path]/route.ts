/**
 * Streaming pass-through proxy for Anthropic inference traffic from sandboxed
 * Claude Code turns. Phase 0 spike of
 * docs/features/anthropic-proxy-token-protection-plan.md.
 *
 * The sandbox holds only a short-lived `bfap_…` proxy token (minted per turn,
 * Redis-bound). This route:
 *   auth     — extracts the proxy token from Authorization/x-api-key and
 *              resolves its binding; unknown/revoked token → 401. No Clerk
 *              session involved; the token IS the auth.
 *   authz    — the binding names the user+project+credential mode. Nothing
 *              from the request body influences whose credential is used.
 *   inject   — OAuth: fresh access token via getFreshAnthropicAccessToken
 *              (refreshes server-side mid-turn if needed). BYOK: the user's
 *              stored API key. The real credential never leaves this process.
 *   forward  — transparent streaming passthrough to api.anthropic.com. The
 *              client's anthropic-version/anthropic-beta headers are
 *              forwarded, not hardcoded (plan §5.6); only auth is rewritten.
 *
 * §5.1 (runtime/duration) spike setting: nodejs + maxDuration 300 — the same
 * ceiling as the turn route that already holds turn-length streams. The spike
 * exists to measure whether this holds up or Phase 1+ needs Fluid/dedicated
 * compute; every request logs a `anthropic-proxy` JSON line for that.
 */
import { NextRequest } from "next/server";
import { resolveAnthropicProxyToken } from "@/lib/agent/claude-code/anthropic-proxy-token";
import { getFreshAnthropicAccessToken } from "@/lib/anthropic-oauth";
import { getUserCredentials } from "@/lib/user-credentials";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UPSTREAM = "https://api.anthropic.com";

/** Hop-by-hop / platform headers never forwarded upstream. */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "authorization",
  "x-api-key",
  "cookie",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

/** Response headers dropped so streaming re-encoding stays consistent. */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/** Anthropic-shaped error body so the CLI/SDK surfaces it cleanly. */
function anthropicError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "authentication_error", message } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const started = Date.now();
  const { path } = await params;
  const subpath = (path ?? []).join("/");

  // Only the Anthropic API surface transits — nothing else.
  if (!/^v1(\/|$)/.test(subpath)) {
    return anthropicError(404, "Unknown proxy path");
  }

  // The CLI sends the credentials-file token as a Bearer (OAuth shape) or the
  // env key as x-api-key (BYOK shape) — accept the proxy token from either.
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const candidate = bearer || req.headers.get("x-api-key")?.trim() || "";
  const binding = await resolveAnthropicProxyToken(candidate);
  if (!binding) {
    return anthropicError(401, "Invalid or expired Botflow proxy token");
  }

  // /api/internal/* bypasses the edge limiter (shared sandbox egress IPs) —
  // per-tenant enforcement happens here, keyed by the binding's user, same
  // contract as the tool-callback route. Also §5.4: bounds what a stolen
  // in-turn token can do.
  const blocked = await enforce(identifierFor(binding.userId, req), "anthropicProxy");
  if (blocked) return blocked;

  // Server-side credential resolution — per request, so a long turn keeps
  // working across an OAuth expiry (refresh happens here, not in the box).
  const creds = await getUserCredentials(binding.userId);

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) return;
    if (key.toLowerCase().startsWith("x-vercel-")) return;
    headers.set(key, value);
  });

  if (binding.mode === "oauth") {
    const token = await getFreshAnthropicAccessToken(
      {
        claudeOAuthAccessToken: creds.claudeOAuthAccessToken,
        claudeOAuthRefreshToken: creds.claudeOAuthRefreshToken,
        claudeOAuthExpiresAt: creds.claudeOAuthExpiresAt,
      },
      binding.userId,
    );
    if (!token) {
      return anthropicError(401, "Anthropic OAuth credentials unavailable for this turn");
    }
    headers.set("authorization", `Bearer ${token}`);
  } else {
    if (!creds.anthropicApiKey) {
      return anthropicError(401, "Anthropic API key unavailable for this turn");
    }
    headers.set("x-api-key", creds.anthropicApiKey);
  }

  const url = `${UPSTREAM}/${subpath}${req.nextUrl.search}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      ...(hasBody ? { body: req.body, duplex: "half" as const } : {}),
      redirect: "manual",
    } as RequestInit);
  } catch (err) {
    console.error("[anthropic-proxy] upstream fetch failed:", err);
    return anthropicError(502, "Upstream request failed");
  }

  const respHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    respHeaders.set(key, value);
  });
  const ttfbMs = Date.now() - started;
  respHeaders.set("server-timing", `bf_proxy;dur=${ttfbMs}`);

  // §5.1 measurement line — TTFB here; total function duration comes from
  // the Vercel invocation logs for the same request id.
  console.log(
    JSON.stringify({
      tag: "anthropic-proxy",
      path: subpath,
      method: req.method,
      mode: binding.mode,
      projectId: binding.projectId,
      status: upstream.status,
      ttfbMs,
    }),
  );

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE };
