/**
 * IDOR on nested ids: a caller with legitimate access to project A must not
 * reach a member / build / session that belongs to project B by putting B's
 * child id under A's URL.
 */
import { http, HttpResponse } from 'msw';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { projectMembers } from '@/db/schema';
import { recordSwiftDeviceBuild } from '@/lib/swift-device-build-store';
import { recordSwiftPreviewSession } from '@/lib/swift-preview-store';
import { recordSwiftPublishBuild } from '@/lib/swift-publish-store';
import { signInAs, signOut } from '@/test/auth';
import { currentTestDb, setupTestDb } from '@/test/db';
import { addMember, createProject } from '@/test/factories';
import { server } from '@/test/network';
import { callRoute } from '@/test/route';
import * as memberRoute from './[id]/members/[memberId]/route';
import * as deviceBuildRoute from './[id]/swift-device/build/[buildId]/route';
import * as ipaRoute from './[id]/swift-device/build/[buildId]/ipa/route';
import * as publishBuildRoute from './[id]/swift-publish/build/[buildId]/route';
import * as previewSessionRoute from './[id]/swift-preview/[sessionId]/route';

// Flags are read at module load; vi.hoisted runs before the imports above.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SHARING_ENABLED = 'true';
  process.env.NEXT_PUBLIC_ALLOW_PERSISTENT_EXP = 'true';
  process.env.SIM_CONTROLLER_URL = 'https://sim.test';
  process.env.SIM_PLATFORM_TOKEN = 'sim-platform-token';
});

setupTestDb();

async function memberRow(id: string) {
  const [row] = await currentTestDb().select().from(projectMembers).where(eq(projectMembers.id, id));
  return row;
}

describe('members/[memberId]', () => {
  test("owner of A cannot revoke or re-cap B's member through A's URL", async () => {
    const a = await createProject({ userId: 'owner_a' });
    const b = await createProject({ userId: 'owner_b' });
    const bMember = await addMember(b.id, 'editor_b');
    await signInAs('owner_a');

    const del = await callRoute(memberRoute.DELETE, {
      method: 'DELETE',
      params: { id: a.id, memberId: bMember.id },
    });
    const patch = await callRoute(memberRoute.PATCH, {
      method: 'PATCH',
      params: { id: a.id, memberId: bMember.id },
      body: { tokenCapPct: 100 },
    });

    expect(del.status).toBe(404);
    expect(patch.status).toBe(404);
    const row = await memberRow(bMember.id);
    expect(row.status).toBe('active');
    expect(row.tokenCapPct).toBe(25);
  });

  test('an editor can leave (revoke themself)', async () => {
    const p = await createProject({ userId: 'owner_a' });
    const me = await addMember(p.id, 'editor_1');
    await signInAs('editor_1');
    const res = await callRoute(memberRoute.DELETE, { method: 'DELETE', params: { id: p.id, memberId: me.id } });
    expect(res.status).toBe(200);
    expect((await memberRow(me.id)).status).toBe('revoked');
  });

  test('an editor cannot revoke another editor', async () => {
    const p = await createProject({ userId: 'owner_a' });
    await addMember(p.id, 'editor_1');
    const other = await addMember(p.id, 'editor_2');
    await signInAs('editor_1');
    const res = await callRoute(memberRoute.DELETE, { method: 'DELETE', params: { id: p.id, memberId: other.id } });
    expect(res.status).toBe(404);
    expect((await memberRow(other.id)).status).toBe('active');
  });

  test('an editor cannot change token caps (including their own)', async () => {
    const p = await createProject({ userId: 'owner_a' });
    const me = await addMember(p.id, 'editor_1');
    await signInAs('editor_1');
    const res = await callRoute(memberRoute.PATCH, {
      method: 'PATCH',
      params: { id: p.id, memberId: me.id },
      body: { tokenCapPct: 100 },
    });
    expect(res.status).toBe(404);
    expect((await memberRow(me.id)).tokenCapPct).toBe(25);
  });

  test('owner can re-cap their own member; cap is validated', async () => {
    const p = await createProject({ userId: 'owner_a' });
    const m = await addMember(p.id, 'editor_1');
    await signInAs('owner_a');
    for (const bad of [0, 101, -5, 'x', null]) {
      const res = await callRoute(memberRoute.PATCH, {
        method: 'PATCH',
        params: { id: p.id, memberId: m.id },
        body: { tokenCapPct: bad },
      });
      expect(res.status, String(bad)).toBe(400);
    }
    const ok = await callRoute(memberRoute.PATCH, {
      method: 'PATCH',
      params: { id: p.id, memberId: m.id },
      body: { tokenCapPct: 60 },
    });
    expect(ok.status).toBe(200);
    expect((await memberRow(m.id)).tokenCapPct).toBe(60);
  });
});

