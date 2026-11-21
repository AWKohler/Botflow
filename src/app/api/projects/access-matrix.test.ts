/**
 * Access-control matrix for every /api/projects/[id]/** handler.
 *
 * POLICY below is the spec (docs/features/project-sharing-plan.md §3.3 role
 * matrix). A new route or method fails the inventory test until it is
 * classified here, so nothing ships without an explicit access decision.
 *
 * Every handler is called as: signed-out, signed-in stranger, and active
 * editor, against a project owned by someone else. Refusals must change no
 * DB rows and make no outbound requests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { projects } from '@/db/schema';
import { signInAs, signOut } from '@/test/auth';
import { currentTestDb, setupTestDb, snapshotDb } from '@/test/db';
import { addMember, createProject } from '@/test/factories';
import { takeUnhandledRequests } from '@/test/network';
import { callRoute, type HttpMethod, type RouteHandler } from '@/test/route';

// Every feature flag on, so no route short-circuits before its access check.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SHARING_ENABLED = 'true';
  process.env.NEXT_PUBLIC_STRIPE_CONNECT_ENABLED = 'true';
  process.env.NEXT_PUBLIC_REVENUECAT_ENABLED = 'true';
  process.env.NEXT_PUBLIC_CLAUDE_CODE_ENABLED = 'true';
  process.env.NEXT_PUBLIC_ALLOW_PERSISTENT_EXP = 'true';
  process.env.NEXT_PUBLIC_ALLOW_MOBILE_EXP = 'true';
});

setupTestDb();

/**
 * editor  — owner + active editors (editor gets exactly the owner's response)
 * owner   — owner only; editors refused like strangers
 * push    — editors only when projects.editorsCanPush
 * backend — editors only when projects.editorsManageBackend
 * secret  — called by the generated app with the project secret, not Clerk
 */
type Access = 'editor' | 'owner' | 'push' | 'backend' | 'secret';

