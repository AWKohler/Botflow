/**
 * Credit system — every model's token usage is converted to "MiniMax-equivalent" credits.
 * 1 credit = 1 uncached MiniMax input token equivalent ($0.30 / MTok base).
 *
 * Credits are calculated per token type (input, cached input, output, cache write)
 * using each model's actual pricing divided by the MiniMax base price.
 *
 * Monthly budgets are split into weekly slices (÷ 4) stored in Redis with an 8-day TTL.
 * Monthly totals are summed from usage_records.credits in Neon.
 */

import { redis } from './redis';
import { getDb } from '@/db';
import { usageRecords } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import type { ModelId } from './agent/models';
import type { Tier } from './tier';

// ─── Env-var helpers ──────────────────────────────────────────────────────────

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

// ─── Per-token-type credit rates (credits per token) ──────────────────────────
// Base unit: $0.30 / MTok (MiniMax uncached input price)
// Rate = model_price_per_MTok / 0.30

interface ModelPricing {
  input: number;         // credits per uncached input token
  cachedInput: number;   // credits per cached input token
  output: number;        // credits per output token
  cacheWrite?: number;   // credits per cache-write token (Anthropic only)
}

const BASE_PRICE = 0.30; // MiniMax input $/MTok — our credit base unit

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'fireworks-minimax-m3': {
    input:       0.30 / BASE_PRICE,   // 1.0
    cachedInput: 0.06 / BASE_PRICE,   // 0.2
    output:      1.20 / BASE_PRICE,   // 4.0
  },
  'fireworks-kimi-k2p7': {
    input:       0.95 / BASE_PRICE,   // 3.17
    cachedInput: 0.19 / BASE_PRICE,   // 0.63
    output:      4.00 / BASE_PRICE,   // 13.33
  },
  'gpt-5.5': {
    input:       5.00 / BASE_PRICE,   // 16.67
    cachedInput: 0.50 / BASE_PRICE,   // 1.67
    output:      30.00 / BASE_PRICE,  // 100.0
  },
  // GPT-5.6 family. Flat pricing (no context-length tier). Unlike earlier
  // OpenAI models, 5.6 bills cache WRITES at 1.25× uncached input — modeled via
  // cacheWrite below. (Only charged when the meter reports cacheWriteTokens; see
  // usage-meter — the OpenAI dialect must extract 5.6's cache-write count for it
  // to take effect, otherwise writes fall back to plain input like the old models.)
  'gpt-5.6-sol': {                    // flagship — same rates as GPT-5.5
    input:       5.00 / BASE_PRICE,   // 16.67
    cachedInput: 0.50 / BASE_PRICE,   // 1.67
    output:      30.00 / BASE_PRICE,  // 100.0
    cacheWrite:  6.25 / BASE_PRICE,   // 20.83 (1.25× input)
  },
  'gpt-5.6-terra': {                  // balanced — succeeds GPT-5.4
    input:       2.50 / BASE_PRICE,   // 8.33
    cachedInput: 0.25 / BASE_PRICE,   // 0.83
    output:      15.00 / BASE_PRICE,  // 50.0
    cacheWrite:  3.125 / BASE_PRICE,  // 10.42 (1.25× input)
  },
  'gpt-5.6-luna': {                   // fast/cheap — succeeds GPT-5.3
    input:       1.00 / BASE_PRICE,   // 3.33
    cachedInput: 0.10 / BASE_PRICE,   // 0.33
    output:      6.00 / BASE_PRICE,   // 20.0
    cacheWrite:  1.25 / BASE_PRICE,   // 4.17 (1.25× input)
  },
  // Claude Sonnet 5 — standard (regular) pricing, effective 2026-09-01 onward.
  // Identical to the prior Sonnet 4.6 rates ($3 / $15 per MTok). Until then the
  // introductory pricing below applies; the date switch lives in calculateCredits().
  'claude-sonnet-5': {
    input:       3.00 / BASE_PRICE,   // 10.0
    cachedInput: 0.30 / BASE_PRICE,   // 1.0  (cache hit/refresh)
    output:      15.00 / BASE_PRICE,  // 50.0
    cacheWrite:  3.75 / BASE_PRICE,   // 12.5 (5-min ephemeral cache write)
  },
  'claude-opus-4-8': {
    input:       5.00 / BASE_PRICE,   // 16.67
    cachedInput: 0.50 / BASE_PRICE,   // 1.67 (cache hit/refresh)
    output:      25.00 / BASE_PRICE,  // 83.33
    cacheWrite:  6.25 / BASE_PRICE,   // 20.83 (5-min ephemeral cache write)
  },
  // Claude Fable 5 ("Mythos") — exactly 2× Opus 4.8 on every axis. Zero-markup
  // pass-through, same as every other model: rate = $/MTok ÷ 0.30.
  'claude-fable-5': {
    input:      10.00 / BASE_PRICE,   // 33.33
    cachedInput: 1.00 / BASE_PRICE,   //  3.33 (cache hit/refresh)
    output:     50.00 / BASE_PRICE,   // 166.67
    cacheWrite: 12.50 / BASE_PRICE,   // 41.67 (5-min ephemeral cache write)
  },
  // Gemini 3.1 Pro pricing at ≤200K context — the >200K tier handled in calculateCredits()
  'gemini-3.1-pro-preview': {
    input:       2.00 / BASE_PRICE,   // 6.67
    cachedInput: 0.20 / BASE_PRICE,   // 0.67
    output:     12.00 / BASE_PRICE,   // 40.0
    cacheWrite:  2.00 / BASE_PRICE,   // 6.67 — cache write billed at full input price
  },
  // xAI Grok 4.5. Pricing verified live against the API's cost_in_usd_ticks
  // (1 tick = 1e-10 USD): $2 uncached / $0.50 cached / $6 output per MTok.
  // Cache is passive/read-only (openai-chat cached_tokens, a subset of
  // prompt_tokens) — no cache-write billing, so no cacheWrite field. Note the
  // discount is only 75% ($2→$0.50), less than the 90% on most other models.
  'grok-4.5': {
    input:       2.00 / BASE_PRICE,   // 6.67
    cachedInput: 0.50 / BASE_PRICE,   // 1.67
    output:      6.00 / BASE_PRICE,   // 20.0
  },
};

