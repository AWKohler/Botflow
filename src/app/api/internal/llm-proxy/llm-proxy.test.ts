/**
 * LLM proxy route: the only path by which in-sandbox agents reach model
 * providers. Guards: token auth + provider binding, path allowlist, model
 * allowlist, credential injection (real keys never leave the server),
 * reserve-before-forward and settle-to-actual billing.
 */
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { usageRecords } from '@/db/schema';
import { currentPeriod, currentWeekKey } from '@/lib/credits';
import { mintLlmProxyToken, revokeLlmProxyToken, type LlmProxyBinding } from '@/lib/agent/llm-proxy/token';
import { createUser } from '@/test/auth';
import { currentTestDb, setupTestDb } from '@/test/db';
import { server } from '@/test/network';
import { callRoute } from '@/test/route';
import { fakeRedis } from '@/test/redis-fake';
import { POST } from './[provider]/[...path]/route';

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-PLATFORM-SECRET';
  process.env.OPENAI_API_KEY = 'sk-openai-PLATFORM-SECRET';
});

setupTestDb();
afterEach(() => vi.useRealTimers());

const USER = 'user_proxy';
const MODEL = 'claude-sonnet-5-5';

function binding(overrides: Partial<LlmProxyBinding> = {}): LlmProxyBinding {
  return {
    userId: USER,
    projectId: '00000000-0000-4000-8000-0000000000aa',
    turnId: 'turn_1',
    provider: 'anthropic',
    credMode: 'platform',
    modelId: MODEL,
    modelAllowlist: [MODEL],
    ...overrides,
  } as LlmProxyBinding;
}

type Upstream = { url: string; headers: Headers; body: Record<string, unknown> | null };

function mockAnthropic(opts: { status?: number; usage?: { input_tokens: number; output_tokens: number } } = {}) {
  const calls: Upstream[] = [];
  server.use(
    http.post('https://api.anthropic.com/*', async ({ request }) => {
      const text = await request.text();
      calls.push({ url: request.url, headers: request.headers, body: text ? JSON.parse(text) : null });
      if (opts.status && opts.status >= 400) {
        return HttpResponse.json({ type: 'error', error: { message: 'upstream down' } }, { status: opts.status });
      }
      return HttpResponse.json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: 'hi' }],
        usage: opts.usage ?? { input_tokens: 1_000, output_tokens: 200 },
      });
    }),
  );
  return calls;
}

function seedCredits(weekly: number, monthly: number) {
  void fakeRedis.set(`wcred:${USER}:${currentWeekKey()}`, weekly);
  void fakeRedis.set(`mcred:${USER}:${currentPeriod()}`, monthly);
}

async function counters() {
  return {
    w: Number(await fakeRedis.get(`wcred:${USER}:${currentWeekKey()}`)),
    m: Number(await fakeRedis.get(`mcred:${USER}:${currentPeriod()}`)),
  };
}