const POLICY: Record<string, Access> = {
  'POST app-store-readiness/icon-upload': 'editor',
  'POST app-store-readiness/icon': 'editor',
  'POST app-store-readiness/metadata': 'editor',
  'GET app-store-readiness/preflight': 'editor',
  'POST app-store-readiness/push-metadata': 'editor',
  'POST browser-log': 'editor',
  'DELETE browser-log': 'editor',
  'POST chat/questions/answer': 'editor',
  'POST convex/deploy': 'editor',
  'POST convex/oauth-provider-complete': 'owner',
  'GET convex/oauth-provider-status': 'editor',
  'POST convex/setup-auth': 'editor',
  'POST convex/setup-oauth-provider': 'owner',
  'DELETE convex/setup-oauth-provider': 'owner',
  'GET custom-domain': 'owner',
  'POST custom-domain': 'owner',
  'DELETE custom-domain': 'owner',
  'GET database-session': 'backend',
  'GET env/backend': 'backend',
  'POST env/backend': 'backend',
  'DELETE env/backend': 'backend',
  'GET env/request': 'editor',
  'POST env/request': 'editor',
  'DELETE env/request': 'editor',
  'GET env': 'editor',
  'POST env': 'editor',
  'PUT env': 'editor',
  'DELETE env': 'editor',
  'GET file-versions': 'editor',
  'POST git/commit': 'push',
  'POST git/pull': 'editor',
  'POST git/push': 'push',
  'POST git/status': 'editor',
  'PATCH github': 'owner',
  'DELETE github': 'owner',
  'POST github/sandbox/abort-merge': 'editor',
  'POST github/sandbox/commit': 'push',
  // Plan §3.3: connecting/disconnecting GitHub is owner-only.
  'POST github/sandbox/link': 'owner',
  'DELETE github/sandbox/link': 'owner',
  'POST github/sandbox/open-pr': 'push',
  'POST github/sandbox/pull': 'editor',
  'POST github/sandbox/push': 'push',
  'POST github/sandbox/resolve': 'editor',
  'POST github/sandbox/status': 'editor',
  'POST managed-domain': 'owner',
  'DELETE managed-domain': 'owner',
  'PATCH members/[memberId]': 'owner',
  'DELETE members/[memberId]': 'owner',
  'GET members': 'editor',
  'POST members': 'owner',
  'POST migrate-to-sandbox': 'editor',
  'POST muhkoo/provision': 'owner',
  'POST persistent-sandbox': 'editor',
  'GET publish': 'owner',
  'POST publish': 'owner',
  'DELETE publish': 'owner',
  'GET revenuecat/activity': 'editor',
  'POST revenuecat/connect': 'owner',
  'POST revenuecat/disconnect': 'owner',
  'POST revenuecat/initialize': 'owner',
  'GET revenuecat/products': 'editor',
  'POST revenuecat/products': 'editor',
  'GET revenuecat/status': 'editor',
  'GET ': 'editor',
  'PATCH ': 'editor',
  'DELETE ': 'owner',
  'POST sandbox/devserver': 'editor',
  'DELETE sandbox/devserver': 'editor',
  'POST sandbox/exec': 'editor',
  'GET sandbox/files': 'editor',
  'PUT sandbox/files': 'editor',
  'GET sandbox/preview-state': 'editor',
  'POST sandbox/publish': 'owner',
  'POST sandbox/search': 'editor',
  'POST sandbox/seed': 'editor',
  'GET sandbox/session': 'editor',
  'POST sandbox/session': 'editor',
  'PATCH sharing-settings': 'owner',
  'POST snapshot': 'editor',
  'POST stripe/account-session': 'owner',
  'GET stripe/account-status': 'editor',
  'POST stripe/checkout-session': 'secret',
  'GET stripe/connect-request': 'editor',
  'POST stripe/connect-request': 'editor',
  'DELETE stripe/connect-request': 'editor',
  'POST stripe/dashboard-link': 'secret',
  'POST stripe/disconnect': 'owner',
  'POST stripe/initialize': 'owner',
  'POST stripe/mode': 'owner',
  'GET stripe/products': 'editor',
  'POST stripe/products': 'editor',
  'POST stripe/subscription-status': 'secret',
  'GET swift-device/build/[buildId]/ipa': 'editor',
  'GET swift-device/build/[buildId]': 'editor',
  'POST swift-device/build': 'editor',
  'DELETE swift-preview/[sessionId]': 'editor',
  'POST swift-preview/rebuild': 'editor',
  'POST swift-preview/screenshot': 'editor',
  'POST swift-preview/source': 'editor',
  'POST swift-preview/start': 'editor',
  'GET swift-preview/state': 'editor',
  'POST swift-preview/state': 'editor',
  'GET swift-publish/app-status': 'editor',
  'GET swift-publish/build/[buildId]': 'editor',
  'POST swift-publish/submit': 'editor',
  'POST visual-edit': 'editor',
  // Threads are fully shared: every member can watch and prompt any thread.
  'GET threads': 'editor',
  'POST threads': 'editor',
  'PATCH threads/[threadId]': 'editor',
  'DELETE threads/[threadId]': 'editor',
  'POST threads/[threadId]/viewed': 'editor',
  'POST threads/[threadId]/queue': 'editor',
  'POST threads/[threadId]/queue/drain': 'editor',
  'DELETE threads/[threadId]/queue/[queueId]': 'editor',
};

/**
 * Policy violations found when this test was written. Each runs as
 * test.fails, so the suite stays green while the gap exists and goes red the
 * moment it is fixed — then delete the entry.
 */
const KNOWN_GAPS = new Set<string>([]);

/** Routes that validate the body before checking access need a valid body,
 *  or strangers get a 400 and the access check is never reached. */
const BODIES: Record<string, unknown> = {
  'POST convex/setup-oauth-provider': { provider: 'google' },
  'POST convex/oauth-provider-complete': { requestId: '00000000-0000-4000-8000-000000000009' },
};

const OWNER = 'user_owner';
const EDITOR = 'user_editor';
const STRANGER = 'user_stranger';
const OTHER_ID = '00000000-0000-4000-8000-000000000001';
const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ROUTES_DIR = path.resolve(__dirname, '[id]');

type Handler = RouteHandler;
type Entry = { key: string; method: HttpMethod; sub: string; file: string };

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return routeFiles(p);
    return e.name === 'route.ts' ? [p] : [];
  });
}

