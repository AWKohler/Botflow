/**
 * Request-rate limiting — sliding-window limiters backed by the shared Upstash
 * Redis client. This is the coarse backbone used by middleware (edge) AND the
 * precise in-handler guards (node); each bucket has its own Redis `prefix`, so
 * the same identity counted in two buckets uses two independent counters.
 *
 * FAIL OPEN is the contract: when UPSTASH_REDIS_REST_URL/_TOKEN are absent the
 * shared `redis` is a no-op stub (no evalsha/eval — the Lua slidingWindow needs
 * them), so we detect missing env once via isRateLimitConfigured() and skip
 * limiting entirely. Any thrown Redis/network error from .limit() is also
 * caught and treated as allow. Requests are NEVER blocked by a missing/broken
 * Redis. (timeout:3000ms on each Ratelimit is a third fail-open layer — Upstash
 * resolves success on timeout.)
 *
 * NB: limiters are module-scope singletons on purpose — that's the only way the
 * shared `ephemeralCache` (in-process exhaustion cache) and the warm Lua-script
 * cache survive across requests. Do NOT construct a Ratelimit per-request.
 */

import { Ratelimit, type Duration } from '@upstash/ratelimit';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { redis } from './redis';

// ─── Buckets ──────────────────────────────────────────────────────────────────

export type RateLimitBucket =
  | 'read' | 'write' | 'upload' | 'expensive' | 'deploy'
  | 'poll' | 'pollHeavy'
  | 'oauthStart' | 'oauthExchange' | 'oauthPoll'
  | 'agent' | 'claudeCode' | 'opencode' | 'toolCallback'
  | 'public' | 'publicHeavy' | 'webhook' | 'global';

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number; // epoch ms
  bucket: RateLimitBucket;
  identifier: string;
  /** false when fail-open (redis not configured / disabled / error) */
  enforced: boolean;
}

// ─── Env-var helpers ──────────────────────────────────────────────────────────
// Mirrors tier.ts's envInt pattern: token counts are env-overridable so limits
// can be tuned without a deploy; the window is fixed in code (kept simple).

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

/**
 * Resolved config table — `tokens` per `window` for every bucket. Exported for
 * tests/observability. Defaults derived from the route audit's recommendedLimits.
 */
export const RATE_LIMIT_BUCKETS: Record<RateLimitBucket, { tokens: number; window: Duration }> = {
  read:          { tokens: envInt('RL_READ', 120),          window: '60 s' }, // GET/poll-style reads, status polls
  write:         { tokens: envInt('RL_WRITE', 60),          window: '60 s' }, // generic mutation writes
  upload:        { tokens: envInt('RL_UPLOAD', 20),          window: '60 s' }, // UploadThing-backed (images, snapshot)
  expensive:     { tokens: envInt('RL_EXPENSIVE', 15),       window: '60 s' }, // sandbox exec/search/session, domain provisioning
  // Workspace background polling — isolated from read/write so a wall of open
  // workspace tabs can never starve interactive traffic. Budget derivation:
  // one visible ready workspace polls preview-state (2s=30/min) + env request
  // (2.5s=24/min) + convex oauth status (2.5s=24/min) + stripe connect
  // (2.5s=24/min) ≈ ~105/min; sized for ~8 simultaneously VISIBLE workspaces
  // plus jitter (hidden tabs pause — see use-workspace-poll.ts).
  poll:          { tokens: envInt('RL_POLL', 1200),          window: '60 s' }, // lightweight Redis/DB state polls
  // File-tree signature runs find|cksum INSIDE the sandbox (3s=20/min per
  // workspace) and file-content GETs cat from sandbox disk — heavier, tighter.
  pollHeavy:     { tokens: envInt('RL_POLL_HEAVY', 240),     window: '60 s' }, // sandbox-executing polls (files signature/content)
  deploy:        { tokens: envInt('RL_DEPLOY', 5),           window: '60 s' }, // strictest: publish, convex/deploy, swift build
  oauthStart:    { tokens: envInt('RL_OAUTH_START', 10),     window: '60 s' }, // oauth */start, stripe oauth start
  oauthExchange: { tokens: envInt('RL_OAUTH_EXCHANGE', 5),   window: '60 s' }, // oauth */callback + exchange (token/code grinding)
  oauthPoll:     { tokens: envInt('RL_OAUTH_POLL', 45),      window: '60 s' }, // codex/poll client loop (~1/2s = 30/min); headroom for jitter/retry/clock-drift
  agent:         { tokens: envInt('RL_AGENT', 12),           window: '60 s' }, // /api/agent LLM turn
  claudeCode:    { tokens: envInt('RL_CLAUDE_CODE', 10),     window: '60 s' }, // /api/agent/claude-code subprocess+sandbox
  opencode:      { tokens: envInt('RL_OPENCODE', 10),        window: '60 s' }, // /api/agent/opencode subprocess+sandbox
  toolCallback:  { tokens: envInt('RL_TOOL_CALLBACK', 90),   window: '60 s' }, // /api/internal/claude-code-tool (fans out per turn)
  public:        { tokens: envInt('RL_PUBLIC', 30),          window: '60 s' }, // unauth IP-keyed gallery/detail, og
  publicHeavy:   { tokens: envInt('RL_PUBLIC_HEAVY', 10),    window: '60 s' }, // public source-bundle download (gunzip+tar)
  webhook:       { tokens: envInt('RL_WEBHOOK', 100),        window: '60 s' }, // coarse IP backstop (default middleware SKIPS webhooks)
  global:        { tokens: envInt('RL_GLOBAL', 100),         window: '60 s' }, // catch-all fallback ceiling
};

