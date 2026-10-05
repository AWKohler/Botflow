/**
 * Every API handler outside /api/projects/[id] (covered by
 * projects/access-matrix.test.ts) must authenticate ITSELF.
 *
 * Why per-handler: src/middleware.ts calls `auth.protect()` without awaiting
 * it, so Clerk's rejection is a floating promise and the middleware never
 * blocks anything. Today the handlers are the only gate — this test keeps it
 * that way. (Do not "fix" the middleware by adding `await` without
 * allowlisting the project-secret Stripe routes and /api/public/*: generated
 * apps and signed-out visitors depend on reaching them.)
 *
 * New route files fail the inventory test until classified below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { signOut } from '@/test/auth';
import { setupTestDb, snapshotDb } from '@/test/db';
import { takeUnhandledRequests } from '@/test/network';
import { callRoute, type HttpMethod, type RouteHandler } from '@/test/route';

vi.hoisted(() => {
  for (const k of [
    'NEXT_PUBLIC_SHARING_ENABLED',
    'NEXT_PUBLIC_STRIPE_CONNECT_ENABLED',
    'NEXT_PUBLIC_REVENUECAT_ENABLED',
    'NEXT_PUBLIC_CLAUDE_CODE_ENABLED',
    'NEXT_PUBLIC_ALLOW_PERSISTENT_EXP',
    'NEXT_PUBLIC_ANTHROPIC_OAUTH_ENABLED',
    'NEXT_PUBLIC_OPENCODE_BACKEND_ENABLED',
  ]) {
    process.env[k] = 'true';
  }
  process.env.CRON_SECRET = 'cron-secret';
  process.env.BILLING_STRIPE_WEBHOOK_SECRET = 'whsec_test_billing';
  process.env.BILLING_STRIPE_SECRET_KEY = 'sk_test_billing_dummy';
  process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret-test-better-auth-secret';
  process.env.BETTER_AUTH_URL = 'http://localhost:3000';
  process.env.CLERK_WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQ=';
});

// Clerk webhook reads svix headers via next/headers.
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => new Map() }));

setupTestDb();

/**
 * session  — signed-in session required → 401 (or 3xx to sign-in) when signed out
 * cron     — CRON_SECRET bearer → 401 without it
 * webhook  — provider signature/secret → 4xx without it
 * token    — platform-minted bearer token (sandbox callbacks) → 401
 * callback — OAuth return leg: bad/missing state → same-origin error redirect
 * public   — intentionally open; must not write anything
 */
type Gate = 'session' | 'cron' | 'webhook' | 'token' | 'callback' | 'public';

const POLICY: Record<string, Gate> = {
  'GET agent/claude-code/reattach': 'session',
  'GET auth/[...all]': 'public', // Better Auth's own endpoints (sign-in, OAuth, sessions)
  'POST auth/[...all]': 'public',
  'POST billing/change-plan': 'session',
  'POST billing/checkout': 'session',
  'GET billing/manage': 'session',
  'POST billing/manage': 'session',
  'POST billing/portal': 'session',
  'GET billing/status': 'session',
  'GET cron/convex-usage': 'cron',
  'GET identity/avatar/[id]': 'public', // avatar images, served to anyone
  'POST identity/avatar': 'session',
  'GET identity/emails': 'session',
  'POST identity/emails': 'session',
  'GET identity/me': 'session',
  'GET panel/identity/[id]': 'session',
  'PATCH panel/identity/[id]': 'session',
  'POST panel/identity/[id]/secret': 'session',
  'GET panel/identity': 'session',
  'GET panel/infra': 'session',
  'GET panel/overview': 'session',
  'GET panel/providers': 'session',
  'GET panel/users': 'session',
  'POST webhooks/billing': 'webhook',
  'POST agent/claude-code': 'session',
  'POST agent/claude-code/stop': 'session',
  'GET agent/claude-code/turn-status': 'session',
  'POST agent/opencode': 'session',
  'POST agent': 'session',
  'POST chat-images/delete': 'session',
  'POST chat-images/upload': 'session',
  'GET chat': 'session',
  'POST chat': 'session',
  'DELETE chat': 'session',
  'POST convex/provision': 'session',
  'GET cron/blog-writer': 'cron',
  'POST cron/blog-writer': 'cron',
  'GET cron/retry-revenuecat-deliveries': 'cron',
  'GET cron/retry-stripe-deliveries': 'cron',
  'GET cron/rotate-apple-secrets': 'cron',
  'GET cron/sandbox-reaper': 'cron',
  'POST cron/sandbox-reaper': 'cron',
  'PUT domains/[id]/records/[recordId]': 'session',
  'DELETE domains/[id]/records/[recordId]': 'session',
  'GET domains/[id]/records': 'session',
  'POST domains/[id]/records': 'session',
  'GET domains/[id]': 'session',
  'DELETE domains/[id]': 'session',
  'GET domains/[id]/status': 'session',
  'GET domains': 'session',
  'POST domains': 'session',
  'GET github/repos': 'session',
  'POST github/repos': 'session',
  'POST internal/claude-code-tool': 'token',
  'GET internal/llm-proxy/[provider]/[...path]': 'token',
  'POST internal/llm-proxy/[provider]/[...path]': 'token',
  'POST oauth/claude/disconnect': 'session',
  'POST oauth/claude/exchange': 'session',
  'POST oauth/claude/start': 'session',
  'POST oauth/codex/disconnect': 'session',
  'POST oauth/codex/poll': 'session',
  'POST oauth/codex/start': 'session',
  'GET oauth/convex/callback': 'session',
  'POST oauth/convex/disconnect': 'session',
  'GET oauth/convex/start': 'session',
  'GET oauth/github/callback': 'session',
  'POST oauth/github/disconnect': 'session',
  'GET oauth/github/start': 'session',
  'GET oauth/github/status': 'session',
  'GET projects': 'session',
  'POST projects': 'session',
  'GET public/projects/[slug]': 'public',
  'GET public/projects/[slug]/source': 'public',
  'POST public/projects/[slug]/star': 'session',
  'GET public/projects': 'public',
  'POST revalidate/sanity': 'webhook',
  'GET stripe/oauth/callback': 'callback',
  'GET stripe/oauth/start': 'session',
  'GET swift-preview/config': 'session',
  'GET uploadthing': 'public', // UploadThing's own route handler; uploads auth in the file router
  'POST uploadthing': 'webhook',
  'GET usage/budget': 'session',
  'GET usage/claude-plan': 'session',
  'GET usage/credits': 'session',
  'GET usage/tier': 'public', // signed-out → { tier: 'free' }
  'GET user-settings': 'session',
  'POST user-settings': 'session',
  'GET user/apple-credentials': 'session',
  'POST user/apple-credentials': 'session',
  'DELETE user/apple-credentials': 'session',
  'GET user/plan': 'session',
  'POST webhooks/clerk': 'webhook',
  'POST webhooks/revenuecat': 'webhook',
  'POST webhooks/stripe': 'webhook',
};