/** Exported HTTP methods, read from source so the inventory needs no imports. */
function inventory(): Entry[] {
  return routeFiles(ROUTES_DIR).flatMap((file) => {
    const sub = path.relative(ROUTES_DIR, path.dirname(file)).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    return METHODS.filter((m) =>
      new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b|export\\s+const\\s+${m}\\b`).test(src),
    ).map((method) => ({ key: `${method} ${sub}`, method, sub, file }));
  });
}

const ENTRIES = inventory();

async function seedProject(sub: string, flags: Partial<typeof projects.$inferInsert> = {}) {
  const p = await createProject({
    userId: OWNER,
    platform: /^(swift|app-store)/.test(sub) ? 'swift' : 'sandboxed-web',
    ...flags,
  });
  await addMember(p.id, EDITOR);
  return p;
}

async function call(entry: Entry, projectId: string) {
  const mod = (await import(entry.file)) as Record<string, Handler>;
  const params: Record<string, string> = { id: projectId };
  for (const [, seg] of entry.sub.matchAll(/\[(\w+)\]/g)) params[seg] = OTHER_ID;
  const hasBody = entry.method !== 'GET' && entry.method !== 'DELETE';
  try {
    return await callRoute(mod[entry.method], {
      method: entry.method,
      path: `/api/projects/${projectId}/${entry.sub}`,
      params,
      body: hasBody ? (BODIES[entry.key] ?? {}) : undefined,
    });
  } catch (e) {
    // An unhandled throw becomes a 500 in Next; record it as such.
    return new Response(String(e), { status: 500 });
  }
}

/** Call as a caller who must be refused; assert nothing happened. */
async function expectRefused(entry: Entry, projectId: string, statuses: number[]) {
  takeUnhandledRequests();
  const before = await snapshotDb();
  const res = await call(entry, projectId);
  expect(statuses, `${entry.key} → ${res.status}: ${await res.clone().text()}`).toContain(res.status);
  expect(takeUnhandledRequests(), 'refused request still called out').toEqual([]);
  expect(await snapshotDb(), 'refused request changed the database').toEqual(before);
}

describe('route inventory', () => {
  test('every project route + method has an access policy', () => {
    const unclassified = ENTRIES.map((e) => e.key).filter((k) => !(k in POLICY));
    expect(unclassified, 'classify these in POLICY').toEqual([]);
  });

  test('no stale policy entries', () => {
    const live = new Set(ENTRIES.map((e) => e.key));
    expect(Object.keys(POLICY).filter((k) => !live.has(k))).toEqual([]);
  });
});

describe.each(ENTRIES.filter((e) => e.key in POLICY))('$key', (entry) => {
  const access = POLICY[entry.key];
  const gapTest = KNOWN_GAPS.has(entry.key) ? test.fails : test;

  test('signed-out → 401', async () => {
    const p = await seedProject(entry.sub);
    signOut();
    await expectRefused(entry, p.id, [401]);
  });

  test(access === 'secret' ? 'stranger without project secret → 401' : 'stranger → 404', async () => {
    const p = await seedProject(entry.sub);
    await signInAs(STRANGER, { plan: 'max' });
    await expectRefused(entry, p.id, access === 'secret' ? [401] : [404]);
  });

  if (access === 'owner') {
    gapTest('editor → refused', async () => {
      const p = await seedProject(entry.sub);
      await signInAs(EDITOR, { plan: 'max' });
      await expectRefused(entry, p.id, [403, 404]);
    });
  }

  if (access === 'push' || access === 'backend') {
    const flag = access === 'push' ? 'editorsCanPush' : 'editorsManageBackend';

    test(`editor without ${flag} → refused`, async () => {
      const p = await seedProject(entry.sub);
      await signInAs(EDITOR, { plan: 'max' });
      await expectRefused(entry, p.id, [403, 404]);
    });

    test(`editor with ${flag} → same response as owner`, async () => {
      const ownerP = await seedProject(entry.sub, { [flag]: true });
      await signInAs(OWNER, { plan: 'max' });
      const ownerRes = await call(entry, ownerP.id);
      takeUnhandledRequests();

      const p = await seedProject(entry.sub, { [flag]: true });
      await signInAs(EDITOR, { plan: 'max' });
      const res = await call(entry, p.id);
      takeUnhandledRequests();
      expect(res.status).toBe(ownerRes.status);
    });
  }

  if (access === 'editor') {
    test('editor → same response as owner', async () => {
      const ownerP = await seedProject(entry.sub);
      await signInAs(OWNER, { plan: 'max' });
      const ownerRes = await call(entry, ownerP.id);
      takeUnhandledRequests();

      const p = await seedProject(entry.sub);
      await signInAs(EDITOR, { plan: 'max' });
      const res = await call(entry, p.id);
      takeUnhandledRequests();
      expect(res.status).toBe(ownerRes.status);
      expect([401, 403]).not.toContain(res.status);
    });
  }
});

describe('revoked and pending members are strangers', () => {
  const sample = ENTRIES.filter((e) => ['GET ', 'GET env', 'POST sandbox/exec'].includes(e.key));

  test.each(['revoked', 'pending'] as const)('%s member → 404', async (status) => {
    for (const entry of sample) {
      const p = await createProject({ userId: OWNER });
      await addMember(p.id, 'user_former', { status });
      await signInAs('user_former', { plan: 'max' });
      await expectRefused(entry, p.id, [404]);
    }
  });
});

describe('sharing flag off → single-owner', () => {
  test('active editor row grants nothing when SHARING_ENABLED is false', async () => {
    // Module-level flag: re-import project-access with the env flipped.
    vi.resetModules();
    const prev = process.env.NEXT_PUBLIC_SHARING_ENABLED;
    process.env.NEXT_PUBLIC_SHARING_ENABLED = 'false';
    try {
      const { requireProjectAccess } = await import('@/lib/project-access');
      const p = await createProject({ userId: OWNER });
      await addMember(p.id, EDITOR);
      expect(await requireProjectAccess(p.id, EDITOR)).toBeNull();
      expect((await requireProjectAccess(p.id, OWNER))?.role).toBe('owner');
    } finally {
      process.env.NEXT_PUBLIC_SHARING_ENABLED = prev;
      vi.resetModules();
    }
  });
});

describe('owner-only fields never reach editors', () => {
  const SECRET_FIELDS = {
    convexDeployKey: 'prod:secret-deploy-key',
    userConvexDeployKey: 'prod:user-deploy-key',
    stripeWebhookSecret: 'whsec_secret',
    revenuecatWebhookSecret: 'rc_secret',
  } as const;

  test.each(['GET', 'PATCH'] as const)('%s /api/projects/[id] as editor strips secrets', async (method) => {
    const p = await createProject({ userId: OWNER, ...SECRET_FIELDS });
    await addMember(p.id, EDITOR);
    const entry = ENTRIES.find((e) => e.key === `${method} `)!;
    await signInAs(EDITOR);
    const mod = (await import(entry.file)) as Record<string, Handler>;
    const res = await callRoute(mod[method], {
      method,
      params: { id: p.id },
      body: method === 'PATCH' ? { publicDescription: 'x' } : undefined,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const v of Object.values(SECRET_FIELDS)) expect(text).not.toContain(v);
  });

  test('owner still receives them', async () => {
    const p = await createProject({ userId: OWNER, ...SECRET_FIELDS });
    const entry = ENTRIES.find((e) => e.key === 'GET ')!;
    await signInAs(OWNER);
    const mod = (await import(entry.file)) as Record<string, Handler>;
    const res = await callRoute(mod.GET, { params: { id: p.id } });
    expect(await res.text()).toContain(SECRET_FIELDS.convexDeployKey);
  });
});

describe('editor cannot escalate via PATCH /api/projects/[id]', () => {
  test('ownership and sharing switches are not writable', async () => {
    const p = await createProject({ userId: OWNER });
    await addMember(p.id, EDITOR);
    const entry = ENTRIES.find((e) => e.key === 'PATCH ')!;
    await signInAs(EDITOR);
    const mod = (await import(entry.file)) as Record<string, Handler>;
    await callRoute(mod.PATCH, {
      method: 'PATCH',
      params: { id: p.id },
      body: { userId: EDITOR, editorsCanPush: true, editorsManageBackend: true, isPublic: true },
    });
    const [row] = await currentTestDb().select().from(projects).where(eq(projects.id, p.id));
    expect(row.userId).toBe(OWNER);
    expect(row.editorsCanPush).toBe(false);
    expect(row.editorsManageBackend).toBe(false);
  });
});
