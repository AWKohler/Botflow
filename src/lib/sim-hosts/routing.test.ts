/**
 * Simulator host routing: which Mac a user's new session or build goes to,
 * and finding the Mac that holds existing work.
 */
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { simHosts } from '@/db/schema';
import { currentTestDb, setupTestDb } from '@/test/db';
import { server } from '@/test/network';
import { clearSimHostHealthCache } from './health';
import { NoSimHostError, pickSimTarget, rememberSimRoute, targetForSimWork } from './routing';
import { createSimHost } from './store';
import type { SimHostInput } from './model';

vi.hoisted(() => {
  process.env.SIM_CONTROLLER_URL = 'https://env-sim.test';
  process.env.SIM_PLATFORM_TOKEN = 'env-token';
  process.env.SESSION_COOKIE_SECRET ??= 'test-session-cookie-secret-at-least-32-chars';
});

const beta = new Set<string>();
vi.mock('@/lib/tier', () => ({ isBetaUser: async (id: string) => beta.has(id) }));

setupTestDb();

function input(name: string, over: Partial<SimHostInput> = {}): SimHostInput {
  return {
    name,
    controllerUrl: `https://${name}.test`,
    streamUrl: null,
    agentHostId: null,
    runtime: 'isolated',
    macosVersion: '26',
    hardwareModel: null,
    chip: null,
    ramGb: null,
    vmCapUnlocked: false,
    maxSessions: 2,
    scope: 'all',
    priority: 100,
    notes: null,
    ...over,
  };
}

async function add(name: string, over: Partial<SimHostInput> = {}, opts: { serving?: boolean; token?: string } = {}) {
  return createSimHost(input(name, over), { serving: opts.serving ?? true, platformToken: opts.token ?? null });
}

/** /health for a host: `active` of `slots` busy, or down. */
function health(name: string, h: { slots?: number; active?: number; down?: boolean; kind?: string } = {}) {
  server.use(
    http.get(`https://${name}.test/health`, () =>
      h.down
        ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json({
            ok: true,
            hosts: [{ id: `${name}-agent`, slots: h.slots ?? 2, active: h.active ?? 0, kind: h.kind ?? 'vm', lastHeartbeat: Date.now() }],
          }),
    ),
  );
}

beforeEach(() => {
  beta.clear();
  clearSimHostHealthCache();
});

