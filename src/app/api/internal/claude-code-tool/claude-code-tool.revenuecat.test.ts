/**
 * The agent's RevenueCat tools, through the tool callback route: who may start
 * setup, what an agent is told before and after the user connects, and that
 * the catalog tools reach RevenueCat with the project's own key.
 */
import { describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { projects } from '@/db/schema';
import { mintToolToken } from '@/lib/agent/claude-code/tool-token';
import {
  connectRevenueCat,
  peekAgentWaitingForConnect,
} from '@/lib/revenuecat-connection';
import { createUser } from '@/test/auth';
import { currentTestDb, setupTestDb } from '@/test/db';
import { addMember, createProject } from '@/test/factories';
import { fakeRevenueCat } from '@/test/revenuecat-fake';
import { callRoute } from '@/test/route';

const sandbox = vi.hoisted(() => {
  process.env.REVENUECAT_ENABLED = 'true';
  process.env.NEXT_PUBLIC_SHARING_ENABLED = 'true';
  process.env.SECRETS_ENCRYPTION_KEY = 'test-secrets-encryption-key-0123456789abcdef';
  process.env.NEXT_PUBLIC_APP_URL = 'https://botflow.test';
  return { scaffolded: [] as string[], materialized: [] as string[] };
});

// The files these tools write live in the project's sandbox, which has its
// own tests; here they are recorded.
vi.mock('@/lib/revenuecat-scaffold', () => ({
  scaffoldRevenueCatIntoProject: async (id: string) => {
    sandbox.scaffolded.push(id);
    return { filesWritten: [], envSet: true, routeWired: true };
  },
}));
vi.mock('@/lib/sandbox-env', () => ({
  materializeSwiftRevenueCatConfig: async (id: string) => void sandbox.materialized.push(id),
}));

const { POST } = await import('./route');

setupTestDb();

const OWNER = 'owner_pro';

async function swiftProject(overrides: Record<string, unknown> = {}) {
  await createUser({ id: OWNER, plan: 'pro' });
  return createProject({ userId: OWNER, name: 'StreakPal', platform: 'swift', backendType: 'user', ...overrides });
}

async function callTool(token: string, tool: string, input: Record<string, unknown> = {}) {
  const res = await callRoute(POST as never, {
    method: 'POST',
    path: '/api/internal/claude-code-tool',
    body: { tool, input },
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as { ok: boolean; status?: string; content: string };
}

async function projectRow(id: string) {
  const [row] = await currentTestDb().select().from(projects).where(eq(projects.id, id));
  return row;
}

describe('before the user has connected RevenueCat', () => {
  test('initialize opens setup, writes the project files, and remembers which chat is waiting', async () => {
    const p = await swiftProject();
    const token = await mintToolToken({ userId: OWNER, projectId: p.id, threadId: 'thread_7' });
    sandbox.scaffolded.length = 0;

    const result = await callTool(token, 'initialize_revenuecat_payments');
    expect(result).toMatchObject({ ok: true, status: 'needs-connect' });
    expect(result.content).toMatch(/Do NOT wait/);
    expect(result.content).toContain('Sources/Core/RevenueCatConfig.swift');

    const row = await projectRow(p.id);
    expect(row.revenuecatStatus).toBe('connecting');
    expect(row.revenuecatWebhookSecret).toMatch(/^bfrc_/);
    expect(sandbox.scaffolded).toEqual([p.id]);
    expect(await peekAgentWaitingForConnect(p.id)).toBe('thread_7');
  });

  test('calling initialize twice keeps the same backend secret', async () => {
    const p = await swiftProject();
    const token = await mintToolToken({ userId: OWNER, projectId: p.id });
    await callTool(token, 'initialize_revenuecat_payments');
    const first = (await projectRow(p.id)).revenuecatWebhookSecret;
    await callTool(token, 'initialize_revenuecat_payments');
    expect((await projectRow(p.id)).revenuecatWebhookSecret).toBe(first);
  });

  test.each(['get_revenuecat_products', 'create_revenuecat_product', 'remove_revenuecat_package'])(
    '%s says the user still has to connect, without calling RevenueCat',
    async (tool) => {
      const rc = fakeRevenueCat();
      const p = await swiftProject({ revenuecatStatus: 'connecting' });
      const token = await mintToolToken({ userId: OWNER, projectId: p.id });
      const result = await callTool(token, tool, { storeIdentifier: 'pro_monthly', type: 'subscription', package: 'x' });
      expect(result).toMatchObject({ ok: false, status: 'needs-connect' });
      expect(rc.calls).toEqual([]);
    },
  );
});

describe('once connected', () => {
  async function connected() {
    const rc = fakeRevenueCat();
    const p = await swiftProject({ revenuecatStatus: 'connecting' });
    const token = await mintToolToken({ userId: OWNER, projectId: p.id, threadId: 'thread_7' });
    await callTool(token, 'initialize_revenuecat_payments'); // the agent asked first
    const result = await connectRevenueCat({
      projectId: p.id,
      projectName: p.name,
      userId: OWNER,
      secretKey: 'sk_full',
      requestOrigin: 'https://botflow.test',
    });
    expect(result.ok).toBe(true);
    return { rc, p, token };
  }

  test('initialize reports the connection and never downgrades the project', async () => {
    const { p, token } = await connected();
    const result = await callTool(token, 'initialize_revenuecat_payments');
    expect(result).toMatchObject({ ok: true, status: 'already-connected' });
    expect(result.content).toContain('RevenueCat is connected (project "StreakPal")');
    expect((await projectRow(p.id)).revenuecatStatus).toBe('connected');
    // The agent has the work again: nobody is waiting to be told.
    expect(await peekAgentWaitingForConnect(p.id)).toBeNull();
  });

  test('create, read and remove work end to end with identifiers the agent can use verbatim', async () => {
    const { rc, token } = await connected();
    const created = await callTool(token, 'create_revenuecat_product', {
      storeIdentifier: 'pro_monthly',
      type: 'subscription',
      priceUsd: 4.99,
      entitlement: 'pro',
      package: '$rc_monthly',
    });
    expect(created.ok).toBe(true);
    expect(JSON.parse(created.content)).toMatchObject({
      identifiers: { product: 'pro_monthly', entitlement: 'pro', offering: 'default', package: '$rc_monthly' },
      testStore: { price: '$4.99' },
    });

    const read = await callTool(token, 'get_revenuecat_products');
    expect(JSON.parse(read.content)).toMatchObject({ readyForTestPurchases: true, issues: [] });

    const removed = await callTool(token, 'remove_revenuecat_package', { package: '$rc_monthly' });
    expect(JSON.parse(removed.content)).toMatchObject({ removed: true, remainingPackages: [] });
    expect(rc.packages).toEqual([]);
  });

  test('bad product input is refused before any RevenueCat write', async () => {
    const { rc, token } = await connected();
    const writes = rc.writes();
    const result = await callTool(token, 'create_revenuecat_product', { storeIdentifier: 'bad id!', type: 'subscription' });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/letters, digits/);
    expect(rc.writes()).toBe(writes);
  });

  test("a key revoked in RevenueCat: the agent is told to send the user back to the Payments tab", async () => {
    const { rc, token } = await connected();
    rc.keys.delete('sk_full');
    const result = await callTool(token, 'get_revenuecat_products');
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/does not recognise/);
    expect(result.content).toMatch(/reconnect in the Payments tab/);
  });

  test('an editor may manage the catalog but not start or change the connection', async () => {
    const { p } = await connected();
    await addMember(p.id, 'editor');
    const editorToken = await mintToolToken({ userId: 'editor', projectId: p.id });
    expect((await callTool(editorToken, 'get_revenuecat_products')).ok).toBe(true);
    const init = await callTool(editorToken, 'initialize_revenuecat_payments');
    expect(init.ok).toBe(false);
    expect(init.content).toMatch(/owner/i);
  });
});

describe('where payments are not available', () => {
  test('a project without a backend is told so, and nothing changes', async () => {
    const p = await swiftProject({ backendType: 'none' });
    const token = await mintToolToken({ userId: OWNER, projectId: p.id });
    const result = await callTool(token, 'initialize_revenuecat_payments');
    expect(result).toMatchObject({ ok: false, status: 'backend-blocked' });
    expect((await projectRow(p.id)).revenuecatStatus).toBe('none');
  });

  test('the Free plan is refused', async () => {
    await createUser({ id: 'free_owner' });
    const p = await createProject({ userId: 'free_owner', platform: 'swift', backendType: 'user' });
    const token = await mintToolToken({ userId: 'free_owner', projectId: p.id });
    const result = await callTool(token, 'initialize_revenuecat_payments');
    expect(result).toMatchObject({ ok: false, status: 'tier-blocked' });
  });
});
