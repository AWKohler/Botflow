/**
 * Signed preview-URL tokens for sandbox-host previews.
 *
 * When sandbox-host previews are served publicly through the Cloudflare
 * tunnel (https://<subdomain>.<PREVIEW_DOMAIN>), the host's preview router
 * requires a signed token before it will proxy to the guest. We mint the
 * token here and append it to the preview URL as `?_bft=…`; the router
 * validates it on the first document request and sets a scoped cookie
 * (`__bf_preview`) so subresources and the Vite HMR websocket are authorized
 * without the query param.
 *
 * Token format (v1, must match sandbox-host's verifier byte-for-byte):
 *   v1.<exp>.<sig>
 *     exp = unix SECONDS (decimal)
 *     sig = base64url-unpadded( HMAC-SHA256( secret, "v1.<exp>.<host>" ) )
 *     host = lowercase preview hostname, no port
 *
 * The token binds to the hostname, so a leaked token for one preview can't
 * be replayed against another sandbox's subdomain. Defense-in-depth on top
 * of the high-entropy subdomain itself (capability URL, same model as
 * Vercel's *.vercel.run preview URLs).
 *
 * Env: PREVIEW_SIGNING_SECRET — shared secret with the sandbox-host service.
 * Unset ⇒ signPreviewUrl is a no-op (URLs pass through untouched, matching a
 * host deployment running with preview auth disabled).
 */
import { createHmac } from "node:crypto";

export const PREVIEW_TOKEN_QUERY_PARAM = "_bft";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function previewSigningSecret(): string | undefined {
  return process.env.PREVIEW_SIGNING_SECRET || undefined;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint a v1 preview token for `host` (lowercase hostname, no port). */
export function mintPreviewToken(
  host: string,
  opts: { ttlSeconds?: number; nowMs?: number } = {},
): string {
  const secret = previewSigningSecret();
  if (!secret) {
    throw new Error("PREVIEW_SIGNING_SECRET is not set");
  }
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const exp = Math.floor((opts.nowMs ?? Date.now()) / 1000) + ttl;
  const payload = `v1.${exp}.${host.toLowerCase()}`;
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `v1.${exp}.${sig}`;
}

/**
 * Append a signed `_bft` token to a preview URL. No-op when the signing
 * secret is unset (host running with preview auth off) or the URL doesn't
 * parse. Existing query params (e.g. cache busters) are preserved.
 */
export function signPreviewUrl(previewUrl: string): string {
  if (!previewSigningSecret()) return previewUrl;
  let url: URL;
  try {
    url = new URL(previewUrl);
  } catch {
    return previewUrl;
  }
  url.searchParams.set(PREVIEW_TOKEN_QUERY_PARAM, mintPreviewToken(url.hostname));
  return url.toString();
}
