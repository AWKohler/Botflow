import crypto from 'crypto';

// Minimal AES-256-GCM encrypt/decrypt utilities for httpOnly cookie payloads

const ALG = 'aes-256-gcm';

function getKey(): Buffer {
  const secret = process.env.SESSION_COOKIE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_COOKIE_SECRET must be set (>=32 chars).');
  }
  // Derive 32 bytes from the secret
  return crypto.createHash('sha256').update(secret).digest();
}

export async function encryptCookie(data: unknown): Promise<string> {
  const iv = crypto.randomBytes(12);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), enc.toString('base64'), tag.toString('base64')].join('.');
}

export async function decryptCookie<T = unknown>(value: string | undefined | null): Promise<T | null> {
  if (!value) return null;
  const [ivB64, encB64, tagB64] = value.split('.');
  if (!ivB64 || !encB64 || !tagB64) return null;
  const iv = Buffer.from(ivB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const key = getKey();
  // Pin the tag length (Node 22 otherwise accepts truncated GCM tags).
  const decipher = crypto.createDecipheriv(ALG, key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  try {
    return JSON.parse(dec.toString('utf8')) as T;
  } catch {
    return null;
  }
}