const API_DIR = __dirname;
const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return routeFiles(p);
    return e.name === 'route.ts' ? [p] : [];
  });
}

const ENTRIES = routeFiles(API_DIR)
  .map((file) => ({ file, sub: path.relative(API_DIR, path.dirname(file)).split(path.sep).join('/') }))
  .filter(({ sub }) => !sub.startsWith('projects/[id]'))
  .flatMap(({ file, sub }) => {
    const src = fs.readFileSync(file, 'utf8');
    return METHODS.filter((m) =>
      new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b|export\\s+const\\s+${m}\\b|export\\s*\\{[^}]*\\bas\\s+${m}\\b`).test(src),
    ).map((method) => ({ key: `${method} ${sub}`, method, sub, file }));
  });

describe('route inventory', () => {
  test('every route + method declares how it authenticates', () => {
    expect(ENTRIES.map((e) => e.key).filter((k) => !(k in POLICY))).toEqual([]);
  });

  test('no stale entries', () => {
    const live = new Set(ENTRIES.map((e) => e.key));
    expect(Object.keys(POLICY).filter((k) => !live.has(k))).toEqual([]);
  });
});

describe.each(ENTRIES.filter((e) => e.key in POLICY))('$key', (entry) => {
  test('no credentials → refused (or public), no writes, no outbound calls', async () => {
    signOut();
    takeUnhandledRequests();
    const before = await snapshotDb();
    const mod = (await import(entry.file)) as Record<string, RouteHandler>;
    const params: Record<string, string | string[]> = {};
    for (const [, seg] of entry.sub.matchAll(/\[(?:\.\.\.)?(\w+)\]/g)) {
      params[seg] = seg === 'path' ? ['v1', 'messages'] : seg === 'provider' ? 'anthropic' : 'x1';
    }
    const hasBody = entry.method !== 'GET' && entry.method !== 'DELETE';
    const res = await callRoute(mod[entry.method], {
      method: entry.method,
      path: `/api/${entry.sub}`,
      params,
      body: hasBody ? {} : undefined,
    });

    const gate = POLICY[entry.key];
    if (gate === 'session') {
      const toSignIn = res.status >= 300 && res.status < 400 && /sign-in/.test(res.headers.get('location') ?? '');
      // 401, or 403 (same-origin/CSRF check first) / 404 (operator routes hide existence).
      expect([401, 403, 404].includes(res.status) || toSignIn, `${entry.key} → ${res.status}`).toBe(true);
    } else if (gate === 'cron' || gate === 'token') {
      expect(res.status).toBe(401);
    } else if (gate === 'callback') {
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      expect(new URL(res.headers.get('location')!).host).toBe('localhost:3000');
    } else if (gate === 'webhook') {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(takeUnhandledRequests()).toEqual([]);
    // Better Auth's persistent rate limiter counts every request — bookkeeping,
    // not a state change the caller caused.
    const after = await snapshotDb();
    delete after.identity_rate_limit;
    expect(after).toEqual(before);
  });
});
