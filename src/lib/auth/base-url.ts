/** Use the stable branch URL so OAuth redirects survive preview rebuilds. */
export function identityBaseURL(): string {
  const value = process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_BRANCH_URL
    ? `https://${process.env.VERCEL_BRANCH_URL}`
    : process.env.BETTER_AUTH_URL;
  if (!value) throw new Error('Authentication base URL is not configured');
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Authentication requires HTTPS');
  return url.origin;
}

/**
 * Preview deployments are reachable at a per-deployment URL as well as the
 * stable branch URL, but sign-in only works on the branch URL (it is the only
 * trusted origin and the only GitHub OAuth callback). Returns the branch URL to
 * redirect a page load to, or null when the request is already there.
 */
export function previewCanonicalRedirect(method: string, url: URL): URL | null {
  const branchHost = process.env.VERCEL_BRANCH_URL;
  if (process.env.VERCEL_ENV !== 'preview' || !branchHost) return null;
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (url.host === branchHost) return null;
  return new URL(url.pathname + url.search, `https://${branchHost}`);
}
