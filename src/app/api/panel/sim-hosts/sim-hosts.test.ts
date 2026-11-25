/**
 * Admin panel → Simulators API: admin-only, the unsecured-runtime
 * acknowledgement, and the platform token never coming back out.
 */
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { signInAs } from '@/test/auth';
import { setupTestDb } from '@/test/db';
import { server } from '@/test/network';
import { callRoute, readJson } from '@/test/route';
import { clearSimHostHealthCache } from '@/lib/sim-hosts/health';
import * as listRoute from './route';
import * as hostRoute from './[id]/route';
import * as testRoute from './[id]/test/route';

vi.hoisted(() => {
  process.env.PANEL_ADMIN_USER_IDS = 'admin_1';
  process.env.SIM_PLATFORM_TOKEN = 'env-token';
  process.env.SESSION_COOKIE_SECRET ??= 'test-session-cookie-secret-at-least-32-chars';
});

setupTestDb();

const ORIGIN = { origin: 'http://localhost:3000' };

const input = {
  name: 'Lab Mac',
  controllerUrl: 'https://lab.test',
  streamUrl: null,
  agentHostId: 'lab-agent',
  runtime: 'unsecure',
  macosVersion: '27.0',
  hardwareModel: 'Mac mini',
  chip: 'Apple M4',
  ramGb: 32,
  vmCapUnlocked: false,
  maxSessions: 4,
  scope: 'beta',
  priority: 50,
  notes: null,
};

beforeEach(() => {
  clearSimHostHealthCache();
  server.use(
    http.get('https://lab.test/health', () =>
      HttpResponse.json({ ok: true, hosts: [{ id: 'lab-agent', slots: 4, active: 1, kind: 'bare-metal', lastHeartbeat: 1 }] }),
    ),
  );
});

async function create(body: Record<string, unknown>) {
  return callRoute(listRoute.POST, { method: 'POST', path: '/api/panel/sim-hosts', headers: ORIGIN, body });
}

describe('panel sim-hosts API', () => {
  test('is hidden from non-admins', async () => {
    await signInAs('user_1');
    expect((await callRoute(listRoute.GET, { path: '/api/panel/sim-hosts' })).status).toBe(404);
    expect((await create({ input, serving: false })).status).toBe(404);
  });

  test('rejects cross-site writes', async () => {
    await signInAs('admin_1');
    const res = await callRoute(listRoute.POST, { method: 'POST', path: '/api/panel/sim-hosts', body: { input } });
    expect(res.status).toBe(403);
  });

  test('an unsecured host only goes into service with the warning acknowledged', async () => {
    await signInAs('admin_1');
    expect((await create({ input, serving: true })).status).toBe(409);

    const res = await create({ input, serving: false, platformToken: 'lab-secret' });
    expect(res.status).toBe(201);
    const { host, health } = await readJson<{ host: { id: string; hasOwnToken: boolean }; health: { activeSessions: number } }>(res);
    expect(host.hasOwnToken).toBe(true);
    expect(health.activeSessions).toBe(1);

    const patch = (body: Record<string, unknown>) =>
      callRoute(hostRoute.PATCH, { method: 'PATCH', path: `/api/panel/sim-hosts/${host.id}`, params: { id: host.id }, headers: ORIGIN, body });
    expect((await patch({ serving: true })).status).toBe(409);
    expect((await patch({ serving: true, acknowledgeUnsecured: true })).status).toBe(200);

    const list = await callRoute(listRoute.GET, { path: '/api/panel/sim-hosts' });
    const text = await list.text();
    expect(text).not.toContain('lab-secret');
    expect(JSON.parse(text).hosts[0]).toMatchObject({ host: { serving: true, scope: 'beta', runtime: 'unsecure' } });
  });

  test('validates fields, including the stock two-VM cap', async () => {
    await signInAs('admin_1');
    const res = await create({ input: { ...input, runtime: 'isolated', maxSessions: 4 }, serving: false });
    expect(res.status).toBe(400);
    expect((await readJson<{ fields: Record<string, string> }>(res)).fields.maxSessions).toMatch(/at most 2/);
  });

  test('a test result is saved on the host', async () => {
    await signInAs('admin_1');
    const { host } = await readJson<{ host: { id: string } }>(await create({ input: { ...input, runtime: 'isolated', maxSessions: 2 }, serving: false }));
    const res = await callRoute(testRoute.PUT, {
      method: 'PUT',
      path: `/api/panel/sim-hosts/${host.id}/test`,
      params: { id: host.id },
      headers: ORIGIN,
      body: { ok: true, startupMs: 41000, provisionMs: 900, buildMs: 22000, avgFps: 58.4, minFps: 51, targetFps: 60, resolution: '1206×2622', error: null },
    });
    expect(res.status).toBe(200);
    const list = await readJson<{ hosts: Array<{ host: { lastTest: { avgFps: number; at: string } } }> }>(
      await callRoute(listRoute.GET, { path: '/api/panel/sim-hosts' }),
    );
    expect(list.hosts[0].host.lastTest).toMatchObject({ avgFps: 58.4 });
    expect(list.hosts[0].host.lastTest.at).toBeTruthy();
  });
});