// Gemini 3.1 Pro pricing at >200K context length
const GEMINI_LONG_CONTEXT_PRICING: ModelPricing = {
  input:       4.00 / BASE_PRICE,   // 13.33
  cachedInput: 0.40 / BASE_PRICE,   // 1.33
  output:     18.00 / BASE_PRICE,   // 60.0
  cacheWrite:  4.00 / BASE_PRICE,   // 13.33
};

const GEMINI_LONG_CONTEXT_THRESHOLD = 200_000;

// Grok 4.5 pricing above its long_context_threshold (200K) — EVERY axis
// doubles, per xAI's own model metadata (prompt_text_token_price_long_context
// 40000 = $4/MTok, cached 10000 = $1, completion 120000 = $12; all 2× the
// ≤200K rates). Verified live against GET api.x.ai/v1/models/grok-4.5.
const GROK_LONG_CONTEXT_PRICING: ModelPricing = {
  input:       4.00 / BASE_PRICE,   // 13.33
  cachedInput: 1.00 / BASE_PRICE,   // 3.33
  output:     12.00 / BASE_PRICE,   // 40.0
};

const GROK_LONG_CONTEXT_THRESHOLD = 200_000;

// Claude Sonnet 5 introductory pricing — $2 input / $10 output per MTok, a
// temporary discount from the standard $3 / $15 rates in MODEL_PRICING above.
// Anthropic applies it through 2026-08-31; standard pricing resumes 2026-09-01.
// Cache write (5-min) and cache read follow the usual 1.25× / 0.1× of input.
const SONNET5_INTRO_PRICING: ModelPricing = {
  input:       2.00 / BASE_PRICE,   // 6.67
  cachedInput: 0.20 / BASE_PRICE,   // 0.67 (cache hit/refresh)
  output:     10.00 / BASE_PRICE,   // 33.33
  cacheWrite:  2.50 / BASE_PRICE,   // 8.33 (5-min ephemeral cache write)
};

// First instant standard pricing applies (UTC). Before this, Sonnet 5 uses the
// introductory rates above; on/after it, the standard rates in MODEL_PRICING.
const SONNET5_INTRO_END = Date.UTC(2026, 8, 1); // 2026-09-01T00:00:00Z (month is 0-indexed)

