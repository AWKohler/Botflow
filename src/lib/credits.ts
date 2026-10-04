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
import { MODEL_CONFIGS, type ModelId } from './agent/models';
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

export interface ModelPricing {
  input: number;         // credits per uncached input token
  cachedInput: number;   // credits per cached input token
  output: number;        // credits per output token
  cacheWrite?: number;   // credits per cache-write token (absent = billed as uncached input)
}

const BASE_PRICE = 0.30; // MiniMax input $/MTok — our credit base unit

/** Build a pricing row from $/MTok list prices. */
function perMTok(input: number, cachedInput: number, output: number, cacheWrite?: number): ModelPricing {
  return {
    input: input / BASE_PRICE,
    cachedInput: cachedInput / BASE_PRICE,
    output: output / BASE_PRICE,
    ...(cacheWrite !== undefined ? { cacheWrite: cacheWrite / BASE_PRICE } : {}),
  };
}

// All rates are zero-markup pass-through of the provider's list price
// (verified 2026-10-04 against platform.claude.com/docs/en/about-claude/pricing
// and developers.openai.com/api/docs/pricing). Arguments: input, cached read,
// output, cache write — all $/MTok.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'fireworks-minimax-m3': perMTok(0.30, 0.06, 1.20),
  'fireworks-kimi-k2p7':  perMTok(0.95, 0.19, 4.00),
  'fireworks-kimi-k3':    perMTok(3.00, 0.30, 15.00),

  // GPT-6 family. Cache writes bill at 1.25× input (GPT-5.6+ explicit
  // caching; the meter extracts cache_write_tokens). Reads are 0.1× input,
  // except 6.1 Sol at 0.05×. >272K prompts use LONG_CONTEXT_PRICING below.
  'gpt-6-astra': perMTok(10.00, 1.00, 50.00, 12.50),
  'gpt-6.1-sol': perMTok( 2.00, 0.10, 10.00,  2.50),
  'gpt-6-luna':  perMTok( 0.10, 0.01,  0.50,  0.125),

  // Claude 5.5 / 5.1 generation. Cache write = 5-minute ephemeral (1.25×
  // input) — the only TTL Botflow requests. Reads: Opus 5.5 is 0.05× input,
  // Fable 5.1 is 0.025×, Sonnet 5.5 the standard 0.1×. Flat pricing across
  // the full 1M window (no long-context tier).
  'claude-opus-5-5':   perMTok( 4.00, 0.20, 20.00,  5.00),
  'claude-sonnet-5-5': perMTok( 2.00, 0.20, 10.00,  2.50),
  'claude-fable-5-1':  perMTok(10.00, 0.25, 50.00, 12.50),

  // Gemini 3.1 Pro at ≤200K — cache write billed at full input price.
  'gemini-3.1-pro-preview': perMTok(2.00, 0.20, 12.00, 2.00),
  // xAI Grok 4.5. Verified live against the API's cost_in_usd_ticks.
  // Cache is passive/read-only (no cache-write billing); note the read
  // discount is only 75% ($2→$0.50).
  'grok-4.5': perMTok(2.00, 0.50, 6.00),

  // ── Retired ids (resolveModelId maps them to successors) ──────────────────
  // Kept ONLY so a proxy token minted before a deploy still settles at the
  // real price instead of the MiniMax fallback. Current list prices.
  'gpt-5.6-sol':     perMTok(4.00, 0.40, 20.00, 5.00),
  'gpt-5.6-terra':   perMTok(2.00, 0.20, 12.00, 2.50),
  'gpt-5.6-luna':    perMTok(0.20, 0.02,  1.20, 0.25),
  'gpt-5.5':         perMTok(5.00, 0.50, 30.00),
  'claude-opus-5':   perMTok(5.00, 0.50, 25.00, 6.25),
  'claude-sonnet-5': perMTok(2.00, 0.20, 10.00, 2.50),
  'claude-fable-5':  perMTok(10.00, 1.00, 50.00, 12.50),
};

/**
 * Long-context ("long prompt") tiers. When a single request's TOTAL prompt —
 * uncached + cache-read + cache-write tokens — exceeds `threshold`, the whole
 * request bills at `pricing` (providers price the request, not the marginal
 * tokens). Per-request granularity matters: callers pass one API call's
 * usage, never a turn's multi-call sum.
 */
