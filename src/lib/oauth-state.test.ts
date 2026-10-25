import { afterEach, describe, expect, test, vi } from 'vitest';
import { redirectUrl, signOAuthState, verifyOAuthState } from './oauth-state';

const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);
const T0 = 1_800_000_000_000;
const OPTS = { userId: 'u1', maxAgeMs: 15 * 60_000, now: T0 };

afterEach(() => vi.unstubAllEnvs());

describe('signOAuthState / verifyOAuthState', () => {
  test('round-trips the returnTo', () => {
    vi.stubEnv('SESSION_COOKIE_SECRET', KEY_A);
    const s = signOAuthState('github', { userId: 'u1', returnTo: '/workspace/1?tab=git', now: T0 });
    expect(verifyOAuthState('github', s, OPTS)).toEqual({ returnTo: '/workspace/1?tab=git' });
  });

  test('bound to the user', () => {
    vi.stubEnv('SESSION_COOKIE_SECRET', KEY_A);
    const s = signOAuthState('github', { userId: 'attacker', returnTo: '/', now: T0 });
    expect(verifyOAuthState('github', s, OPTS)).toBeNull();
  });

  test('bound to the secret', () => {
    vi.stubEnv('SESSION_COOKIE_SECRET', KEY_A);
    const s = signOAuthState('github', { userId: 'u1', returnTo: '/', now: T0 });
    vi.stubEnv('SESSION_COOKIE_SECRET', KEY_B);
    expect(verifyOAuthState('github', s, OPTS)).toBeNull();
  });

  test('payload swap under the original signature fails', () => {
    vi.stubEnv('SESSION_COOKIE_SECRET', KEY_A);
    const s = signOAuthState('github', { userId: 'attacker', returnTo: '/', now: T0 });
    const sig = s.slice(s.lastIndexOf('.') + 1);
    const forged = Buffer.from(JSON.stringify({ p: 'github', u: 'u1', r: '/', t: T0 })).toString('base64url');
    expect(verifyOAuthState('github', `${forged}.${sig}`, OPTS)).toBeNull();
  });

  test('expires after maxAgeMs; rejects states from the future', () => {
    vi.stubEnv('SESSION_COOKIE_SECRET', KEY_A);
    const s = signOAuthState('github', { userId: 'u1', returnTo: '/', now: T0 });
    expect(verifyOAuthState('github', s, { ...OPTS, now: T0 + 15 * 60_000 })).not.toBeNull();
    expect(verifyOAuthState('github', s, { ...OPTS, now: T0 + 15 * 60_000 + 1 })).toBeNull();
    const future = signOAuthState('github', { userId: 'u1', returnTo: '/', now: T0 + 10 * 60_000 });
    expect(verifyOAuthState('github', future, OPTS)).toBeNull();
  });

  test.each([null, undefined, '', '.', 'abc', 'abc.', '.sig', 'a.b.c'])('garbage %j → null', (s) => {
    vi.stubEnv('SESSION_COOKIE_SECRET', KEY_A);
    expect(verifyOAuthState('github', s, OPTS)).toBeNull();
  });

  test.each(['//evil.com', '.evil.com', '@evil.com', 'https://evil.com', '/\\evil.com', '/ok\r\nSet-Cookie: x'])(
    'off-origin returnTo %j is neutralised when signing',
    (returnTo) => {
      vi.stubEnv('SESSION_COOKIE_SECRET', KEY_A);
      const s = signOAuthState('github', { userId: 'u1', returnTo, now: T0 });
      expect(verifyOAuthState('github', s, OPTS)).toEqual({ returnTo: '/' });
    },
  );

  test('refuses to sign without a secret', () => {
    vi.stubEnv('SESSION_COOKIE_SECRET', '');
    vi.stubEnv('SECRETS_ENCRYPTION_KEY', '');
    expect(() => signOAuthState('github', { userId: 'u1', returnTo: '/' })).toThrow(/must be set/);
  });
});

describe('redirectUrl', () => {
  test('merges params into an existing query instead of appending a second "?"', () => {
    const u = redirectUrl('https://botflow.io', '/workspace/1?tab=git', { github_connected: '1' });
    expect(u.toString()).toBe('https://botflow.io/workspace/1?tab=git&github_connected=1');
  });

  test.each(['//evil.com', '.evil.com', '@evil.com', 'https://evil.com'])('%j stays on the origin', (path) => {
    expect(redirectUrl('https://botflow.io', path).host).toBe('botflow.io');
  });
});