// ─── Config detection (single source of truth for fail-open) ───────────────────

/**
 * Whether rate limiting is active. Mirrors redis.ts's env check exactly — when
 * either var is missing the shared `redis` is the no-op stub, so we must NOT
 * touch it (slidingWindow's evalsha would blow up on the stub).
 */
export function isRateLimitConfigured(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

// ─── Limiter registry (module-scope singletons) ────────────────────────────────

// Shared in-process exhaustion cache. Passed to EVERY limiter so a known-blocked
// identifier is rejected without a Redis round-trip. Only effective because the
// limiters below live at module scope.
const ephemeralCache = new Map<string, number>();

// Lazily-built singletons, one per bucket. Never constructed when
// isRateLimitConfigured() is false, so the noop redis's missing evalsha is
// never reached.
const limiters = new Map<RateLimitBucket, Ratelimit>();

function buildLimiter(bucket: RateLimitBucket): Ratelimit {
  const { tokens, window } = RATE_LIMIT_BUCKETS[bucket];
  return new Ratelimit({
    redis, // the real singleton — only used when isRateLimitConfigured()
    limiter: Ratelimit.slidingWindow(tokens, window),
    prefix: `rl:${bucket}`,
    ephemeralCache,
    analytics: false, // OFF → no `pending` promise to flush (no waitUntil needed)
    timeout: 3000, // extra fail-open: Upstash resolves success on slow Redis
  });
}

function getLimiter(bucket: RateLimitBucket): Ratelimit {
  let limiter = limiters.get(bucket);
  if (!limiter) {
    limiter = buildLimiter(bucket);
    limiters.set(bucket, limiter);
  }
  return limiter;
}

// ─── Identity helpers ───────────────────────────────────────────────────────────

/**
 * Best-effort client IP. Next 15 removed `req.ip`, so we parse headers directly.
 *
 * Trust order matters for IP-keyed limits on unauthenticated routes: a client
 * can put ANY value in `x-forwarded-for`, so taking its first token (as we used
 * to) lets an attacker rotate a spoofed IP every request and evade the cap.
 * Prefer headers the platform sets from the real TCP peer and overwrites on the
 * way in — `x-vercel-forwarded-for` and `x-real-ip` on Vercel, `cf-connecting-ip`
 * behind Cloudflare — and only fall back to raw XFF when none are present.
 */
export function getClientIp(req: Request | NextRequest): string {
  const trusted =
    req.headers.get('x-vercel-forwarded-for') ||
    req.headers.get('x-real-ip') ||
    req.headers.get('cf-connecting-ip');
  if (trusted) {
    const first = trusted.split(',')[0]?.trim();
    if (first) return first;
  }
  // Last resort only — spoofable. Used in local/dev or non-Vercel edges that
  // don't set the trusted headers above.
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return '0.0.0.0';
}

/**
 * The shared identity string. Authed users key by `user:<id>`; everyone else by
 * `ip:<client-ip>`. Used by both middleware and handlers so the SAME identity is
 * shared across buckets (each Ratelimit's distinct `prefix` keeps buckets from
 * colliding).
 */
export function identifierFor(userId: string | null | undefined, req: Request | NextRequest): string {
  return userId ? `user:${userId}` : `ip:${getClientIp(req)}`;
}

// ─── Core check ───────────────────────────────────────────────────────────────

/**
 * Check (and consume one token of) the given bucket for `identifier`. FAIL OPEN:
 * returns success:true/enforced:false when Redis is unconfigured, disabled, or
 * errors — never throws, never blocks on infrastructure problems.
 */
export async function checkRateLimit(
  identifier: string,
  bucket: RateLimitBucket,
): Promise<RateLimitResult> {
  // Emergency kill-switch: disable enforcement without a redeploy.
  if (process.env.RL_DISABLED === '1' || !isRateLimitConfigured()) {
    return { success: true, limit: 0, remaining: 0, reset: 0, bucket, identifier, enforced: false };
  }

  try {
    const r = await getLimiter(bucket).limit(identifier);
    return {
      success: r.success,
      limit: r.limit,
      remaining: r.remaining,
      reset: r.reset,
      bucket,
      identifier,
      enforced: true,
    };
  } catch (e) {
    // FAIL OPEN on any Redis/network error. analytics is off, so there is no
    // pending promise to await here.
    console.warn('[rate-limit] limit() failed, allowing request', e);
    return { success: true, limit: 0, remaining: 0, reset: 0, bucket, identifier, enforced: false };
  }
}

// ─── 429 response ───────────────────────────────────────────────────────────────

/**
 * Build the standard 429. Body uses the repo's `{ error: ... }` convention but
 * with a distinct `error: 'rate_limited'` (vs limitReachedResponse's 402
 * `'limit_reached'` plan body). Sets Retry-After + X-RateLimit-* headers.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: 'rate_limited',
      message: 'Too many requests. Please slow down and retry shortly.',
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      retryAfter,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(Math.max(0, result.remaining)),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)), // epoch seconds (standard)
      },
    },
  );
}

// ─── Convenience enforcer ───────────────────────────────────────────────────────

/**
 * Check a bucket and return a ready-to-return 429 when over the limit, else null.
 *
 * In-handler:   const blocked = await enforce(identifierFor(userId, req), 'agent');
 *               if (blocked) return blocked;
 * Middleware:   same — the returned 429 short-circuits before auth.protect().
 */
export async function enforce(
  identifier: string,
  bucket: RateLimitBucket,
): Promise<NextResponse | null> {
  const r = await checkRateLimit(identifier, bucket);
  return r.success ? null : rateLimitResponse(r);
}
