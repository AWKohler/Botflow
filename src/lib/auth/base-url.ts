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
