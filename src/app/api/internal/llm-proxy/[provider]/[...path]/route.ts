/**
 * Universal streaming LLM proxy — every in-sandbox agent's provider traffic
 * transits here (generalization of the Phase-0 anthropic spike; see
 * docs/features/llm-proxy.md).
 *
 * The sandbox holds only a short-lived `bfap_…` token (minted per turn,
 * Redis-bound, sliding TTL). This route:
 *   auth     — token from Authorization / x-api-key / x-goog-api-key →
 *              binding; unknown/revoked → 401. No Clerk session; the token
 *              IS the auth. The binding also names the ONE provider the
 *              token may call.
 *   authz    — binding names user + project + credential mode + model
 *              allowlist. Nothing from the request body influences whose
 *              credential is used.
 *   rewrite  — body parsed once: platform mode enforces the model allowlist
 *              and inserts/clamps the output cap; openai-chat streams get
 *              stream_options.include_usage injected (no usage frame, no
 *              billing).
 *   billing  — platform mode reserves worst-case weekly credits per request
 *              BEFORE forwarding (402 in the provider's error dialect when
 *              exhausted) and settles to metered usage after. Personal modes
 *              record usage with credits=0.
 *   inject   — platform env key / user BYOK key / fresh OAuth access token
 *              (anthropic; refresh happens server-side mid-turn). Real
 *              credentials never leave this process.
 *   forward  — streaming passthrough; the response is tee'd — the client
 *              branch is returned untouched, the meter branch feeds the
 *              usage parser (+ clock heuristic for passively-caching
 *              providers that don't report).
 */
import { NextRequest } from "next/server";
import {
  LLM_PROXY_PROVIDERS,
  isLlmProxyProvider,
  type LlmProxyProvider,
} from "@/lib/agent/llm-proxy/providers";
import {
  resolveLlmProxyToken,
  touchLlmProxyToken,
} from "@/lib/agent/llm-proxy/token";
import {
  rewriteRequestBody,
  createUsageParser,
  meterResponse,
  applyClockHeuristic,
  clockHeuristicKey,
  PLATFORM_MAX_OUTPUT_TOKENS,
} from "@/lib/agent/llm-proxy/usage-meter";
import {
  reserveForRequest,
  createSettlement,
  creditsExhaustedResponse,
  dialectErrorResponse,
} from "@/lib/agent/llm-proxy/billing";
import { getFreshAnthropicAccessToken } from "@/lib/anthropic-oauth";
import { getUserCredentials } from "@/lib/user-credentials";
import { getUserTier } from "@/lib/tier";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Hop-by-hop / platform / credential headers never forwarded upstream. */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-vercel-protection-bypass",
]);

/** Response headers dropped so streaming re-encoding stays consistent
 *  (undici already decompressed the body; the header would lie). */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

const GOOGLE_MODEL_RE = /^(?:v1beta|v1)\/models\/([^/:]+):/;

