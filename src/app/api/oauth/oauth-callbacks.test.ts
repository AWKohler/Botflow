/**
 * OAuth connect flows: CSRF (state bound to the signed-in user) and open
 * redirects.
 *
 * Threat model: an attacker starts a flow for THEIR OWN third-party account,
 * then gets a signed-in victim to land on our callback with the attacker's
 * code. Without a state bound to the victim's session, the attacker's account
 * gets linked to the victim's Botflow account.
 */
import { http, HttpResponse } from 'msw';
import { eq } from 'drizzle-orm';
import { describe, expect, test, vi } from 'vitest';
import { stripeOauthStates } from '@/db/schema';
import { signConvexOAuthState } from '@/lib/convex-oauth-state';
import { signOAuthState } from '@/lib/oauth-state';
import { getUserCredentials } from '@/lib/user-credentials';
import { createUser, signInAs, signOut } from '@/test/auth';
import { currentTestDb, setupTestDb } from '@/test/db';
import { addMember, createProject } from '@/test/factories';
import { server } from '@/test/network';
import { callRoute } from '@/test/route';
import * as githubStart from './github/start/route';
import * as githubCallback from './github/callback/route';
import * as convexCallback from './convex/callback/route';
import * as stripeCallback from '../stripe/oauth/callback/route';

vi.hoisted(() => {
  process.env.GITHUB_CLIENT_ID = 'gh-client';
  process.env.GITHUB_CLIENT_SECRET = 'gh-secret';
  process.env.SESSION_COOKIE_SECRET = 'test-session-secret-test-session-secret';
  process.env.NEXT_PUBLIC_STRIPE_CONNECT_ENABLED = 'true';
  process.env.NEXT_PUBLIC_SHARING_ENABLED = 'true';
});

setupTestDb();

const HOST = 'localhost:3000';

function location(res: Response) {
  const loc = res.headers.get('location');
  if (!loc) throw new Error(`expected a redirect, got ${res.status}`);
  return new URL(loc);
}

/** Mock GitHub so a callback that gets past its checks can complete. */
function mockGitHub(login = 'someone') {
  const exchanged = vi.fn();
  server.use(
    http.post('https://github.com/login/oauth/access_token', () => {
      exchanged();
      return HttpResponse.json({ access_token: `gho_${login}_token` });
    }),
    http.get('https://api.github.com/user', () => HttpResponse.json({ login, avatar_url: 'https://x/a.png' })),
  );
  return exchanged;
}

const githubCb = (search: Record<string, string>) =>
  callRoute(githubCallback.GET, { path: '/api/oauth/github/callback', search });

describe('GitHub OAuth start', () => {
  test('mints a signed state and sends the browser to GitHub', async () => {
    await signInAs('u1');
    const res = await callRoute(githubStart.GET, { path: '/api/oauth/github/start', search: { returnTo: '/workspace/p1?tab=git' } });
    const loc = location(res);
    expect(loc.host).toBe('github.com');
    const state = loc.searchParams.get('state')!;
    expect(state).toMatch(/^[\w-]+\.[\w-]+$/);
    // The old format was bare base64(JSON) — make sure that's gone.
    expect(() => JSON.parse(Buffer.from(state, 'base64url').toString())).toThrow();
  });

  test.each(['//evil.com', '.evil.com', '@evil.com', 'https://evil.com', '/\\evil.com'])(
    'returnTo %j is not echoed off-origin on the error path',
    async (returnTo) => {
      vi.stubEnv('GITHUB_CLIENT_ID', '');
      vi.resetModules();
      const fresh = await import('./github/start/route');
      await signInAs('u1');
      const res = await callRoute(fresh.GET, { path: '/api/oauth/github/start', search: { returnTo } });
      expect(location(res).host).toBe(HOST);
      vi.unstubAllEnvs();
    },
  );
});

