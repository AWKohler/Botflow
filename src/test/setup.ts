/**
 * Runs before every test file. Replaces the app's external dependencies with
 * in-process fakes so no test can reach Neon, Upstash, Stripe, or the network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { currentSession, resetSession } from './auth';
import { fakeRedis } from './redis-fake';
import { server, startNetworkGuard, takeUnhandledRequests } from './network';

// Session only: the real identity directory (identityClient) is kept and runs
// against the test DB through the mocked getIdentityDb below.
vi.mock('@/lib/auth/server', async () => {
  const { identityClient } = await vi.importActual<typeof import('@/lib/auth/directory')>('@/lib/auth/directory');
  const { getPaidTier } = await import('@/lib/billing/entitlements');
  const { redirect } = await import('next/navigation');
  return {
    identityClient,
    auth: async () => {
      const s = currentSession();
      const userId = s?.user.id ?? null;
      const tier = userId ? await getPaidTier(userId) : 'free';
      return {
        userId,
        sessionId: s?.session.id ?? null,
        actor: s?.session.impersonatedBy ?? null,
        has: ({ plan }: { plan: string }) => Boolean(userId && tier === plan),
        redirectToSignIn: (o?: { returnBackUrl?: string }): never =>
          redirect(`/sign-in?redirect_url=${encodeURIComponent(o?.returnBackUrl ?? '/')}`),
      };
    },
  };
});

vi.mock('@/lib/auth/database', async () => {
  const { currentIdentityPool } = await import('./db');
  return { getIdentityDb: () => currentIdentityPool() };
});

vi.mock('@/db', async () => {
  const { currentTestDb } = await import('./db');
  return { getDb: () => currentTestDb() };
});

vi.mock('@/lib/redis', () => ({
  redis: fakeRedis,
  getRedis: () => fakeRedis,
}));

beforeAll(() => startNetworkGuard());

beforeEach(() => {
  fakeRedis.reset();
  resetSession();
});

afterEach(() => {
  server.resetHandlers();
  const leaked = takeUnhandledRequests();
  expect(leaked, 'test made network requests with no msw handler').toEqual([]);
});

afterAll(() => server.close());