async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string; path: string[] }> },
) {
  const started = Date.now();
  const { provider: providerParam, path } = await params;

  if (!isLlmProxyProvider(providerParam)) {
    return new Response(JSON.stringify({ error: "Unknown provider" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const provider: LlmProxyProvider = providerParam;
  const spec = LLM_PROXY_PROVIDERS[provider];
  const subpath = (path ?? []).join("/");

  if (!spec.pathAllowlist.test(subpath)) {
    return dialectErrorResponse(provider, 404, "Unknown proxy path", "not_found");
  }

  // Token may arrive under any of the three auth vocabularies depending on
  // which client library the sandbox agent used.
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const candidate =
    bearer ||
    req.headers.get("x-api-key")?.trim() ||
    req.headers.get("x-goog-api-key")?.trim() ||
    "";
  const binding = await resolveLlmProxyToken(candidate);
  if (!binding) {
    return dialectErrorResponse(provider, 401, "Invalid or expired Botflow proxy token", "invalid_api_key");
  }
  if (binding.provider !== provider) {
    return dialectErrorResponse(provider, 401, "Proxy token not valid for this provider", "invalid_api_key");
  }
  touchLlmProxyToken(candidate).catch(() => {});

  // /api/internal/* bypasses the edge limiter (shared sandbox egress IPs) —
  // per-tenant enforcement happens here, keyed by the binding's user. Bounds
  // what a stolen in-turn token can do.
  const blocked = await enforce(identifierFor(binding.userId, req), "llmProxy");
  if (blocked) return blocked;

  const isPlatform = binding.credMode === "platform";
  const dialect = spec.dialectForPath(subpath);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  // ── Body rewrite + billing pre-flight ────────────────────────────────────
  let outboundBody: string | null = null;
  let observedModel: string | null = null;
  let reserved = 0;

  if (hasBody) {
    const raw = await req.text();
    const rewritten = rewriteRequestBody(raw, {
      dialect,
      enforceModelAllowlist: isPlatform ? binding.modelAllowlist : null,
      capOutputTokens: isPlatform ? PLATFORM_MAX_OUTPUT_TOKENS : null,
    });
    if ("rejected" in rewritten) {
      return dialectErrorResponse(provider, 403, rewritten.rejected, "invalid_request_error");
    }
    outboundBody = rewritten.body;
    observedModel = rewritten.model;

    // google carries the model in the URL — extract for allowlist + billing.
    if (dialect === "google") {
      const urlModel = GOOGLE_MODEL_RE.exec(subpath)?.[1] ?? null;
      observedModel = urlModel;
      if (isPlatform && urlModel && !binding.modelAllowlist.includes(urlModel)) {
        return dialectErrorResponse(
          provider, 403, `Model ${urlModel} is not permitted for this turn`, "invalid_request_error",
        );
      }
    } else if (!isPlatform && observedModel && !binding.modelAllowlist.includes(observedModel)) {
      // Advisory only on personal creds — CC runs background models there.
      console.log(JSON.stringify({
        tag: "llm-proxy", event: "model_off_allowlist_advisory",
        provider, credMode: binding.credMode, model: observedModel, turnId: binding.turnId,
      }));
    }

    if (isPlatform) {
      const tier = await getUserTier(binding.userId);
      const reservation = await reserveForRequest(binding, tier, {
        bodyBytes: raw.length,
        effectiveMaxOutput: rewritten.effectiveMaxOutput,
      });
      if (!reservation.ok) {
        return creditsExhaustedResponse(provider);
      }
      reserved = reservation.reserved;
    }
  }

  const settle = createSettlement(binding, reserved);

  // ── Credential injection ──────────────────────────────────────────────────
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) return;
    if (key.toLowerCase().startsWith("x-vercel-")) return;
    headers.set(key, value);
  });
  if (outboundBody !== null) headers.set("content-type", "application/json");

  if (binding.credMode === "oauth") {
    // anthropic-only (the mint path guarantees it); refresh server-side so a
    // long turn survives an OAuth expiry without the sandbox noticing.
    const creds = await getUserCredentials(binding.userId);
    const token = await getFreshAnthropicAccessToken(
      {
        claudeOAuthAccessToken: creds.claudeOAuthAccessToken,
        claudeOAuthRefreshToken: creds.claudeOAuthRefreshToken,
        claudeOAuthExpiresAt: creds.claudeOAuthExpiresAt,
      },
      binding.userId,
    );
    if (!token) {
      await settle(null, observedModel);
      return dialectErrorResponse(provider, 401, "OAuth credentials unavailable for this turn", "invalid_api_key");
    }
    headers.set("authorization", `Bearer ${token}`);
  } else if (binding.credMode === "byok") {
    const creds = await getUserCredentials(binding.userId);
    const key = creds[spec.byokCredField];
    if (!key) {
      await settle(null, observedModel);
      return dialectErrorResponse(provider, 401, "API key unavailable for this turn", "invalid_api_key");
    }
    setUpstreamAuth(headers, spec.authStyle, key);
  } else {
    const key = process.env[spec.platformKeyEnv];
    if (!key) {
      await settle(null, observedModel);
      return dialectErrorResponse(provider, 401, "Platform credentials unavailable", "invalid_api_key");
    }
    setUpstreamAuth(headers, spec.authStyle, key);
    if (spec.extraPlatformHeaders) {
      for (const [k, v] of Object.entries(spec.extraPlatformHeaders({ userId: binding.userId }))) {
        headers.set(k, v);
      }
    }
  }

  // ── Forward ───────────────────────────────────────────────────────────────
  const url = `${spec.upstreamBase}/${subpath}${req.nextUrl.search}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      ...(outboundBody !== null ? { body: outboundBody } : {}),
      redirect: "manual",
    });
  } catch (err) {
    console.error("[llm-proxy] upstream fetch failed:", err);
    await settle(null, observedModel);
    return dialectErrorResponse(provider, 502, "Upstream request failed", "api_error");
  }

  const respHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    respHeaders.set(key, value);
  });
  const ttfbMs = Date.now() - started;
  respHeaders.set("server-timing", `bf_proxy;dur=${ttfbMs}`);

  console.log(JSON.stringify({
    tag: "llm-proxy",
    provider,
    path: subpath,
    method: req.method,
    credMode: binding.credMode,
    projectId: binding.projectId,
    turnId: binding.turnId,
    status: upstream.status,
    reserved,
    ttfbMs,
  }));

  // Error responses carry no usage — release the reservation, pass through.
  if (!upstream.ok || !upstream.body) {
    await settle(null, observedModel);
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  }

  // ── Meter the 2xx stream (client branch returns untouched) ───────────────
  const responseIsStream = (upstream.headers.get("content-type") ?? "")
    .includes("text/event-stream");
  const parser = createUsageParser(dialect, responseIsStream);
  const clientBranch = meterResponse(upstream.body, parser, (usage) => {
    void (async () => {
      let finalUsage = usage;
      if (spec.clockHeuristic) {
        finalUsage = await applyClockHeuristic(
          usage,
          clockHeuristicKey({
            provider,
            credMode: binding.credMode,
            userId: binding.userId,
            projectId: binding.projectId,
          }),
          started,
        );
      }
      if (binding.credMode === "platform" && (!finalUsage.complete || finalUsage.inputTokens === 0)) {
        // Billable stream that ended without a terminal usage frame — settle
        // what we saw, but make it loud: silent undercount is a revenue leak.
        console.log(JSON.stringify({
          tag: "llm-proxy", event: "incomplete_usage", provider,
          projectId: binding.projectId, turnId: binding.turnId, usage: finalUsage,
        }));
      }
      await settle(finalUsage, observedModel);
    })();
  });

  return new Response(clientBranch, { status: upstream.status, headers: respHeaders });
}

function setUpstreamAuth(headers: Headers, style: "bearer" | "x-api-key" | "x-goog-api-key", key: string) {
  if (style === "bearer") headers.set("authorization", `Bearer ${key}`);
  else if (style === "x-api-key") headers.set("x-api-key", key);
  else headers.set("x-goog-api-key", key);
}

export { proxy as GET, proxy as POST };