export const LONG_CONTEXT_PRICING: Record<string, { threshold: number; pricing: ModelPricing }> = {
  // OpenAI: >272K input tokens — 2× input/cache, 1.5× output.
  'gpt-6-astra': { threshold: 272_000, pricing: perMTok(20.00, 2.00, 75.00, 25.00) },
  'gpt-6.1-sol': { threshold: 272_000, pricing: perMTok( 4.00, 0.20, 15.00,  5.00) },
  'gpt-6-luna':  { threshold: 272_000, pricing: perMTok( 0.20, 0.02,  0.75,  0.25) },
  'gpt-5.6-sol': { threshold: 272_000, pricing: perMTok( 8.00, 0.80, 30.00, 10.00) }, // retired id
  // Gemini 3.1 Pro: >200K.
  'gemini-3.1-pro-preview': { threshold: 200_000, pricing: perMTok(4.00, 0.40, 18.00, 4.00) },
  // Grok 4.5: every rate doubles above 200K, per xAI's own model metadata
  // (verified live against GET api.x.ai/v1/models/grok-4.5).
  'grok-4.5': { threshold: 200_000, pricing: perMTok(4.00, 1.00, 12.00) },
};

/**
 * Representative agent-loop request used for the selector's "xN" cost hint:
 * per 100 prompt tokens, 85 are cache reads, 10 cache writes (the new tool
 * results/messages appended each step), 5 uncached; plus 3 output tokens.
 * Prompt-dominated, as agent loops are. Short-context rates.
 */
const COST_HINT_MIX = { uncached: 0.05, cachedRead: 0.85, cacheWrite: 0.10, output: 0.03 };

function blendedCost(p: ModelPricing): number {
  return (
    COST_HINT_MIX.uncached * p.input +
    COST_HINT_MIX.cachedRead * p.cachedInput +
    COST_HINT_MIX.cacheWrite * (p.cacheWrite ?? p.input) +
    COST_HINT_MIX.output * p.output
  );
}

/**
 * The selector multiplier a model's pricing implies: blended cost over the
 * mix above relative to MiniMax-M3 (= x1). Rounded to one decimal below 1,
 * else to the nearest integer. MODEL_CONFIGS[*].costMultiplier must equal
 * this (enforced in billing-invariants.test.ts).
 */
export function costMultiplierFromPricing(model: string): number {
  const ratio = blendedCost(MODEL_PRICING[model]) / blendedCost(MODEL_PRICING['fireworks-minimax-m3']);
  return ratio < 1 ? Math.max(0.1, Math.round(ratio * 10) / 10) : Math.round(ratio);
}

/** Per-model cost multiplier for frontend display (mirrors MODEL_CONFIGS). */
export const MODEL_COST_MULTIPLIER: Record<ModelId, number> = Object.fromEntries(
  Object.values(MODEL_CONFIGS).map((c) => [c.id, c.costMultiplier]),
) as Record<ModelId, number>;

export interface CreditCalculationInput {
  model: ModelId;
  inputTokens: number;      // uncached input tokens (Anthropic: usage.inputTokens; OpenAI/FW: inputTokens - cachedRead)
  outputTokens: number;
  cachedReadTokens: number;  // tokens served from cache
  cacheWriteTokens: number;  // tokens written to cache
}

/** The pricing row a single request bills at, including the long-context tier. */
export function pricingForRequest(
  model: string,
  promptTokens: number,
): ModelPricing {
  const long = LONG_CONTEXT_PRICING[model];
  if (long && promptTokens > long.threshold) return long.pricing;
  // Fallback for an unknown id: treat as MiniMax pricing
  return MODEL_PRICING[model] ?? MODEL_PRICING['fireworks-minimax-m3'];
}

/**
 * Calculate credits for ONE completed API request using per-token-type
 * pricing. The long-context tier keys off this request's total prompt, so
 * never pass a multi-request sum.
 */
export function calculateCredits(params: CreditCalculationInput): number {
  const { model, inputTokens, outputTokens, cachedReadTokens, cacheWriteTokens } = params;

  const pricing = pricingForRequest(model, inputTokens + cachedReadTokens + cacheWriteTokens);

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
