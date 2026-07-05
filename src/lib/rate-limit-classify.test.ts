/**
 * Unit tests for the method-aware route→bucket classifier. This table IS the
 * production incident guard: the 2026-07-01 softban happened because workspace
 * polling GETs were classified into 'write' (60/min) — one open workspace
 * polls ~120+ req/min, so the bucket never recovered and real mutations
 * (model select, project list) 429'd. These tests pin every polling endpoint
 * to its poll bucket and every interactive read/write to its own.
 *
 * Run with: node --import tsx --test src/lib/rate-limit-classify.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyApiRequest } from './rate-limit-classify';

const PID = 'proj_123';

describe('workspace polling GETs → poll buckets (the incident class)', () => {
  test('preview-state GET → poll', () => {
    assert.equal(classifyApiRequest('GET', `/api/projects/${PID}/sandbox/preview-state`), 'poll');
  });

  test('env request GET → poll, but POST/DELETE stay write', () => {
    assert.equal(classifyApiRequest('GET', `/api/projects/${PID}/env/request`), 'poll');
    assert.equal(classifyApiRequest('POST', `/api/projects/${PID}/env/request`), 'write');
    assert.equal(classifyApiRequest('DELETE', `/api/projects/${PID}/env/request`), 'write');
  });

  test('convex oauth-provider-status GET → poll', () => {
    assert.equal(classifyApiRequest('GET', `/api/projects/${PID}/convex/oauth-provider-status`), 'poll');
  });

  test('stripe connect-request GET → poll, DELETE → write', () => {
    assert.equal(classifyApiRequest('GET', `/api/projects/${PID}/stripe/connect-request`), 'poll');
    assert.equal(classifyApiRequest('DELETE', `/api/projects/${PID}/stripe/connect-request`), 'write');
  });

  test('swift-preview state GET → poll', () => {
    assert.equal(classifyApiRequest('GET', `/api/projects/${PID}/swift-preview/state`), 'poll');
  });

  test('sandbox files GET (signature + content) → pollHeavy, PUT → write', () => {
    assert.equal(classifyApiRequest('GET', `/api/projects/${PID}/sandbox/files`), 'pollHeavy');
    assert.equal(classifyApiRequest('PUT', `/api/projects/${PID}/sandbox/files`), 'write');
  });
});

describe('interactive project reads/writes stay isolated from polling', () => {
  test('GET /api/projects (projects page) → read', () => {
    assert.equal(classifyApiRequest('GET', '/api/projects'), 'read');
  });

  test('GET /api/projects/:id → read', () => {
    assert.equal(classifyApiRequest('GET', `/api/projects/${PID}`), 'read');
  });

  test('PATCH /api/projects/:id (model select) → write', () => {
    assert.equal(classifyApiRequest('PATCH', `/api/projects/${PID}`), 'write');
  });

  test('POST /api/projects (create) → write; DELETE → write', () => {
    assert.equal(classifyApiRequest('POST', '/api/projects'), 'write');
    assert.equal(classifyApiRequest('DELETE', `/api/projects/${PID}`), 'write');
  });
});

describe('existing tiers preserved', () => {
  test('agent routes', () => {
    assert.equal(classifyApiRequest('POST', '/api/agent'), 'agent');
    assert.equal(classifyApiRequest('POST', '/api/agent/claude-code'), 'claudeCode');
  });

  test('oauth flows keep their buckets regardless of method (callbacks are GETs)', () => {
    assert.equal(classifyApiRequest('GET', '/api/oauth/github/callback'), 'oauthExchange');
    assert.equal(classifyApiRequest('POST', '/api/oauth/claude/exchange'), 'oauthExchange');
    assert.equal(classifyApiRequest('GET', '/api/oauth/github/start'), 'oauthStart');
    assert.equal(classifyApiRequest('GET', '/api/oauth/codex/poll'), 'oauthPoll');
    assert.equal(classifyApiRequest('GET', '/api/stripe/oauth/callback'), 'oauthExchange');
    assert.equal(classifyApiRequest('GET', '/api/stripe/oauth/start'), 'oauthStart');
  });

  test('deploy mutations', () => {
    assert.equal(classifyApiRequest('POST', `/api/projects/${PID}/sandbox/publish`), 'deploy');
    assert.equal(classifyApiRequest('POST', `/api/projects/${PID}/convex/deploy`), 'deploy');
    assert.equal(classifyApiRequest('POST', '/api/convex/provision'), 'deploy');
    assert.equal(classifyApiRequest('POST', `/api/projects/${PID}/swift-preview/build`), 'deploy');
    // swift-preview/state must NOT be swallowed by the swift deploy rule
    assert.notEqual(classifyApiRequest('GET', `/api/projects/${PID}/swift-preview/state`), 'deploy');
  });

  test('expensive sandbox operations (any method)', () => {
    assert.equal(classifyApiRequest('POST', `/api/projects/${PID}/sandbox/exec`), 'expensive');
    assert.equal(classifyApiRequest('POST', `/api/projects/${PID}/sandbox/session`), 'expensive');
    assert.equal(classifyApiRequest('POST', `/api/projects/${PID}/sandbox/devserver`), 'expensive');
    assert.equal(classifyApiRequest('POST', `/api/projects/${PID}/git/push`), 'expensive');
  });

  test('uploads and snapshots', () => {
    assert.equal(classifyApiRequest('POST', '/api/uploadthing'), 'upload');
    assert.equal(classifyApiRequest('POST', `/api/projects/${PID}/snapshot`), 'upload');
  });

  test('public surface', () => {
    assert.equal(classifyApiRequest('GET', '/api/public/projects/some-slug/source'), 'publicHeavy');
    assert.equal(classifyApiRequest('GET', '/api/og/some-image'), 'publicHeavy');
    assert.equal(classifyApiRequest('GET', '/api/public/projects/some-slug'), 'public');
  });

  test('usage/user reads', () => {
    assert.equal(classifyApiRequest('GET', '/api/usage/claude-plan'), 'read');
    assert.equal(classifyApiRequest('GET', '/api/user/plan'), 'read');
  });
});

describe('fallbacks and method semantics', () => {
  test('unknown API route → global regardless of method', () => {
    assert.equal(classifyApiRequest('GET', '/api/some-new-thing'), 'global');
    assert.equal(classifyApiRequest('POST', '/api/some-new-thing'), 'global');
  });

  test('HEAD/OPTIONS count as reads', () => {
    assert.equal(classifyApiRequest('HEAD', '/api/projects'), 'read');
    assert.equal(classifyApiRequest('OPTIONS', `/api/projects/${PID}/env/request`), 'poll');
  });

  test('method casing is normalized', () => {
    assert.equal(classifyApiRequest('get', '/api/projects'), 'read');
    assert.equal(classifyApiRequest('patch', `/api/projects/${PID}`), 'write');
  });

  test('chat GET → read, chat mutations → write (incl. bare /api/chat)', () => {
    assert.equal(classifyApiRequest('GET', '/api/chat'), 'read');
    assert.equal(classifyApiRequest('DELETE', '/api/chat'), 'write');
    assert.equal(classifyApiRequest('POST', '/api/chat-images/upload'), 'write');
  });
});