/**
 * Rounded per-model cost multiplier for frontend display.
 * Shown in model selector dropdown to give users a sense of relative cost.
 *
 * Kimi K2.7 is x3 ($0.95 input → 3.17 ≈ 3) on both Fireworks and Together AI —
 * Together homologated its pricing to match Fireworks, so the provider no longer
 * affects the cost.
 */
export const MODEL_COST_MULTIPLIER: Record<ModelId, number> = {
  'fireworks-minimax-m3': 1,
  'fireworks-kimi-k2p7': 3,
  'gpt-5.6-luna': 3,
  'grok-4.5': 4,
  'gemini-3.1-pro-preview': 5,
  'claude-sonnet-5': 5,
  'gpt-5.6-terra': 6,
  'claude-opus-4-8': 10,
  'gpt-5.6-sol': 12,
  'gpt-5.5': 12,
  'claude-fable-5': 20,
};

export interface CreditCalculationInput {
  model: ModelId;
  inputTokens: number;      // uncached input tokens (Anthropic: usage.inputTokens; OpenAI/FW: inputTokens - cachedRead)
  outputTokens: number;
  cachedReadTokens: number;  // tokens served from cache
  cacheWriteTokens: number;  // tokens written to cache (Anthropic only)
}

/**
 * Calculate credits for a completed request using per-token-type pricing.
 * This replaces the old flat-multiplier rawToCredits() function.
 */
export function calculateCredits(params: CreditCalculationInput): number {
  const { model, inputTokens, outputTokens, cachedReadTokens, cacheWriteTokens } = params;

  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    // Fallback: treat as MiniMax pricing
    pricing = MODEL_PRICING['fireworks-minimax-m3'];
  }

  // Gemini 3.1 Pro: use higher pricing tier if total input context exceeds 200K
  if (model === 'gemini-3.1-pro-preview' && (inputTokens + cachedReadTokens) > GEMINI_LONG_CONTEXT_THRESHOLD) {
    pricing = GEMINI_LONG_CONTEXT_PRICING;
  }

  // Grok 4.5: every rate doubles above 200K total context (xAI long-context tier).
  if (model === 'grok-4.5' && (inputTokens + cachedReadTokens) > GROK_LONG_CONTEXT_THRESHOLD) {
    pricing = GROK_LONG_CONTEXT_PRICING;
  }

  // Claude Sonnet 5: introductory pricing applies through 2026-08-31 (UTC);
  // standard rates (already in MODEL_PRICING) take over from 2026-09-01.
  if (model === 'claude-sonnet-5' && Date.now() < SONNET5_INTRO_END) {
    pricing = SONNET5_INTRO_PRICING;
  }

  const inputCredits = inputTokens * pricing.input;
  const cachedCredits = cachedReadTokens * pricing.cachedInput;
  const outputCredits = outputTokens * pricing.output;
  const cacheWriteCredits = cacheWriteTokens * (pricing.cacheWrite ?? pricing.input);

  return Math.ceil(inputCredits + cachedCredits + outputCredits + cacheWriteCredits);
}

// ─── Legacy helper (kept for any remaining callers) ──────────────────────────

/** @deprecated Use calculateCredits() instead */
export function rawToCredits(tokens: number, model: ModelId): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING['fireworks-minimax-m3'];
  // Approximate: treat all tokens as uncached input (overestimates — prefer calculateCredits)
  return Math.ceil(tokens * pricing.input);
}

// ─── Monthly limits by tier ───────────────────────────────────────────────────

export function getMonthlyLimit(tier: Tier): number {
  switch (tier) {
    case 'free': return envInt('CREDITS_FREE_MONTHLY', 2_000_000);
    case 'pro':  return envInt('CREDITS_PRO_MONTHLY', 40_000_000);
    case 'max':  return envInt('CREDITS_MAX_MONTHLY', 200_000_000);
  }
}

export function getWeeklyLimit(tier: Tier): number {
  return Math.floor(getMonthlyLimit(tier) / 4);
}

// ─── ISO week key (e.g. "2026-W10") ─────────────────────────────────────────

