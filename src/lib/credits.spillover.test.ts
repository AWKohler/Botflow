/**
 * Gate tests for reservePlatformCredits — the weekly-pacing / monthly-spillover
 * paradigm:
 *   1. weekly paces (an exhausted week blocks until the weekly reset)
 *   2. a request STRADDLING the weekly boundary is allowed; the overshoot
 *      draws on monthly headroom
 *   3. monthly is the hard ceiling (in the last week of a month the budgets
 *      converge, so spillover naturally vanishes — no calendar logic)
 *
 * Runs against an in-memory stand-in patched onto the shared redis singleton
 * (node --test runs without UPSTASH env, so the singleton is the mutable
 * no-op stub). The monthly key is pre-seeded in every scenario, so
 * ensureMonthlySeeded never reaches for Neon here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { redis } from "@/lib/redis";
import {
  reservePlatformCredits,
  adjustPlatformCredits,
  currentWeekKey,
  currentPeriod,
} from "@/lib/credits";

const store = new Map<string, number>();
Object.assign(redis as unknown as Record<string, unknown>, {
  exists: async (k: string) => (store.has(k) ? 1 : 0),
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: number, opts?: { nx?: boolean }) => {
    if (opts?.nx && store.has(k)) return null;
    store.set(k, v);
    return "OK";
  },
  incrby: async (k: string, n: number) => {
    const v = (store.get(k) ?? 0) + n;
    store.set(k, v);
    return v;
  },
  expire: async () => 1,
});

const USER = "user_spillover_test";
const wKey = () => `wcred:${USER}:${currentWeekKey()}`;
const mKey = () => `mcred:${USER}:${currentPeriod()}`;
const WEEKLY = 1_000;
const MONTHLY = 4_000;

function seed(weeklyUsed: number, monthlyUsed: number) {
  store.clear();
  store.set(wKey(), weeklyUsed);
  store.set(mKey(), monthlyUsed);
}

describe("reservePlatformCredits — weekly pacing with monthly spillover", () => {
  test("fits inside the weekly slice → ok, both counters advance", async () => {
    seed(100, 100);
    const r = await reservePlatformCredits(USER, 500, WEEKLY, MONTHLY);
    assert.deepEqual(r, { ok: true });
    assert.equal(store.get(wKey()), 600);
    assert.equal(store.get(mKey()), 600);
  });

  test("straddles the weekly boundary with monthly headroom → SPILLS (allowed)", async () => {
    seed(900, 900); // weekly headroom remains (900 < 1000) but +500 overshoots
    const r = await reservePlatformCredits(USER, 500, WEEKLY, MONTHLY);
    assert.deepEqual(r, { ok: true });
    assert.equal(store.get(wKey()), 1400); // over the weekly line — by design
    assert.equal(store.get(mKey()), 1400); // overshoot absorbed by the month
  });

  test("week already exhausted → weekly_exhausted, both counters rolled back", async () => {
    seed(1000, 1000); // weeklyUsed == limit: zero headroom, no spillover
    const r = await reservePlatformCredits(USER, 1, WEEKLY, MONTHLY);
    assert.deepEqual(r, { ok: false, reason: "weekly_exhausted" });
    assert.equal(store.get(wKey()), 1000);
    assert.equal(store.get(mKey()), 1000);
  });

  test("after a spillover, the NEXT request blocks until the weekly reset", async () => {
    seed(900, 900);
    assert.equal((await reservePlatformCredits(USER, 500, WEEKLY, MONTHLY)).ok, true);
    const next = await reservePlatformCredits(USER, 100, WEEKLY, MONTHLY);
    assert.deepEqual(next, { ok: false, reason: "weekly_exhausted" });
    assert.equal(store.get(wKey()), 1400); // second attempt fully rolled back
    assert.equal(store.get(mKey()), 1400);
  });

  test("monthly is the HARD ceiling → monthly_exceeded, rolled back (last-week convergence)", async () => {
    seed(500, 3800); // weekly headroom exists, but the month can't absorb 500
    const r = await reservePlatformCredits(USER, 500, WEEKLY, MONTHLY);
    assert.deepEqual(r, { ok: false, reason: "monthly_exceeded" });
    assert.equal(store.get(wKey()), 500);
    assert.equal(store.get(mKey()), 3800);
  });

  test("amount ≤ 0 defensive path still enforces both limits", async () => {
    seed(0, MONTHLY); // month fully spent
    assert.deepEqual(await reservePlatformCredits(USER, 0, WEEKLY, MONTHLY), {
      ok: false,
      reason: "monthly_exceeded",
    });
    seed(WEEKLY, 0); // week fully spent
    assert.deepEqual(await reservePlatformCredits(USER, 0, WEEKLY, MONTHLY), {
      ok: false,
      reason: "weekly_exhausted",
    });
    seed(0, 0);
    assert.deepEqual(await reservePlatformCredits(USER, 0, WEEKLY, MONTHLY), { ok: true });
  });

  test("adjustPlatformCredits reconciles BOTH counters (settle + refund paths)", async () => {
    seed(100, 100);
    await reservePlatformCredits(USER, 500, WEEKLY, MONTHLY);
    await adjustPlatformCredits(USER, -400); // settled at 100 actual
    assert.equal(store.get(wKey()), 200);
    assert.equal(store.get(mKey()), 200);
  });
});
