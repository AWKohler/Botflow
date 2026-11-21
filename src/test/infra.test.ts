/**
 * Self-test for the test harness: if these fail, every other test's fakes
 * are suspect.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { auth, identityClient } from '@/lib/auth/server';
import { getUserTier } from '@/lib/tier';
import { getUserCredentials, setUserCredentials } from '@/lib/user-credentials';
import { redis } from '@/lib/redis';
import { requireProjectAccess } from '@/lib/project-access';
import { createUser, signInAs, signOut } from './auth';
import { setupTestDb } from './db';
import { createProject } from './factories';
import { takeUnhandledRequests } from './network';
import { fakeRedis } from './redis-fake';

setupTestDb();

describe('test database', () => {
  test('getDb() is a fresh PGlite built from schema.ts', async () => {
    const p = await createProject({ userId: 'user_a' });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getDb().select().from(projects)).toHaveLength(1);
  });

  test('tables are truncated between tests', async () => {
    expect(await getDb().select().from(projects)).toHaveLength(0);
  });

  test('app code runs against it', async () => {
    const p = await createProject({ userId: 'user_a' });
    expect((await requireProjectAccess(p.id, 'user_a'))?.role).toBe('owner');
    expect(await requireProjectAccess(p.id, 'user_b')).toBeNull();
  });
});

describe('identity (real directory/tier/credentials code over the test DB)', () => {
  test('users, emails, metadata', async () => {
    await createUser({ id: 'u1', email: 'U1@Example.test', publicMetadata: { isBeta: true } });
    const u = await (await identityClient()).users.getUser('u1');
    expect(u.emailAddresses[0]).toMatchObject({ emailAddress: 'u1@example.test', verification: { status: 'verified' } });
    expect(u.publicMetadata).toEqual({ isBeta: true });
  });

  test('private metadata round-trips encrypted', async () => {
    await createUser({ id: 'u1' });
    await setUserCredentials('u1', { anthropicApiKey: 'sk-ant-test' });
    expect((await getUserCredentials('u1')).anthropicApiKey).toBe('sk-ant-test');
  });

  test('tier comes from the subscription row of the REQUESTED user', async () => {
    await createUser({ id: 'payer', plan: 'max' });
    await createUser({ id: 'free_user' });
    await signInAs('payer');
    expect(await getUserTier('payer')).toBe('max');
    expect(await getUserTier('free_user')).toBe('free');
    expect((await auth()).has({ plan: 'max' })).toBe(true);
  });

  test('signed out by default; signOut works', async () => {
    expect((await auth()).userId).toBeNull();
    await signInAs('u1');
    expect((await auth()).userId).toBe('u1');
    signOut();
    expect((await auth()).userId).toBeNull();
  });
});

describe('fake redis', () => {
  afterEach(() => vi.useRealTimers());

  test('JSON round-trip like Upstash', async () => {
    await redis.set('obj', { a: 1 });
    await redis.set('num', '42');
    expect(await redis.get('obj')).toEqual({ a: 1 });
    expect(await redis.get('num')).toBe(42);
  });

  test('TTL honours fake timers', async () => {
    vi.useFakeTimers();
    await redis.setex('t', 10, 'v');
    vi.advanceTimersByTime(10_000);
    expect(await redis.get('t')).toBeNull();
  });

  test('state is reset between tests', () => {
    expect(fakeRedis.dump()).toEqual({});
  });
});

describe('network guard', () => {
  test('unmocked fetch is refused and recorded', async () => {
    await expect(fetch('https://api.example.com/x')).rejects.toThrow();
    expect(takeUnhandledRequests()).toEqual(['GET https://api.example.com/x']);
  });
});

describe('scrubbed environment', () => {
  test('no production-looking secrets are visible to tests', () => {
    expect(process.env.DATABASE_URL ?? '').toBe('');
    expect(process.env.STRIPE_SECRET_KEY).toBeUndefined();
  });
});