export function currentWeekKey(): string {
  const now = new Date();
  // ISO week: week containing Thursday of that week
  const thursday = new Date(now);
  thursday.setUTCDate(now.getUTCDate() + (4 - (now.getUTCDay() || 7)));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function weeklyRedisKey(userId: string): string {
  return `wcred:${userId}:${currentWeekKey()}`;
}

const WEEK_TTL = 8 * 24 * 3600; // 8 days

// ─── Redis: weekly credits ────────────────────────────────────────────────────

export async function getWeeklyCredits(userId: string): Promise<number> {
  const val = await redis.get<number>(weeklyRedisKey(userId));
  return val ?? 0;
}

export async function incrementWeeklyCredits(userId: string, credits: number): Promise<void> {
  const key = weeklyRedisKey(userId);
  const newVal = await redis.incrby(key, credits);
  if (newVal <= credits) {
    // First write this week — set TTL
    await redis.expire(key, WEEK_TTL);
  }
}

/**
 * Atomically reserve `amount` credits against the user's weekly budget.
 *
 * The INCRBY + limit comparison is a single atomic step, so concurrent requests
 * can no longer all clear the same pre-spend balance (closes the check-then-spend
 * TOCTOU race). If the reservation would exceed `limit` it is rolled back and
 * `false` is returned. On success the caller MUST later reconcile the difference
 * between this reservation and the real cost via `adjustWeeklyCredits` (typically
 * in the stream's onFinish), and release it via `adjustWeeklyCredits(-amount)` if
 * the request aborts before completing.
 *
 * Reservations are bounded by the existing WEEK_TTL, so a reservation that is
 * never reconciled (e.g. process death mid-stream) self-expires rather than
 * permanently inflating the counter.
 *
 * @deprecated Platform-billed flows should use reservePlatformCredits, which
 * gates on the monthly ceiling with weekly-boundary spillover and maintains
 * both KV counters together.
 */
export async function reserveWeeklyCredits(
  userId: string,
  amount: number,
  limit: number,
): Promise<boolean> {
  const key = weeklyRedisKey(userId);
  if (amount <= 0) {
    // Nothing to reserve — still enforce the limit against current usage.
    const current = await getWeeklyCredits(userId);
    return current < limit;
  }
  const total = await redis.incrby(key, amount);
  if (total === amount) {
    // First write this week — set TTL.
    await redis.expire(key, WEEK_TTL);
  }
  if (total > limit) {
    // Over budget — roll back our reservation and reject.
    await redis.incrby(key, -amount).catch(() => {});
    return false;
  }
  return true;
}

/**
 * Adjust the weekly credit counter by `delta` (may be negative). Used to
 * reconcile a prior `reserveWeeklyCredits` down (or up) to the real cost, and to
 * release a reservation on abort. Unlike `incrementWeeklyCredits` it does not
 * touch the TTL, since the key already exists from the reservation.
 *
 * @deprecated Platform-billed flows should use reservePlatformCredits /
 * adjustPlatformCredits, which maintain the weekly AND monthly KV counters
 * together. Kept only so a straggling caller fails loudly in review, not
 * silently at runtime.
 */
export async function adjustWeeklyCredits(userId: string, delta: number): Promise<void> {
  if (delta === 0) return;
  await redis.incrby(weeklyRedisKey(userId), delta);
}

// ─── Redis: monthly credits (KV enforcement copy) ─────────────────────────────
// Hot-path checks (turn pre-flight, per-request reservations) must NEVER hit
// Neon. The monthly counter lives in Redis, lazily seeded from the Neon SUM
// once per period (SET NX), then maintained by the same reserve/adjust flow as
// the weekly counter. Neon stays the AUDIT source of truth (usage_records rows
// written at settlement; /api/usage display reads) — this key is the
// enforcement copy. Drift exposure: a crashed process's unreconciled
// reservation inflates the counter until the month rolls over — the same class
// of exposure the weekly key already accepts, with a longer window.

const MONTH_TTL = 35 * 24 * 3600; // any month length + reconcile slack

function monthlyRedisKey(userId: string): string {
  return `mcred:${userId}:${currentPeriod()}`;
}

/** Seed the month's KV counter from Neon exactly once per period. Every
 *  writer calls this BEFORE its INCRBY so the key is always created by the
 *  SET NX (never by a bare INCRBY racing the seed to zero). */
async function ensureMonthlySeeded(userId: string): Promise<void> {
  const key = monthlyRedisKey(userId);
  if (await redis.exists(key)) return;
  const seed = await getMonthlyCredits(userId); // Neon SUM — once per period per user
  await redis.set(key, seed, { nx: true, ex: MONTH_TTL });
}

/** Monthly usage from the KV enforcement counter (seeds from Neon if this is
 *  the period's first read). Use THIS in hot paths, never getMonthlyCredits. */
export async function getMonthlyCreditsKV(userId: string): Promise<number> {
  await ensureMonthlySeeded(userId);
  const val = await redis.get<number>(monthlyRedisKey(userId));
  return val ?? 0;
}

export type PlatformReserveResult =
  | { ok: true }
  | { ok: false; reason: 'weekly_exhausted' | 'monthly_exceeded' };

/**
 * Atomically reserve `amount` credits for a platform-billed request.
 *
 * The paradigm — weekly pacing with monthly spillover:
 *  - The WEEKLY budget paces usage. Once a user's week is exhausted
 *    (weeklyUsed ≥ weeklyLimit BEFORE this request), requests are blocked
 *    until the weekly reset.
 *  - A single request that STRADDLES the weekly boundary — the user still has
 *    weekly headroom, but the worst-case reservation overshoots it — is
 *    ALLOWED. The overshoot spills into the monthly budget.
 *  - The MONTHLY budget is the hard ceiling: a reservation that does not fit
 *    the remaining monthly headroom is rejected outright. In the last week of
 *    a month the two budgets converge, so spillover naturally shrinks to
 *    zero — no calendar special-casing needed.
 *
 * Same INCRBY + rollback atomicity as reserveWeeklyCredits (closes the
 * check-then-spend TOCTOU race). On success the caller MUST reconcile to the
 * real cost via adjustPlatformCredits (onFinish), and release with
 * adjustPlatformCredits(-amount) on abort.
 */
export async function reservePlatformCredits(
  userId: string,
  amount: number,
  weeklyLimit: number,
  monthlyLimit: number,
): Promise<PlatformReserveResult> {
  await ensureMonthlySeeded(userId);
  const wKey = weeklyRedisKey(userId);
  const mKey = monthlyRedisKey(userId);

  if (amount <= 0) {
    // Nothing to reserve — still enforce both limits against current usage.
    const [w, m] = await Promise.all([getWeeklyCredits(userId), redis.get<number>(mKey)]);
    if ((m ?? 0) >= monthlyLimit) return { ok: false, reason: 'monthly_exceeded' };
    if (w >= weeklyLimit) return { ok: false, reason: 'weekly_exhausted' };
    return { ok: true };
  }

  // Monthly first — the hard ceiling.
  const mTotal = await redis.incrby(mKey, amount);
  if (mTotal > monthlyLimit) {
    await redis.incrby(mKey, -amount).catch(() => {});
    return { ok: false, reason: 'monthly_exceeded' };
  }

  const wTotal = await redis.incrby(wKey, amount);
  if (wTotal === amount) {
    // First write this week — set TTL.
    await redis.expire(wKey, WEEK_TTL);
  }
  // Spillover rule: reject only when the week was ALREADY exhausted before
  // this request (pre-reservation usage ≥ limit). A request that STARTS under
  // the weekly line may finish over it — that overshoot was covered by the
  // monthly check above.
  if (wTotal - amount >= weeklyLimit) {
    await Promise.all([
      redis.incrby(wKey, -amount).catch(() => {}),
      redis.incrby(mKey, -amount).catch(() => {}),
    ]);
    return { ok: false, reason: 'weekly_exhausted' };
  }
  return { ok: true };
}

/**
 * Adjust BOTH platform counters by `delta` (may be negative): reconcile a
 * reservation to the real cost, or release it on abort/failure. The monthly
 * key is re-seeded first if missing (eviction guard) so a bare INCRBY can
 * never mint a fresh counter from zero.
 */
export async function adjustPlatformCredits(userId: string, delta: number): Promise<void> {
  if (delta === 0) return;
  await ensureMonthlySeeded(userId);
  await Promise.all([
    redis.incrby(weeklyRedisKey(userId), delta),
    redis.incrby(monthlyRedisKey(userId), delta),
  ]);
}

// ─── Neon: monthly credits ────────────────────────────────────────────────────

export function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function getMonthlyCredits(userId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(credits), 0)::int` })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.userId, userId),
        eq(usageRecords.period, currentPeriod())
      )
    );
  return row?.total ?? 0;
}
