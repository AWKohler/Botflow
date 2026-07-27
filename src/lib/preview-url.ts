/**
 * Join a navigation path onto a preview base URL while preserving the base's
 * query parameters — critically the signed `_bft` token that tunnel-fronted
 * sandbox-host preview URLs carry (see src/lib/preview-token.ts).
 *
 * Naive string concat (`baseUrl + path`) breaks tokened URLs:
 *   "https://host/?_bft=TOKEN" + "/"  →  "https://host/?_bft=TOKEN/"
 * which corrupts the token (the router then 403s). This helper rebuilds the
 * URL properly: path (and any query/hash it carries) wins, and the base's
 * params are carried over unless the path overrides them.
 *
 * Client-safe: no Node-only imports.
 */
export function buildPreviewUrl(baseUrl: string, path?: string | null): string {
  const target = path || "/";
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    // Malformed base (shouldn't happen) — fall back to legacy concat.
    return baseUrl + target;
  }
  let url: URL;
  try {
    url = new URL(target, base.origin);
  } catch {
    url = new URL("/", base.origin);
  }
  base.searchParams.forEach((v, k) => {
    if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  });
  return url.toString();
}
