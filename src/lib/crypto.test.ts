/**
 * Crypto primitives that guard secrets at rest, OAuth state, and the JWTs we
 * mint for Apple. Pure — no DB, no network.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { mintAscToken, signEs256Jwt } from './asc-jwt';
import { signConvexOAuthState, verifyConvexOAuthState } from './convex-oauth-state';
import { signAppleClientSecret } from './oauth-providers/server';
import { decryptSecret, encryptSecret, encryptSecretOrNull, maskSecret } from './secrets';
import { encryptCookie } from './secure-cookies';
import { decryptPrivateData, encryptPrivateData } from './auth/crypto';

const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);

function withKey(key: string | undefined) {
  vi.stubEnv('SECRETS_ENCRYPTION_KEY', key ?? '');
  vi.stubEnv('SESSION_COOKIE_SECRET', '');
}

afterEach(() => vi.unstubAllEnvs());

describe('encryptSecret / decryptSecret', () => {
  test('round-trips unicode and long values', () => {
    withKey(KEY_A);
    for (const v of ['sk-live-123', 'pässwörd 🔑', 'x'.repeat(10_000)]) {
      expect(decryptSecret(encryptSecret(v))).toBe(v);
    }
  });

  test('fresh IV every call (same plaintext ≠ same ciphertext)', () => {
    withKey(KEY_A);
    const seen = new Set(Array.from({ length: 50 }, () => encryptSecret('same')));
    expect(seen.size).toBe(50);
  });

  test('ciphertext does not contain the plaintext', () => {
    withKey(KEY_A);
    const ct = encryptSecret('sk-live-very-secret');
    expect(ct).not.toContain('sk-live');
    expect(Buffer.from(ct.split('.')[2], 'base64').toString()).not.toContain('secret');
  });

  test.each([0, 1, 2, 3])('tampering with part %i → null (never garbage, never throws)', (i) => {
    withKey(KEY_A);
    const parts = encryptSecret('sk-live-123').split('.');
    const buf = Buffer.from(parts[i], i === 0 ? 'utf8' : 'base64');
    buf[0] ^= 0x01;
    parts[i] = i === 0 ? buf.toString('utf8') : buf.toString('base64');
    expect(decryptSecret(parts.join('.'))).toBeNull();
  });

  test('truncated auth tag → null', () => {
    withKey(KEY_A);
    const parts = encryptSecret('sk-live-123').split('.');
    parts[3] = Buffer.from(parts[3], 'base64').subarray(0, 4).toString('base64');
    expect(decryptSecret(parts.join('.'))).toBeNull();
  });

  test('wrong key → null', () => {
    withKey(KEY_A);
    const ct = encryptSecret('sk-live-123');
    withKey(KEY_B);
    expect(decryptSecret(ct)).toBeNull();
  });

  test.each([null, undefined, '', 'plaintext', 'v2.a.b.c', 'v1.a.b'])('malformed %j → null', (v) => {
    withKey(KEY_A);
    expect(decryptSecret(v as string)).toBeNull();
  });

  test.each([undefined, 'short-key'])('refuses to encrypt with a missing/short key (%s)', (key) => {
    withKey(key);
    expect(() => encryptSecret('x')).toThrow(/must be set/);
  });

  test('encryptSecretOrNull passes empties through', () => {
    withKey(KEY_A);
    expect(encryptSecretOrNull('')).toBeNull();
    expect(encryptSecretOrNull(null)).toBeNull();
    expect(decryptSecret(encryptSecretOrNull('k'))).toBe('k');
  });
});

describe('maskSecret', () => {
  test.each([
    ['sk-live-abcdefghijklmnop', 4],
    ['abcd', 4],
    ['ab', 4],
    ['whsec_0123456789', 6],
  ])('%s reveals at most %i trailing chars', (secret, visible) => {
    const masked = maskSecret(secret, visible);
    const shown = masked.replace(/•/g, '');
    expect(shown.length).toBeLessThanOrEqual(visible);
    expect(secret.endsWith(shown)).toBe(true);
    if (secret.length <= visible) expect(shown).toBe('');
  });

  test('mask length is capped (does not leak secret length past 16)', () => {
    expect(maskSecret('x'.repeat(100))).toBe('•'.repeat(16) + 'xxxx');
  });
});

describe('encryptCookie', () => {
  test('refuses a short SESSION_COOKIE_SECRET', async () => {
    vi.stubEnv('SESSION_COOKIE_SECRET', 'short');
    await expect(encryptCookie({ a: 1 })).rejects.toThrow(/SESSION_COOKIE_SECRET/);
  });
});

describe('Convex OAuth state (HMAC)', () => {
  test('round-trips', () => {
    vi.stubEnv('SESSION_COOKIE_SECRET', KEY_A);
    const payload = { userId: 'u1', returnTo: '/projects', ts: 123 };
    expect(verifyConvexOAuthState(signConvexOAuthState(payload))).toEqual(payload);
  });

  test('signed with another secret → null', () => {
    vi.stubEnv('SESSION_COOKIE_SECRET', KEY_A);
    const s = signConvexOAuthState({ userId: 'u1', returnTo: '/', ts: 1 });
    vi.stubEnv('SESSION_COOKIE_SECRET', KEY_B);
    expect(verifyConvexOAuthState(s)).toBeNull();
  });

  test('payload swap with the original signature → null', () => {
    vi.stubEnv('SESSION_COOKIE_SECRET', KEY_A);
    const s = signConvexOAuthState({ userId: 'victim', returnTo: '/', ts: 1 });
    const sig = s.slice(s.lastIndexOf('.') + 1);
    const forged = Buffer.from(JSON.stringify({ userId: 'attacker', returnTo: '/', ts: 1 })).toString('base64url');
    expect(verifyConvexOAuthState(`${forged}.${sig}`)).toBeNull();
  });

  test.each(['', '.', 'abc', 'abc.', '.sig', 'a.b.c'])('garbage %j → null', (s) => {
    vi.stubEnv('SESSION_COOKIE_SECRET', KEY_A);
    expect(verifyConvexOAuthState(s)).toBeNull();
  });
});

describe('ES256 JWTs (Apple Sign In client secret, App Store Connect)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  function decode(jwt: string) {
    const [h, p, s] = jwt.split('.');
    const verify = createVerify('SHA256').update(`${h}.${p}`);
    const valid = verify.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    return {
      header: JSON.parse(Buffer.from(h, 'base64url').toString()),
      payload: JSON.parse(Buffer.from(p, 'base64url').toString()),
      valid,
      sigBytes: Buffer.from(s, 'base64url').length,
    };
  }

  test('signature verifies with the public key and is raw R||S (64 bytes)', () => {
    const jwt = signEs256Jwt({ p8, keyId: 'KID', payload: { a: 1 } });
    const d = decode(jwt);
    expect(d.valid).toBe(true);
    expect(d.sigBytes).toBe(64);
    expect(d.header).toEqual({ alg: 'ES256', kid: 'KID', typ: 'JWT' });
  });

  test('Apple client secret claims: iss=team, sub=servicesId, aud=appleid, exp ≤ 6 months', () => {
    const before = Math.floor(Date.now() / 1000);
    const { secret, expiresAt } = signAppleClientSecret({ teamId: 'TEAM', keyId: 'KID', servicesId: 'com.x.web', p8 });
    const { payload, valid } = decode(secret);
    expect(valid).toBe(true);
    expect(payload).toMatchObject({ iss: 'TEAM', sub: 'com.x.web', aud: 'https://appleid.apple.com' });
    expect(payload.exp).toBe(expiresAt);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    // Apple rejects client secrets valid for more than 6 months.
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(15_777_000);
  });

  test('ASC token: aud=appstoreconnect-v1, lifetime ≤ 20 minutes', () => {
    const { payload, valid } = decode(mintAscToken({ issuerId: 'ISS', keyId: 'KID', p8 }));
    expect(valid).toBe(true);
    expect(payload).toMatchObject({ iss: 'ISS', aud: 'appstoreconnect-v1' });
    // Apple rejects ASC tokens with exp more than 20 minutes after iat.
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(20 * 60);
  });
});

describe('identity private metadata (auth/crypto)', () => {
  test('round-trips and is bound to its context', () => {
    const ct = encryptPrivateData({ k: 'v' }, 'profile:u1');
    expect(decryptPrivateData(ct, 'profile:u1')).toEqual({ k: 'v' });
    expect(() => decryptPrivateData(ct, 'profile:u2')).toThrow();
  });

  test('truncated auth tag is rejected (Node 22 accepts 4-byte tags unless pinned)', () => {
    const parts = encryptPrivateData({ k: 'v' }, 'profile:u1').split('.');
    parts[2] = Buffer.from(parts[2], 'base64').subarray(0, 4).toString('base64');
    expect(() => decryptPrivateData(parts.join('.'), 'profile:u1')).toThrow();
  });
});