describe('swift device builds', () => {
  const BUILD = 'build_123';

  async function twoSwiftProjects() {
    const a = await createProject({ userId: 'owner_a', platform: 'swift' });
    const b = await createProject({ userId: 'owner_b', platform: 'swift' });
    return { a, b };
  }

  test("status: B's build is invisible under A's URL (no controller call)", async () => {
    const { a, b } = await twoSwiftProjects();
    await recordSwiftDeviceBuild(BUILD, 'owner_b', b.id);
    await signInAs('owner_a', { plan: 'max' });
    const res = await callRoute(deviceBuildRoute.GET, { params: { id: a.id, buildId: BUILD } });
    expect(res.status).toBe(404);
  });

  test('status: same user, other project → 404', async () => {
    const a = await createProject({ userId: 'owner_a', platform: 'swift' });
    const a2 = await createProject({ userId: 'owner_a', platform: 'swift' });
    await recordSwiftDeviceBuild(BUILD, 'owner_a', a2.id);
    await signInAs('owner_a', { plan: 'max' });
    const res = await callRoute(deviceBuildRoute.GET, { params: { id: a.id, buildId: BUILD } });
    expect(res.status).toBe(404);
  });

  test('status: owner sees own build', async () => {
    const { a } = await twoSwiftProjects();
    await recordSwiftDeviceBuild(BUILD, 'owner_a', a.id);
    server.use(
      http.get(`https://sim.test/api/device-builds/${BUILD}`, () =>
        HttpResponse.json({ buildId: BUILD, status: 'building' }),
      ),
    );
    await signInAs('owner_a', { plan: 'max' });
    const res = await callRoute(deviceBuildRoute.GET, { params: { id: a.id, buildId: BUILD } });
    expect(res.status).toBe(200);
  });

  describe('ipa download token', () => {
    afterEach(() => vi.useRealTimers());

    function mockIpa() {
      const hit = vi.fn();
      server.use(
        http.get(`https://sim.test/api/device-builds/${BUILD}/ipa`, () => {
          hit();
          return new HttpResponse(new Uint8Array([1, 2, 3]), {
            headers: { 'content-type': 'application/octet-stream' },
          });
        }),
      );
      return hit;
    }

    test('valid token downloads without a session (device install link)', async () => {
      const { a } = await twoSwiftProjects();
      const token = await recordSwiftDeviceBuild(BUILD, 'owner_a', a.id);
      const hit = mockIpa();
      signOut();
      const res = await callRoute(ipaRoute.GET, { params: { id: a.id, buildId: BUILD }, search: { token } });
      expect(res.status).toBe(200);
      expect(hit).toHaveBeenCalledOnce();
    });

    test("B's token does not unlock the build under A's URL", async () => {
      const { a, b } = await twoSwiftProjects();
      const token = await recordSwiftDeviceBuild(BUILD, 'owner_b', b.id);
      const hit = mockIpa();
      signOut();
      const res = await callRoute(ipaRoute.GET, { params: { id: a.id, buildId: BUILD }, search: { token } });
      expect(res.status).toBe(401);
      expect(hit).not.toHaveBeenCalled();
    });

    test.each([
      ['wrong', 'x'.repeat(43)],
      ['truncated', null],
      ['empty', ''],
    ])('%s token without a session → 401', async (_label, tokenOverride) => {
      const { a } = await twoSwiftProjects();
      const real = await recordSwiftDeviceBuild(BUILD, 'owner_a', a.id);
      const hit = mockIpa();
      signOut();
      const token = tokenOverride ?? real.slice(0, -1);
      const res = await callRoute(ipaRoute.GET, { params: { id: a.id, buildId: BUILD }, search: { token } });
      expect(res.status).toBe(401);
      expect(hit).not.toHaveBeenCalled();
    });

    test('token expires with the 30-minute ownership record', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { a } = await twoSwiftProjects();
      const token = await recordSwiftDeviceBuild(BUILD, 'owner_a', a.id);
      const hit = mockIpa();
      vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1);
      signOut();
      const res = await callRoute(ipaRoute.GET, { params: { id: a.id, buildId: BUILD }, search: { token } });
      expect(res.status).toBe(401);
      expect(hit).not.toHaveBeenCalled();
    });
  });
});

describe('swift publish builds', () => {
  test("B's App Store build is invisible under A's URL", async () => {
    const a = await createProject({ userId: 'owner_a', platform: 'swift' });
    const b = await createProject({ userId: 'owner_b', platform: 'swift' });
    await recordSwiftPublishBuild('pub_1', 'owner_b', b.id);
    await signInAs('owner_a', { plan: 'max' });
    const res = await callRoute(publishBuildRoute.GET, { params: { id: a.id, buildId: 'pub_1' } });
    expect(res.status).toBe(404);
  });
});

describe('swift preview sessions', () => {
  test("releasing B's known session from A's URL never reaches the controller", async () => {
    const a = await createProject({ userId: 'owner_a', platform: 'swift' });
    const b = await createProject({ userId: 'owner_b', platform: 'swift' });
    recordSwiftPreviewSession('sess_b', 'owner_b', b.id);
    const hit = vi.fn();
    server.use(http.delete('https://sim.test/api/sessions/:id', () => (hit(), new HttpResponse(null, { status: 204 }))));
    await signInAs('owner_a', { plan: 'max' });
    const res = await callRoute(previewSessionRoute.DELETE, {
      method: 'DELETE',
      params: { id: a.id, sessionId: 'sess_b' },
    });
    expect(res.status).toBe(204);
    expect(hit).not.toHaveBeenCalled();
  });
});
