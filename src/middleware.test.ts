/**
 * Edge auth gate. The middleware requires a session for /api/* and the app
 * pages — except for routes that are session-less by design (generated apps,
 * provider callbacks, public reads), which must stay reachable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, test, vi } from 'vitest';
import { currentSession, signInAs } from '@/test/auth';
import { setupTestDb } from '@/test/db';

vi.mock('@/lib/auth/config', () => ({
  getAuth: () => ({ api: { getSession: async () => currentSession() } }),
}));

const { default: middleware } = await import('./middleware');

setupTestDb();

const PID = '0b6a2f9e-6a7c-4b1e-9b3a-5d2f0c1e7a11';

async function hit(pathname: string, method = 'GET') {
  return middleware(new NextRequest(new URL(pathname, 'https://botflow.io'), { method }));
}

const passed = (res: Response) => res.headers.get('x-middleware-next') === '1';

describe('signed out', () => {
  test.each([
    '/api/projects',
    `/api/projects/${PID}`,
    `/api/projects/${PID}/env`,
    `/api/projects/${PID}/stripe/products`,
    '/api/agent',
    '/api/user-settings',
    '/api/usage/credits',
    '/api/billing/status',
  ])('%s → 401', async (p) => {
    const res = await hit(p);
    expect(res.status).toBe(401);
  });

  test.each([
    // generated apps → project-secret Stripe proxy
    [`/api/projects/${PID}/stripe/checkout-session`, 'POST'],
    [`/api/projects/${PID}/stripe/dashboard-link`, 'POST'],
    [`/api/projects/${PID}/stripe/subscription-status`, 'POST'],
    // public gallery + project pages for logged-out visitors
    ['/api/public/projects', 'GET'],
    ['/api/public/projects/my-app', 'GET'],
    ['/api/public/projects/my-app/source', 'GET'],
    [`/api/og/project/${PID}`, 'GET'],
    ['/api/usage/tier', 'GET'],
    // provider callbacks
    ['/api/uploadthing', 'POST'],
    ['/api/revalidate/sanity', 'POST'],
    ['/api/webhooks/stripe', 'POST'],
    ['/api/webhooks/billing', 'POST'],
    ['/api/cron/sandbox-reaper', 'GET'],
    ['/api/internal/claude-code-tool', 'POST'],
    ['/api/auth/sign-in/email', 'POST'],
  ])('%s %s reaches its handler', async (p, method) => {
    expect(passed(await hit(p, method))).toBe(true);
  });

  test('the Stripe allowance is exact — sibling project routes stay protected', async () => {
    for (const p of [
      `/api/projects/${PID}/stripe/checkout-session/x`,
      `/api/projects/${PID}/stripe/initialize`,
      `/api/projects/${PID}/stripe/checkout-sessionX`,
      `/api/projects/a/b/stripe/checkout-session`,
    ]) {
      expect((await hit(p, 'POST')).status, p).toBe(401);
    }
  });

  test.each(['/workspace/abc', '/panel', '/account'])('page %s → sign-in redirect', async (p) => {
    const res = await hit(p);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/sign-in');
    expect(loc.searchParams.get('redirect_url')).toBe(p);
  });

  test.each(['/', '/pricing', '/explore', '/p/my-app'])('public page %s is not gated', async (p) => {
    expect(passed(await hit(p))).toBe(true);
  });
});

describe('signed in', () => {
  test('protected API passes through to the handler', async () => {
    await signInAs('u1');
    expect(passed(await hit('/api/projects'))).toBe(true);
    expect(passed(await hit('/workspace/abc'))).toBe(true);
  });
});

describe('allowlist stays in sync with the handlers', () => {
  // A handler that never calls auth() and lives outside the self-authenticating
  // prefixes is session-less by design, so the middleware must let it through.
  // (Operator/identity routes use their own session helpers.)
  const API = path.resolve(__dirname, 'app/api');
  const SELF_GATED = /^(webhooks|cron|internal|auth|panel|identity)\//;

  function routeFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return routeFiles(p);
      return /^route\.tsx?$/.test(e.name) ? [p] : [];
    });
  }

  const sessionless = routeFiles(API)
    .map((f) => ({ f, rel: path.relative(API, path.dirname(f)).split(path.sep).join('/') }))
    .filter(({ rel }) => !SELF_GATED.test(`${rel}/`))
    .filter(({ f }) => !/await auth\(\)/.test(fs.readFileSync(f, 'utf8')));

  test.each(sessionless.map(({ rel }) => rel))('/api/%s is reachable without a session', async (rel) => {
    const concrete = `/api/${rel}`.replace(/\[\.\.\.\w+\]/g, 'a/b').replace(/\[\w+\]/g, 'x1');
    expect(passed(await hit(concrete, 'POST')), concrete).toBe(true);
  });
});
