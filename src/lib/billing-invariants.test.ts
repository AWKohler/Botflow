/**
 * Money invariants: every model is priced and tier-gated, credit math never
 * rounds a real request to free, limits are ordered, period keys roll over
 * correctly, and concurrent reservations respect the ceilings.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createUser, signInAs } from '@/test/auth';
import { setupTestDb } from '@/test/db';
import { fakeRedis } from '@/test/redis-fake';
import { MODEL_CONFIGS } from './agent/models';
import {
  MODEL_COST_MULTIPLIER,
  MODEL_PRICING,
  adjustPlatformCredits,
  calculateCredits,
  currentPeriod,
  currentWeekKey,
  getMonthlyLimit,
  getWeeklyLimit,
  rawToCredits,
  reservePlatformCredits,
} from './credits';
import { getUserTier } from './tier';
import { MODEL_TIER_REQUIREMENT, tierMeetsRequirement, type Tier } from './tier-shared';

const MODELS = Object.keys(MODEL_CONFIGS) as (keyof typeof MODEL_CONFIGS)[];
const TIERS: Tier[] = ['free', 'pro', 'max'];

const usage = (model: string, u: Partial<{ i: number; o: number; cr: number; cw: number }>) =>
  calculateCredits({
    model: model as never,
    inputTokens: u.i ?? 0,
    outputTokens: u.o ?? 0,
    cachedReadTokens: u.cr ?? 0,
    cacheWriteTokens: u.cw ?? 0,
  });

setupTestDb();
afterEach(() => vi.useRealTimers());

describe('every selectable model is priced and gated', () => {
  test.each(MODELS)('%s has pricing, a cost multiplier, and a tier requirement', (m) => {
    // calculateCredits silently falls back to the CHEAPEST pricing for an
    // unknown id — a missing entry here means an expensive model billed as MiniMax.
    expect(MODEL_PRICING[m], 'MODEL_PRICING').toBeDefined();
    expect(MODEL_COST_MULTIPLIER[m], 'MODEL_COST_MULTIPLIER').toBeGreaterThan(0);
    expect(MODEL_TIER_REQUIREMENT[m], 'MODEL_TIER_REQUIREMENT').toBeDefined();
  });

  test('no stale entries for models that no longer exist', () => {
    const live = new Set<string>(MODELS);
    expect(Object.keys(MODEL_TIER_REQUIREMENT).filter((m) => !live.has(m))).toEqual([]);
    expect(Object.keys(MODEL_COST_MULTIPLIER).filter((m) => !live.has(m))).toEqual([]);
  });
});

describe('tierMeetsRequirement', () => {
  test('full matrix', () => {
    const table = TIERS.map((u) => TIERS.map((r) => tierMeetsRequirement(u, r)));
    expect(table).toEqual([
      [true, false, false],
      [true, true, false],
      [true, true, true],
    ]);
  });
});

describe('calculateCredits', () => {
  test.each(MODELS)('%s: one real token is never free', (m) => {
    expect(usage(m, { i: 1 })).toBeGreaterThan(0);
    expect(usage(m, { o: 1 })).toBeGreaterThan(0);
  });

  test.each(MODELS)('%s: more tokens never cost less', (m) => {
    for (const k of ['i', 'o', 'cr', 'cw'] as const) {
      let prev = 0;
      for (const n of [0, 1, 10, 1_000, 100_000, 250_000, 1_000_000]) {
        const c = usage(m, { [k]: n });
        expect(c, `${k}=${n}`).toBeGreaterThanOrEqual(prev);
        prev = c;
      }
    }
  });

  test.each(MODELS)('%s: cached reads cost no more than fresh input; output ≥ input', (m) => {
    const N = 1_000_000;
    expect(usage(m, { cr: N })).toBeLessThanOrEqual(usage(m, { i: N }));
    expect(usage(m, { o: N })).toBeGreaterThanOrEqual(usage(m, { i: N }));
  });

  test('unknown model id never prices below the cheapest real model', () => {
    const cheapest = Math.min(...MODELS.map((m) => usage(m, { i: 1e6, o: 1e6 })));
    expect(usage('not-a-model', { i: 1e6, o: 1e6 })).toBeGreaterThanOrEqual(cheapest);
  });

  test('rawToCredits rounds up (never undercharges a partial credit)', () => {
    for (const m of MODELS) expect(rawToCredits(1, m)).toBeGreaterThanOrEqual(1);
  });

  test('price list snapshot (1M input + 1M output per model) — changes show up in review', () => {
    const table = Object.fromEntries(MODELS.map((m) => [m, usage(m, { i: 1e6, o: 1e6 })]));
    expect(table).toMatchSnapshot();
  });
});

describe('tier limits', () => {
  test('free < pro < max, weekly = monthly / 4', () => {
    expect(getMonthlyLimit('free')).toBeLessThan(getMonthlyLimit('pro'));
    expect(getMonthlyLimit('pro')).toBeLessThan(getMonthlyLimit('max'));
    for (const t of TIERS) expect(getWeeklyLimit(t)).toBe(Math.floor(getMonthlyLimit(t) / 4));
  });
});

describe('period keys', () => {
  const at = (iso: string) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  };

  test.each([
    ['2026-12-31T23:59:59.999Z', '2026-W53'],
    ['2027-01-01T00:00:00.000Z', '2026-W53'], // Friday: still ISO week 53 of 2026
    ['2027-01-03T23:59:59.999Z', '2026-W53'],
    ['2027-01-04T00:00:00.000Z', '2027-W01'], // Monday: new ISO week + year
    ['2026-03-08T23:59:59.999Z', '2026-W10'],
    ['2026-03-09T00:00:00.000Z', '2026-W11'],
    ['2025-12-29T00:00:00.000Z', '2026-W01'], // Monday in December belongs to next ISO year
  ])('currentWeekKey(%s) = %s', (iso, key) => {
    at(iso);
    expect(currentWeekKey()).toBe(key);
  });

  test.each([
    ['2026-01-31T23:59:59.999Z', '2026-01'],
    ['2026-02-01T00:00:00.000Z', '2026-02'],
    ['2026-12-31T23:59:59.999Z', '2026-12'],
    ['2027-01-01T00:00:00.000Z', '2027-01'],
  ])('currentPeriod(%s) = %s (UTC)', (iso, period) => {
    at(iso);
    expect(currentPeriod()).toBe(period);
  });

  test('week keys are unique and monotonic across two years of Mondays', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const keys: string[] = [];
    for (let t = Date.UTC(2025, 11, 29); t < Date.UTC(2028, 0, 1); t += 7 * 86_400_000) {
      vi.setSystemTime(t);
      keys.push(currentWeekKey());
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('reservePlatformCredits under concurrency', () => {
  const USER = 'user_concurrent';
  const seed = (w: number, m: number) => {
    fakeRedis.reset();
    void fakeRedis.set(`wcred:${USER}:${currentWeekKey()}`, w);
    void fakeRedis.set(`mcred:${USER}:${currentPeriod()}`, m);
  };
  const counters = async () => ({
    w: Number(await fakeRedis.get(`wcred:${USER}:${currentWeekKey()}`)),
    m: Number(await fakeRedis.get(`mcred:${USER}:${currentPeriod()}`)),
  });

  test.each(Array.from({ length: 25 }, (_, i) => i))('random burst #%i respects both ceilings', async (seedN) => {
    // Deterministic pseudo-random per case.
    let x = seedN + 1;
    const rand = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const WEEKLY = 1_000 + Math.floor(rand() * 4_000);
    const MONTHLY = WEEKLY * 4;
    const w0 = Math.floor(rand() * WEEKLY);
    seed(w0, w0);
    const amounts = Array.from({ length: 40 }, () => 1 + Math.floor(rand() * 600));

    const results = await Promise.all(amounts.map((a) => reservePlatformCredits(USER, a, WEEKLY, MONTHLY)));
    const accepted = amounts.filter((_, i) => results[i].ok);
    const { w, m } = await counters();

    // Counters equal exactly the accepted reservations (rollbacks are exact).
    expect(w).toBe(w0 + accepted.reduce((s, a) => s + a, 0));
    expect(m).toBe(w);
    // Monthly is a hard ceiling; weekly may overshoot by at most one request.
    expect(m).toBeLessThanOrEqual(MONTHLY);
    expect(w).toBeLessThan(WEEKLY + Math.max(...amounts));
    // Something was admitted while there was headroom.
    expect(accepted.length).toBeGreaterThan(0);
  });

  // KNOWN GAP: adjustPlatformCredits keys the weekly counter by the CURRENT
  // week, so a turn that straddles Sunday→Monday settles/refunds into the new
  // week (here: −500 → 500 bonus credits of weekly headroom). Bounded to one
  // reservation per boundary; fix by passing the reservation's week key through.
  test.fails('settle after the week rolled over never drives a counter negative', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-08T23:59:00Z'));
    seed(0, 0);
    expect((await reservePlatformCredits(USER, 500, 1_000, 4_000)).ok).toBe(true);
    vi.setSystemTime(new Date('2026-03-09T00:01:00Z')); // new ISO week
    await fakeRedis.set(`mcred:${USER}:${currentPeriod()}`, 500);
    await adjustPlatformCredits(USER, -500); // refund the whole reservation
    const { w, m } = await counters();
    expect(m).toBeGreaterThanOrEqual(0);
    expect(w).toBeGreaterThanOrEqual(0);
  });
});

describe('getUserTier', () => {
  test("resolves the REQUESTED user, never the caller's session plan", async () => {
    await signInAs('editor_max', { plan: 'max' });
    await createUser({ id: 'owner_without_plan' });
    expect(await getUserTier('owner_without_plan')).toBe('free');
    expect(await getUserTier('editor_max')).toBe('max');
  });

  test('works with no session at all (crons, LLM proxy, webhooks)', async () => {
    await createUser({ id: 'payer', plan: 'pro' });
    expect(await getUserTier('payer')).toBe('pro');
  });

  test('manually-set publicMetadata.plan is honoured', async () => {
    await createUser({ id: 'u_manual', publicMetadata: { plan: 'pro' } });
    expect(await getUserTier('u_manual')).toBe('pro');
  });

  test('beta is a floor (free → pro) but never caps max', async () => {
    await createUser({ id: 'u_beta', publicMetadata: { isBeta: true } });
    await createUser({ id: 'u_beta_max', publicMetadata: { isBeta: true }, plan: 'max' });
    expect(await getUserTier('u_beta')).toBe('pro');
    expect(await getUserTier('u_beta_max')).toBe('max');
  });

  test('an expired or canceled subscription is free', async () => {
    await createUser({ id: 'lapsed', plan: 'pro' });
    const { currentIdentityPool } = await import('@/test/db');
    await currentIdentityPool().query(
      "UPDATE botflow_subscription SET period_end = now() - interval '1 day' WHERE user_id = 'lapsed'",
    );
    expect(await getUserTier('lapsed')).toBe('free');
  });
});