describe('GitHub OAuth callback', () => {
  test('happy path: own state → token stored, back to returnTo with its query intact', async () => {
    const exchanged = mockGitHub('victim-gh');
    await signInAs('victim');
    const state = signOAuthState('github', { userId: 'victim', returnTo: '/workspace/p1?tab=git' });
    const res = await githubCb({ code: 'good_code', state });
    const loc = location(res);
    expect(exchanged).toHaveBeenCalledOnce();
    expect(loc.host).toBe(HOST);
    expect(loc.pathname).toBe('/workspace/p1');
    expect(loc.searchParams.get('tab')).toBe('git');
    expect(loc.searchParams.get('github_connected')).toBe('1');
    expect((await getUserCredentials('victim')).githubAccessToken).toBe('gho_victim-gh_token');
  });

  test('signed-out → sign-in, no token exchange', async () => {
    const exchanged = mockGitHub();
    signOut();
    const res = await githubCb({ code: 'c' });
    expect(location(res).pathname).toBe('/sign-in');
    expect(exchanged).not.toHaveBeenCalled();
  });

  const legacyState = (p: object) => Buffer.from(JSON.stringify(p)).toString('base64url');

  test.each([
    ['no state', () => undefined],
    ['legacy unsigned state naming the victim', () => legacyState({ userId: 'victim', returnTo: '/projects', ts: Date.now() })],
    ['state signed for the attacker', () => signOAuthState('github', { userId: 'attacker', returnTo: '/projects' })],
    ['tampered signature', () => signOAuthState('github', { userId: 'victim', returnTo: '/' }).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))],
    ['expired state (16 min)', () => signOAuthState('github', { userId: 'victim', returnTo: '/', now: Date.now() - 16 * 60_000 })],
    ['Convex state replayed into GitHub', () => signConvexOAuthState({ userId: 'victim', returnTo: '/', ts: Date.now() })],
  ])('%s → invalid_state, attacker code never exchanged (CSRF)', async (_l, makeState) => {
    const exchanged = mockGitHub('attacker-gh');
    await createUser({ id: 'attacker' });
    await signInAs('victim');
    const state = makeState();
    const res = await githubCb({ code: 'attacker_code', ...(state ? { state } : {}) });
    expect(location(res).searchParams.get('github_error')).toBe('invalid_state');
    expect(location(res).host).toBe(HOST);
    expect(exchanged).not.toHaveBeenCalled();
    expect((await getUserCredentials('victim')).githubAccessToken).toBeNull();
  });

  test.each(['.evil.com', '@evil.com', '//evil.com', 'https://evil.com/x', '/\\evil.com'])(
    'returnTo %j can never leave the origin (open redirect)',
    async (returnTo) => {
      mockGitHub();
      await signInAs('victim');
      // Even a legitimately signed state can't carry an off-origin target...
      const signed = signOAuthState('github', { userId: 'victim', returnTo });
      expect(location(await githubCb({ state: signed })).host).toBe(HOST);
      // ...and an attacker-crafted unsigned one is rejected outright.
      const forged = legacyState({ returnTo });
      expect(location(await githubCb({ state: forged })).host).toBe(HOST);
    },
  );
});

