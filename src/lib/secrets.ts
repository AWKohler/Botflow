/**
 * Envelope encryption for long-lived secrets stored at rest (RevenueCat secret
 * keys, Apple App Store Connect .p8 private keys, etc.).
 *
 * Unlike Stripe account ids (which are not secret and are stored as plaintext),
 * the RevenueCat BYO flow asks the user to hand us their RevenueCat secret key
 * and an Apple private key. Those are bearer credentials, so we never persist
 * them in the clear.
 *
 * AES-256-GCM, mirroring src/lib/secure-cookies.ts. The key is derived from
 * SECRETS_ENCRYPTION_KEY when present, else falls back to SESSION_COOKIE_SECRET
 * (already required in every deployment) so this works out of the box.
 *
 * Wire format: `v1.<iv>.<ciphertext>.<tag>` (all base64). The `v1` prefix lets
 * us rotate the scheme later without ambiguity.
 */
import crypto from 'crypto';

const ALG = 'aes-256-gcm';
const VERSION = 'v1';

function getKey(): Buffer {
  const secret =
    process.env.SECRETS_ENCRYPTION_KEY || process.env.SESSION_COOKIE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY (or SESSION_COOKIE_SECRET) must be set (>=32 chars) to encrypt secrets at rest.',
    );
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/** Encrypt a UTF-8 string. Returns an opaque, self-describing token. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    enc.toString('base64'),
    tag.toString('base64'),
  ].join('.');
}

/** Decrypt a token produced by {@link encryptSecret}. Returns null on any failure. */
export function decryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, ivB64, encB64, tagB64] = parts;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const enc = Buffer.from(encB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const decipher = crypto.createDecipheriv(ALG, getKey(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

/** Convenience: encrypt only when a value is present. */
export function encryptSecretOrNull(plaintext: string | null | undefined): string | null {
  return plaintext ? encryptSecret(plaintext) : null;
}

/** Show only the last few chars of a secret, for display/debugging. */
export function maskSecret(plaintext: string, visible = 4): string {
  if (plaintext.length <= visible) return '•'.repeat(plaintext.length);
  return '•'.repeat(Math.min(plaintext.length - visible, 16)) + plaintext.slice(-visible);
}
