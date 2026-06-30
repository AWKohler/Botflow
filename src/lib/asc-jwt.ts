/**
 * App Store Connect API — ES256 JWT minting + thin fetch helper.
 *
 * Uses only node:crypto (no jsonwebtoken dep). The non-obvious part: JWT ES256
 * signatures must be the raw 64-byte R||S concatenation (`ieee-p1363`), NOT the
 * DER encoding node produces by default — Apple rejects DER-signed tokens with
 * a generic 401 NOT_AUTHORIZED.
 *
 * Docs: https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests
 */

import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

const ASC_API_BASE = 'https://api.appstoreconnect.apple.com';

// Apple caps token lifetime at 20 minutes; stay comfortably under it.
const TOKEN_TTL_SECONDS = 15 * 60;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Normalize a .p8 input into valid PEM and parse it.
 * Accepts either a full PEM block (-----BEGIN PRIVATE KEY-----) or just the
 * bare base64 body (e.g. a user pasted the key without the armor lines).
 * Throws a clear Error on malformed keys.
 */
function parseP8(p8: string): KeyObject {
  const trimmed = p8.trim();
  if (!trimmed) throw new Error('Empty .p8 key');

  let pem: string;
  if (trimmed.includes('-----BEGIN')) {
    pem = trimmed;
  } else {
    // Bare base64 body — strip whitespace and re-wrap as PEM
    const body = trimmed.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(body)) {
      throw new Error('Invalid .p8 key: not a PEM block or base64 key body');
    }
    const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
    pem = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
  }

  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('Invalid .p8 key: could not parse the private key');
  }
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(`Invalid .p8 key: expected an EC (ES256) key, got ${key.asymmetricKeyType}`);
  }
  // ES256 is defined over P-256 (prime256v1). A non-P-256 EC key would still
  // "sign" but produce a wrong-size R||S that Apple rejects — fail clearly here.
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== 'prime256v1') {
    throw new Error(`Invalid .p8 key: ES256 requires a P-256 key, got curve "${curve ?? 'unknown'}"`);
  }
  return key;
}

/**
 * Sign an ES256 JWT from an Apple .p8 (P-256) private key. The signature is the
 * raw 64-byte R||S concatenation (`ieee-p1363`) JWT ES256 requires — not the DER
 * encoding node emits by default. Shared by the App Store Connect token minter
 * and Sign in with Apple client-secret generation; those differ only in the
 * claim set, so callers pass their own payload.
 */
export function signEs256Jwt(opts: {
  p8: string;
  keyId: string;
  payload: Record<string, unknown>;
}): string {
  const key = parseP8(opts.p8);
  const header = { alg: 'ES256', kid: opts.keyId, typ: 'JWT' };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(opts.payload))}`;

  // ieee-p1363 → raw R||S (64 bytes), as JWT ES256 requires (not DER).
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key, dsaEncoding: 'ieee-p1363' });

  return `${signingInput}.${base64url(signature)}`;
}

/** Mint a short-lived ES256 JWT for the App Store Connect API. */
export function mintAscToken(opts: { issuerId: string; keyId: string; p8: string }): string {
  const now = Math.floor(Date.now() / 1000);
  return signEs256Jwt({
    p8: opts.p8,
    keyId: opts.keyId,
    payload: {
      iss: opts.issuerId,
      iat: now - 10, // small backdate to tolerate clock skew
      exp: now + TOKEN_TTL_SECONDS,
      aud: 'appstoreconnect-v1',
    },
  });
}

/** Fetch against the ASC API: prefixes the base URL, sets auth + JSON headers. */
export async function ascFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ASC_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
}