describe('Convex OAuth callback (signed state)', () => {
  function mockConvex() {
    const exchanged = vi.fn();
    server.use(
      http.post('https://api.convex.dev/oauth/token', () => {
        exchanged();
        return HttpResponse.json({ access_token: 'convex_token' });
      }),
    );
    return exchanged;
  }

  test.each([
    ['forged signature', () => signConvexOAuthState({ userId: 'victim', returnTo: '/', ts: Date.now() }).replace(/.$/, 'x')],
    ['state minted for another user', () => signConvexOAuthState({ userId: 'attacker', returnTo: '/', ts: Date.now() })],
    ['expired state (>15 min)', () => signConvexOAuthState({ userId: 'victim', returnTo: '/', ts: Date.now() - 16 * 60_000 })],
    ['missing state', () => ''],
    ['GitHub state replayed into Convex', () => signOAuthState('github', { userId: 'victim', returnTo: '/' })],
  ])('%s → invalid_state, no exchange', async (_label, makeState) => {
    const exchanged = mockConvex();
    await signInAs('victim');
    const state = makeState();
    const res = await callRoute(convexCallback.GET, {
      path: '/api/oauth/convex/callback',
      search: { code: 'attacker_code', ...(state ? { state } : {}) },
    });
    expect(location(res).searchParams.get('convex_error')).toBe('invalid_state');
    expect(exchanged).not.toHaveBeenCalled();
  });

  test.each(['//evil.com', '.evil.com', '@evil.com', 'https://evil.com'])(
    'signed returnTo %s cannot leave the origin',
    async (returnTo) => {
      mockConvex();
      await signInAs('victim');
      const state = signConvexOAuthState({ userId: 'victim', returnTo, ts: Date.now() });
      const res = await callRoute(convexCallback.GET, { path: '/api/oauth/convex/callback', search: { state } });
      expect(location(res).host).toBe(HOST);
    },
  );
});

describe('Stripe Connect OAuth callback (single-use DB state)', () => {
  async function mintState(userId: string, projectId: string, opts: { expiresInMs?: number } = {}) {
    const state = `st_${Math.random().toString(36).slice(2)}`;
    await currentTestDb().insert(stripeOauthStates).values({
      state,
      userId,
      projectId,
      mode: 'test',
      expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)),
    });
    return state;
  }

  const callback = (state: string) =>
    callRoute(stripeCallback.GET, { path: '/api/stripe/oauth/callback', search: { code: 'ac_attacker', state } });

  async function stateRow(state: string) {
    const [row] = await currentTestDb().select().from(stripeOauthStates).where(eq(stripeOauthStates.state, state));
    return row;
  }

  test("state minted for another user is refused (victim can't be bound to attacker's Stripe)", async () => {
    const p = await createProject({ userId: 'attacker' });
    const state = await mintState('attacker', p.id);
    await signInAs('victim');
    expect(location(await callback(state)).searchParams.get('reason')).toBe('user-mismatch');
  });

  test('unknown state is refused', async () => {
    await signInAs('victim');
    expect(location(await callback('st_made_up')).searchParams.get('reason')).toBe('invalid-or-expired-state');
  });

  test('expired state is refused and not consumed', async () => {
    const p = await createProject({ userId: 'victim' });
    const state = await mintState('victim', p.id, { expiresInMs: -1000 });
    await signInAs('victim');
    expect(location(await callback(state)).searchParams.get('reason')).toBe('invalid-or-expired-state');
    expect((await stateRow(state)).consumedAt).toBeNull();
  });

  test('signed-out callback does not burn the one-shot state', async () => {
    const p = await createProject({ userId: 'victim' });
    const state = await mintState('victim', p.id);
    signOut();
    expect(location(await callback(state)).searchParams.get('reason')).toBe('unauthorized');
    expect((await stateRow(state)).consumedAt).toBeNull();
  });

  test('a state can only be used once (replay)', async () => {
    const p = await createProject({ userId: 'victim' });
    const state = await mintState('victim', p.id);
    await currentTestDb().update(stripeOauthStates).set({ consumedAt: new Date() }).where(eq(stripeOauthStates.state, state));
    await signInAs('victim');
    expect(location(await callback(state)).searchParams.get('reason')).toBe('invalid-or-expired-state');
  });

  test('an editor holding their own state still cannot connect Stripe (owner-only)', async () => {
    const p = await createProject({ userId: 'owner' });
    await addMember(p.id, 'editor');
    const state = await mintState('editor', p.id);
    await signInAs('editor');
    expect(location(await callback(state)).searchParams.get('stripe_connect')).toBe('error');
  });

  test('redirects never leave the origin', async () => {
    await signInAs('victim');
    expect(location(await callback('st_made_up')).host).toBe(HOST);
  });
});
