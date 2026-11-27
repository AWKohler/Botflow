/**
 * The routing the sender's page showed must survive the thread queue: the
 * queue route stores it, and the server-started turn receives it as
 * expectedRoutingReason (otherwise a shared-project OpenAI turn the user
 * already saw explained would be refused).
 */
import { describe, expect, test, vi } from 'vitest';
import { chatSessions } from '@/db/schema';
import { signInAs } from '@/test/auth';
import { currentTestDb, setupTestDb } from '@/test/db';
import { createProject } from '@/test/factories';
import { callRoute } from '@/test/route';

const started = vi.hoisted(() => ({ ctx: [] as Array<{ expectedRoutingReason?: string }> }));
const fakeStart = vi.hoisted(() => async (ctx: { expectedRoutingReason?: string }) => {
  started.ctx.push(ctx);
  return { ok: true as const, turnId: 'turn_1', threadId: 'x', toResponse: () => new Response(null) };
});
vi.mock('./turn-start/opencode', () => ({ startOpenCodeTurn: fakeStart }));
vi.mock('./turn-start/claude-code', () => ({ startClaudeCodeTurn: fakeStart }));

setupTestDb();

const OWNER = 'user_owner';

async function setup() {
  const p = await createProject({ userId: OWNER, model: 'gpt-6.1-sol' });
  const [t] = await currentTestDb().insert(chatSessions).values({ projectId: p.id, createdBy: OWNER, model: 'gpt-6.1-sol' }).returning();
  await signInAs(OWNER);
  return { p, t };
}

describe('queued routing acknowledgement', () => {
  test('route → stored message → drained turn', async () => {
    started.ctx.length = 0;
    const { p, t } = await setup();
    const { POST } = await import('@/app/api/projects/[id]/threads/[threadId]/queue/route');
    const res = await callRoute(POST, {
      method: 'POST',
      params: { id: p.id, threadId: t.id },
      body: {
        message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata: { other: 'dropped' } },
        routingReason: 'codex_blocked_platform',
      },
    });
    expect(res.status).toBe(200);
    expect(started.ctx).toHaveLength(1);
    expect(started.ctx[0].expectedRoutingReason).toBe('codex_blocked_platform');

    const { chatThreadQueue } = await import('@/db/schema');
    const [row] = await currentTestDb().select().from(chatThreadQueue);
    // Only the routing key survives from client metadata.
    expect((row.message as { metadata?: unknown }).metadata).toEqual({ botflowRoutingReason: 'codex_blocked_platform' });
  });

  test('no routing reason → the turn gets none', async () => {
    started.ctx.length = 0;
    const { p, t } = await setup();
    const { POST } = await import('@/app/api/projects/[id]/threads/[threadId]/queue/route');
    await callRoute(POST, {
      method: 'POST',
      params: { id: p.id, threadId: t.id },
      body: { message: { id: 'm2', role: 'user', parts: [{ type: 'text', text: 'hi' }] } },
    });
    expect(started.ctx[0].expectedRoutingReason).toBeUndefined();
  });
});