async function proxyCall(opts: {
  token?: string | null;
  provider?: string;
  path?: string[];
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const provider = opts.provider ?? 'anthropic';
  const path = opts.path ?? ['v1', 'messages'];
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers['x-api-key'] = opts.token;
  return callRoute(POST as never, {
    method: 'POST',
    path: `/api/internal/llm-proxy/${provider}/${path.join('/')}`,
    params: { provider, path },
    body: opts.body ?? { model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
    headers,
  });
}

async function paidUser() {
  await createUser({ id: USER, publicMetadata: { plan: 'pro' } });
}

describe('token auth', () => {
  test.each([
    ['no token', null],
    ['not a bfap_ token', 'sk-ant-something'],
    ['unknown bfap_ token', 'bfap_made_up'],
  ])('%s → 401, nothing forwarded', async (_label, token) => {
    const calls = mockAnthropic();
    const res = await proxyCall({ token });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('revoked token → 401', async () => {
    const calls = mockAnthropic();
    const token = await mintLlmProxyToken(binding());
    await revokeLlmProxyToken(token);
    expect((await proxyCall({ token })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('both a token and a provider key in headers → token is read from Authorization', async () => {
    const calls = mockAnthropic();
    const token = await mintLlmProxyToken(binding());
    // A provider key in Authorization is never mistaken for, or merged with, the token.
    const res = await proxyCall({ token, headers: { authorization: 'Bearer sk-ant-whatever' } });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('token expires after 30 idle minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const calls = mockAnthropic();
    const token = await mintLlmProxyToken(binding());
    vi.setSystemTime(Date.now() + 30 * 60_000 + 1);
    expect((await proxyCall({ token })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('an anthropic token cannot call openai', async () => {
    const token = await mintLlmProxyToken(binding());
    const res = await proxyCall({ token, provider: 'openai', path: ['v1', 'chat', 'completions'] });
    expect(res.status).toBe(401);
  });

  test('unknown provider → 404', async () => {
    const token = await mintLlmProxyToken(binding());
    expect((await proxyCall({ token, provider: 'evil' })).status).toBe(404);
  });
});

describe('path allowlist', () => {
  test.each([
    [['v1', '..', '..', 'admin']],
    [['..', 'v1', 'messages']],
    [['v2', 'messages']],
    [['%2e%2e', 'v1']],
  ])('anthropic %j → refused or kept on the provider host', async (path) => {
    await paidUser();
    const calls = mockAnthropic();
    const token = await mintLlmProxyToken(binding());
    const res = await proxyCall({ token, path });
    for (const c of calls) expect(new URL(c.url).host).toBe('api.anthropic.com');
    if (res.status === 404) expect(calls).toEqual([]);
  });

  test.each([
    [['v1', 'files']],
    [['v1', 'responses', '..', 'files']],
    [['v1', 'chat', 'completions', 'x']],
    [['v1', 'organization', 'api_keys']],
  ])('openai %j → 404, nothing forwarded', async (path) => {
    const token = await mintLlmProxyToken(binding({ provider: 'openai' as never }));
    const res = await proxyCall({ token, provider: 'openai', path, body: { model: MODEL } });
    expect(res.status).toBe(404);
  });
});

describe('platform mode', () => {
  test('off-allowlist model → 403 before any reservation or upstream call', async () => {
    await paidUser();
    seedCredits(0, 0);
    const calls = mockAnthropic();
    const token = await mintLlmProxyToken(binding());
    const res = await proxyCall({ token, body: { model: 'claude-fable-5-1', max_tokens: 10, messages: [] } });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect(await counters()).toEqual({ w: 0, m: 0 });
  });

  test('body without a top-level model (e.g. Message Batches) → 403', async () => {
    await paidUser();
    const calls = mockAnthropic();
    const token = await mintLlmProxyToken(binding());
    const res = await proxyCall({
      token,
      path: ['v1', 'messages', 'batches'],
      body: { requests: [{ custom_id: 'a', params: { model: 'claude-fable-5-1', max_tokens: 64000, messages: [] } }] },
    });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test('credits exhausted → 402 in Anthropic error dialect, nothing forwarded', async () => {
    await paidUser();
    seedCredits(10_000_000_000, 10_000_000_000);
    const calls = mockAnthropic();
    const token = await mintLlmProxyToken(binding());
    const res = await proxyCall({ token });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
    expect(calls).toEqual([]);
  });

  test('output cap is clamped server-side', async () => {
    await paidUser();
    seedCredits(0, 0);
    const calls = mockAnthropic();
    const token = await mintLlmProxyToken(binding());
    await (await proxyCall({ token, body: { model: MODEL, max_tokens: 10_000_000, messages: [] } })).text();
    expect(calls[0].body?.max_tokens).toBeLessThan(10_000_000);
  });

  test('platform key injected upstream; sandbox token and spoofed headers are not forwarded', async () => {
    await paidUser();
    seedCredits(0, 0);
    const calls = mockAnthropic();
    const token = await mintLlmProxyToken(binding());
    const res = await proxyCall({
      token,
      headers: {
        authorization: `Bearer ${token}`,
        cookie: '__session=victim',
        'x-forwarded-for': '1.2.3.4',
        'x-vercel-protection-bypass': 'secret',
        'anthropic-version': '2023-06-01',
      },
    });
    const text = await res.text();
    const up = calls[0].headers;
    expect(up.get('x-api-key')).toBe('sk-ant-PLATFORM-SECRET');
    expect(up.get('authorization')).toBeNull();
    expect(up.get('cookie')).toBeNull();
    expect(up.get('x-forwarded-for')).toBeNull();
    expect(up.get('x-vercel-protection-bypass')).toBeNull();
    expect(up.get('anthropic-version')).toBe('2023-06-01');
    expect(text).not.toContain('PLATFORM-SECRET');
    for (const [, v] of res.headers) expect(v).not.toContain('PLATFORM-SECRET');
  });

  test('reserves before forwarding, settles to metered usage after', async () => {
    await paidUser();
    seedCredits(0, 0);
    let duringUpstream: { w: number; m: number } | null = null;
    server.use(
      http.post('https://api.anthropic.com/v1/messages', async () => {
        duringUpstream = await counters();
        // Realistic for the request: tiny prompt, under its max_tokens (100).
        return HttpResponse.json({
          id: 'msg_1', type: 'message', model: MODEL, content: [],
          usage: { input_tokens: 20, output_tokens: 50 },
        });
      }),
    );
    const token = await mintLlmProxyToken(binding());
    const res = await proxyCall({ token });
    expect(res.status).toBe(200);
    await res.text();

    expect(duringUpstream!.w).toBeGreaterThan(0); // reservation was in place
    await vi.waitFor(async () => {
      const rows = await currentTestDb().select().from(usageRecords);
      expect(rows.length).toBeGreaterThan(0);
    });
    const { w, m } = await counters();
    expect(w).toBe(m);
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(duringUpstream!.w); // settled down from the worst-case reservation
  });

  test.each([500, 529, 429])('upstream %i → reservation fully released', async (status) => {
    await paidUser();
    seedCredits(0, 0);
    mockAnthropic({ status });
    const token = await mintLlmProxyToken(binding());
    const res = await proxyCall({ token });
    expect(res.status).toBe(status);
    await res.text();
    await vi.waitFor(async () => expect(await counters()).toEqual({ w: 0, m: 0 }));
  });

  test('upstream unreachable → 502 and reservation released', async () => {
    await paidUser();
    seedCredits(0, 0);
    server.use(http.post('https://api.anthropic.com/*', () => HttpResponse.error()));
    const token = await mintLlmProxyToken(binding());
    const res = await proxyCall({ token });
    expect(res.status).toBe(502);
    expect(await counters()).toEqual({ w: 0, m: 0 });
  });
});

describe('BYOK mode', () => {
  test("the user's stored key is injected; a key in the request is ignored; nothing is billed", async () => {
    await createUser({ id: USER, privateMetadata: { anthropicApiKey: 'sk-ant-USER-BYOK' } });
    seedCredits(0, 0);
    const calls = mockAnthropic();
    const token = await mintLlmProxyToken(binding({ credMode: 'byok' }));
    // Token as bearer; a sandbox-supplied provider key in x-api-key must be replaced.
    const res = await proxyCall({ headers: { authorization: `Bearer ${token}`, 'x-api-key': 'sk-ant-ATTACKER' } });
    await res.text();
    expect(calls[0].headers.get('x-api-key')).toBe('sk-ant-USER-BYOK');
    expect(JSON.stringify([...calls[0].headers])).not.toContain('ATTACKER');
    expect(await counters()).toEqual({ w: 0, m: 0 });
  });

  test('missing BYOK key → 401, never falls back to the platform key', async () => {
    await createUser({ id: USER, privateMetadata: { openaiApiKey: 'unrelated' } });
    const calls = mockAnthropic();
    const token = await mintLlmProxyToken(binding({ credMode: 'byok' }));
    const res = await proxyCall({ token });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
