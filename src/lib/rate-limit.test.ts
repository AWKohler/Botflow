/**
 * Unit tests for the rate limiter's safety-critical surface: spoof-resistant IP
 * resolution, identity keying, the fail-open contract (never block on a
 * missing/broken Redis), and the 429 response shape.
 *
 * Uses Node's built-in test runner (no extra dependency). Run with:
 *   node --import tsx --test src/lib/rate-limit.test.ts
 *
 * Note: these tests run with Upstash env UNSET, so the shared `redis` is the
 * no-op stub. That lets us exercise both fail-open branches (unconfigured, and
 * "configured but the limiter throws") without a real Redis.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getClientIp,
  identifierFor,
  checkRateLimit,
  rateLimitResponse,
  isRateLimitConfigured,
  RATE_LIMIT_BUCKETS,
  type RateLimitBucket,
} from './rate-limit';

const reqWith = (headers: Record<string, string>) =>
  new Request('https://app.test/api/x', { headers });

// Snapshot/restore the env keys these tests mutate, so order can't leak state.
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'RL_DISABLED'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('getClientIp — spoof resistance', () => {
  test('prefers platform-set x-vercel-forwarded-for over client x-forwarded-for', () => {
    assert.equal(
      getClientIp(reqWith({ 'x-vercel-forwarded-for': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' })),
      '9.9.9.9',
    );
  });

  test('prefers x-real-ip over x-forwarded-for', () => {
    assert.equal(
      getClientIp(reqWith({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' })),
      '9.9.9.9',
    );
  });

  test('prefers cf-connecting-ip over x-forwarded-for', () => {
    assert.equal(
      getClientIp(reqWith({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' })),
      '9.9.9.9',
    );
  });

  test('falls back to first x-forwarded-for token only when no trusted header', () => {
    assert.equal(getClientIp(reqWith({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })), '1.2.3.4');
  });

  test('takes the first token of a comma-separated trusted header', () => {
    assert.equal(getClientIp(reqWith({ 'x-vercel-forwarded-for': '9.9.9.9, 8.8.8.8' })), '9.9.9.9');
  });

  test('returns 0.0.0.0 when no IP header is present', () => {
    assert.equal(getClientIp(reqWith({})), '0.0.0.0');
  });
});

describe('identifierFor', () => {
  test('keys authenticated users by user id', () => {
    assert.equal(identifierFor('user_123', reqWith({ 'x-real-ip': '9.9.9.9' })), 'user:user_123');
  });

  test('keys anonymous requests by client ip', () => {
    assert.equal(identifierFor(null, reqWith({ 'x-real-ip': '9.9.9.9' })), 'ip:9.9.9.9');
    assert.equal(identifierFor(undefined, reqWith({})), 'ip:0.0.0.0');
  });
});

describe('isRateLimitConfigured', () => {
  test('false unless both Upstash env vars are present', () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    assert.equal(isRateLimitConfigured(), false);
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    assert.equal(isRateLimitConfigured(), false); // token still missing
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    assert.equal(isRateLimitConfigured(), true);
  });
});

describe('checkRateLimit — fail open', () => {
  test('allows (enforced:false) when Redis is unconfigured', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const r = await checkRateLimit('ip:1.2.3.4', 'agent');
    assert.equal(r.success, true);
    assert.equal(r.enforced, false);
  });

  test('kill-switch RL_DISABLED=1 allows without enforcing', async () => {
    process.env.RL_DISABLED = '1';
    const r = await checkRateLimit('user:abc', 'deploy');
    assert.equal(r.success, true);
    assert.equal(r.enforced, false);
  });

  test('allows (enforced:false) when the limiter throws (no-op redis lacks evalsha)', async () => {
    // env "configured" but the module-bound redis is the no-op stub, so .limit()
    // throws and must be caught as allow.
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    delete process.env.RL_DISABLED;
    const r = await checkRateLimit('ip:9.9.9.9', 'public');
    assert.equal(r.success, true);
    assert.equal(r.enforced, false);
  });

  test('never throws', async () => {
    await assert.doesNotReject(() => checkRateLimit('ip:1.1.1.1', 'global'));
  });
});

describe('rateLimitResponse', () => {
  test('is a 429 with Retry-After and X-RateLimit-* headers', () => {
    const res = rateLimitResponse({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 5000,
      bucket: 'agent',
      identifier: 'user:x',
      enforced: true,
    });
    assert.equal(res.status, 429);
    const retryAfter = Number(res.headers.get('Retry-After'));
    assert.ok(retryAfter >= 1 && retryAfter <= 6, `retryAfter=${retryAfter}`);
    assert.equal(res.headers.get('X-RateLimit-Limit'), '10');
    assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
  });
});

describe('RATE_LIMIT_BUCKETS config', () => {
  test('every bucket has a positive token budget and a valid window', () => {
    const buckets = Object.keys(RATE_LIMIT_BUCKETS) as RateLimitBucket[];
    assert.ok(buckets.length > 0);
    for (const b of buckets) {
      const { tokens, window } = RATE_LIMIT_BUCKETS[b];
      assert.ok(Number.isInteger(tokens) && tokens > 0, `${b} tokens=${tokens}`);
      assert.match(String(window), /^\d+\s*(ms|s|m|h|d)$/, `${b} window=${window}`);
    }
  });
});