describe('pickSimTarget', () => {
  test('an empty registry uses the env controller', async () => {
    const t = await pickSimTarget('u1');
    expect(t).toMatchObject({ hostId: 'env', http: 'https://env-sim.test', ws: 'wss://env-sim.test', token: 'env-token' });
  });

  test('takes the lowest priority number that is up and has room', async () => {
    await add('a', { priority: 20 });
    const b = await add('b', { priority: 10 });
    health('a');
    health('b');
    const t = await pickSimTarget('u1');
    expect(t.hostId).toBe(b.id);
    expect(t.ws).toBe('wss://b.test');
    expect(t.token).toBe('env-token');
  });

  test('a full host is passed over for one with room; all full queues on the first one up', async () => {
    const a = await add('a', { priority: 10 });
    const b = await add('b', { priority: 20 });
    health('a', { active: 2 });
    health('b', { active: 1 });
    expect((await pickSimTarget('u1')).hostId).toBe(b.id);

    clearSimHostHealthCache();
    health('a', { active: 2 });
    health('b', { active: 2 });
    expect((await pickSimTarget('u1')).hostId).toBe(a.id);
  });

  test("the agent's slot count caps the host's limit", async () => {
    await add('a', { priority: 10, vmCapUnlocked: true, maxSessions: 6 });
    const b = await add('b', { priority: 20 });
    health('a', { slots: 2, active: 2 });
    health('b');
    expect((await pickSimTarget('u1')).hostId).toBe(b.id);
  });

  test('a host that is down is skipped; if all are down the first is tried anyway', async () => {
    const a = await add('a', { priority: 10 });
    const b = await add('b', { priority: 20 });
    health('a', { down: true });
    health('b');
    expect((await pickSimTarget('u1')).hostId).toBe(b.id);

    clearSimHostHealthCache();
    health('a', { down: true });
    health('b', { down: true });
    expect((await pickSimTarget('u1')).hostId).toBe(a.id);
  });

  test('beta-only hosts serve beta users only', async () => {
    const pub = await add('pub', { priority: 50 });
    const lab = await add('lab', { priority: 10, scope: 'beta', runtime: 'unsecure' });
    health('pub');
    health('lab', { kind: 'bare-metal' });
    expect((await pickSimTarget('regular')).hostId).toBe(pub.id);
    beta.add('tester');
    expect((await pickSimTarget('tester')).hostId).toBe(lab.id);
  });

  test('App Store builds never go to beta-only hosts', async () => {
    const pub = await add('pub', { priority: 50 });
    await add('lab', { priority: 10, scope: 'beta' });
    health('pub');
    health('lab');
    beta.add('tester');
    expect((await pickSimTarget('tester', { release: true })).hostId).toBe(pub.id);
  });

  test('hosts that are switched off take nothing; none left is an error, not the env controller', async () => {
    await add('a', {}, { serving: false });
    await expect(pickSimTarget('u1')).rejects.toBeInstanceOf(NoSimHostError);
    // A beta-only host is no help to a regular user either.
    await add('lab', { scope: 'beta' });
    await expect(pickSimTarget('u1')).rejects.toBeInstanceOf(NoSimHostError);
  });

  test('at equal priority the more isolated runtime wins', async () => {
    await add('bare', { priority: 10, runtime: 'unsecure' });
    const half = await add('half', { priority: 10, runtime: 'build-isolated' });
    health('bare', { kind: 'bare-metal' });
    health('half', { kind: 'bare-metal' });
    expect((await pickSimTarget('u1')).hostId).toBe(half.id);

    const full = await add('full', { priority: 10 });
    clearSimHostHealthCache();
    health('bare', { kind: 'bare-metal' });
    health('half', { kind: 'bare-metal' });
    health('full');
    expect((await pickSimTarget('u1')).hostId).toBe(full.id);
  });

  test("a host's own token is used instead of the deployment's", async () => {
    const a = await add('a', {}, { token: 'host-a-token' });
    health('a');
    const t = await pickSimTarget('u1');
    expect(t.hostId).toBe(a.id);
    expect(t.token).toBe('host-a-token');
    const [row] = await currentTestDb().select().from(simHosts);
    expect(row.platformTokenEnc).not.toContain('host-a-token');
  });
});

describe('targetForSimWork', () => {
  const SID = '11111111-2222-3333-4444-555555555555';

  test('follows the remembered host, even after it stops serving', async () => {
    const a = await add('a', { priority: 10 });
    const b = await add('b', { priority: 20 }, { serving: false });
    await rememberSimRoute('session', SID, { hostId: b.id, http: 'https://b.test', ws: 'wss://b.test', token: 'x' });
    expect((await targetForSimWork('session', SID)).hostId).toBe(b.id);
    expect(a.id).not.toBe(b.id);
  });

  test('on a miss, asks each host and remembers the one that has it', async () => {
    await add('a', { priority: 10 });
    const b = await add('b', { priority: 20 });
    let asked = 0;
    server.use(
      http.get(`https://a.test/api/device-builds/${SID}`, () => (asked++, HttpResponse.json({ error: 'not found' }, { status: 404 }))),
      http.get(`https://b.test/api/device-builds/${SID}`, () => (asked++, HttpResponse.json({ buildId: SID }))),
    );
    expect((await targetForSimWork('device-build', SID)).hostId).toBe(b.id);
    expect(asked).toBe(2);
    // Remembered: no second round of probes.
    expect((await targetForSimWork('device-build', SID)).hostId).toBe(b.id);
    expect(asked).toBe(2);
  });

  test('an empty registry uses the env controller', async () => {
    expect((await targetForSimWork('session', SID)).hostId).toBe('env');
  });
});
