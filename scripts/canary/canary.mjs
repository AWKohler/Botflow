#!/usr/bin/env node
/**
 * Live canary for botflow.io — drives the production app over HTTP exactly
 * like the browser does, with a dedicated test account, and cleans up after
 * itself. Dependency-free (Node >= 22: global fetch).
 *
 *   node canary.mjs daily     # subscription models on Claude Code + OpenCode
 *   node canary.mjs weekly    # cheapest model per other provider (platform keys)
 *   node canary.mjs sweep     # only clean up leftovers from earlier runs
 *
 * Per harness group: create a project (no backend) → boot the sandbox → seed
 * → start the dev server → preview URL answers → for each model: new thread,
 * one tiny deterministic turn ("write <nonce> to canary/check-<model>.txt"),
 * verify the file through the files API → delete the project and require the
 * server to report the sandbox released → project 404s.
 *
 * Every project created is recorded in a ledger BEFORE use and removed only
 * after a confirmed delete, so a crashed run is cleaned up by the next one.
 * The account is canary-only; as a second guard only projects named
 * "[canary] …" and owned by it are ever deleted.
 *
 * Config: ~/botflow-canary/config.json (see README.md). The account password
 * is read from the macOS login keychain at run time and never written out.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── Config ──────────────────────────────────────────────────────────────

const HOME = os.homedir();
const ROOT = process.env.CANARY_HOME ?? path.join(HOME, 'botflow-canary');
const STATE = path.join(ROOT, 'state');
const LEDGER = path.join(STATE, 'ledger.json');
const config = {
  baseUrl: 'https://botflow.io',
  email: 'aronneyt+canary@gmail.com',
  keychainService: 'botflow-canary',
  keychainPath: path.join(HOME, 'Library/Keychains/login.keychain-db'),
  ntfyTopic: null,
  ...readJson(path.join(ROOT, 'config.json'), {}),
};

const PREFIX = '[canary]';
const MODEL_RETRIES = 1; // one retry per model cell to filter one-off flakes

/** Harness groups. Anthropic → Claude Code, everything else → OpenCode. */
const SUITES = {
  // Paid via the account's Claude + ChatGPT subscriptions (personal creds →
  // zero platform credits). Fable 5.1 and GPT-6 Astra deliberately excluded.
  daily: [
    { harness: 'claude-code', models: ['claude-sonnet-5-5', 'claude-opus-5-5'], subscription: true },
    { harness: 'opencode', models: ['gpt-6-luna', 'gpt-6.1-sol'], subscription: true },
  ],
  // Cheapest model per remaining provider, on platform keys (the account has
  // no keys of its own, so these run in platform mode and use its credits).
  weekly: [
    { harness: 'opencode', models: ['gemini-3.1-pro-preview', 'grok-4.7', 'fireworks-minimax-m3'], subscription: false },
  ],
};

const TIMEOUTS = {
  request: 60_000,
  boot: 4 * 60_000, // session + seed + dev server (pnpm install on first boot)
  turnStream: 6 * 60_000, // route maxDuration is 300s; bridge may outlive it
  turnTotal: 12 * 60_000,
};

// ─── Small utilities ─────────────────────────────────────────────────────

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function log(...args) {
  console.log(`[${nowIso()}]`, ...args);
}

class CanaryError extends Error {
  constructor(phase, message) {
    super(`${phase}: ${message}`);
    this.phase = phase;
  }
}

// ─── HTTP session ────────────────────────────────────────────────────────

const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function api(method, urlPath, body, { timeoutMs = TIMEOUTS.request, raw = false } = {}) {
  const res = await fetch(`${config.baseUrl}${urlPath}`, {
    method,
    headers: {
      origin: config.baseUrl,
      cookie: cookieHeader(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  absorbCookies(res);
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

function readPassword() {
  try {
    return execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', config.keychainService, '-a', config.email, '-w', config.keychainPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch (e) {
    throw new CanaryError(
      'preflight',
      `could not read the password from the login keychain (exit ${e.status}). ` +
        'Runs must happen inside the logged-in session (LaunchAgent), not over SSH.',
    );
  }
}

async function signIn() {
  const r = await api('POST', '/api/auth/sign-in/email', { email: config.email, password: readPassword() });
  if (r.status !== 200) throw new CanaryError('preflight', `sign-in returned ${r.status}: ${r.text.slice(0, 200)}`);
  const me = await api('GET', '/api/identity/me');
  const userId = me.json?.id ?? me.json?.user?.id ?? me.json?.userId;
  if (!userId) throw new CanaryError('preflight', `could not resolve the signed-in user (${me.status})`);
  return userId;
}

// ─── Ledger (crash-safe cleanup) ─────────────────────────────────────────

function ledger() {
  return readJson(LEDGER, { projects: {} });
}

function ledgerAdd(id, entry) {
  const l = ledger();
  l.projects[id] = entry;
  writeJsonAtomic(LEDGER, l);
}

function ledgerRemove(id) {
  const l = ledger();
  delete l.projects[id];
  writeJsonAtomic(LEDGER, l);
}

/** Delete one canary project; returns the server's cleanup report. */
async function deleteProject(id) {
  const r = await api('DELETE', `/api/projects/${id}`, undefined, { timeoutMs: 3 * 60_000 });
  if (r.status === 404) {
    ledgerRemove(id);
    return { alreadyGone: true };
  }
  if (r.status !== 200) throw new CanaryError('cleanup', `DELETE project ${id} → ${r.status}: ${r.text.slice(0, 200)}`);
  const gone = await api('GET', `/api/projects/${id}`);
  if (gone.status !== 404) throw new CanaryError('cleanup', `project ${id} still readable after delete (${gone.status})`);
  ledgerRemove(id);
  const cleanup = r.json?.cleanup ?? null;
  if (cleanup?.sandbox === 'failed') throw new CanaryError('cleanup', `project ${id} deleted but its sandbox was NOT released`);
  return cleanup;
}

/** Remove leftovers: everything in the ledger, plus any "[canary]" project
 *  this (canary-only) account still owns. */
async function sweep(userId) {
  const problems = [];
  for (const id of Object.keys(ledger().projects)) {
    try {
      await deleteProject(id);
      log(`sweep: removed ledger project ${id}`);
    } catch (e) {
      problems.push(e.message);
    }
  }
  const list = await api('GET', '/api/projects');
  if (list.status === 200 && Array.isArray(list.json)) {
    for (const p of list.json) {
      if (p.userId !== userId || typeof p.name !== 'string' || !p.name.startsWith(PREFIX)) continue;
      try {
        await deleteProject(p.id);
        log(`sweep: removed stray project ${p.id} (${p.name})`);
      } catch (e) {
        problems.push(e.message);
      }
    }
  } else {
    problems.push(`sweep: could not list projects (${list.status})`);
  }
  return problems;
}

// ─── Steps ───────────────────────────────────────────────────────────────

async function preflight(suite) {
  const s = await api('GET', '/api/user-settings');
  const flags = s.json?.settings ?? s.json ?? {};
  const t = await api('GET', '/api/usage/tier');
  const missing = [];
  if (suite === 'daily') {
    if (!flags.hasClaudeOAuth) missing.push('Claude subscription not connected');
    if (!flags.hasCodexOAuth) missing.push('ChatGPT subscription not connected');
  }
  if (t.json?.tier === 'free') missing.push('account is on the Free tier (expected Pro)');
  if (missing.length) throw new CanaryError('preflight', missing.join('; '));
}

async function createProject(runId, harness) {
  const name = `${PREFIX} ${runId} ${harness}`;
  const r = await api('POST', '/api/projects', { name, platform: 'sandboxed-web', backendType: 'none' });
  if (r.status !== 201 || !r.json?.id) throw new CanaryError('create-project', `${r.status}: ${r.text.slice(0, 200)}`);
  ledgerAdd(r.json.id, { runId, name, createdAt: nowIso() });
  return r.json;
}

async function bootSandbox(projectId) {
  const deadline = Date.now() + TIMEOUTS.boot;
  for (;;) {
    const s = await api('POST', `/api/projects/${projectId}/sandbox/session`, undefined, { timeoutMs: TIMEOUTS.boot });
    if (s.status === 200) break;
    if (s.status !== 503 || Date.now() > deadline) {
      throw new CanaryError('sandbox-boot', `session ${s.status}: ${s.text.slice(0, 200)}`);
    }
    await sleep(15_000);
  }
  const seed = await api('POST', `/api/projects/${projectId}/sandbox/seed`, undefined, { timeoutMs: TIMEOUTS.boot });
  if (seed.status !== 200) throw new CanaryError('sandbox-seed', `${seed.status}: ${seed.text.slice(0, 200)}`);
  const dev = await api('POST', `/api/projects/${projectId}/sandbox/devserver`, { port: 5173, installFirst: true }, {
    timeoutMs: TIMEOUTS.boot,
  });
  if (dev.status !== 200 || !dev.json?.previewUrl) {
    throw new CanaryError('dev-server', `${dev.status}: ${(dev.json?.error ?? dev.text).slice(0, 300)}`);
  }
  const preview = await fetch(dev.json.previewUrl, { signal: AbortSignal.timeout(TIMEOUTS.request) });
  if (!preview.ok) throw new CanaryError('preview', `preview URL answered ${preview.status}`);
  return dev.json.previewUrl;
}

async function weeklyCreditsUsed() {
  const r = await api('GET', '/api/usage/credits');
  return typeof r.json?.weeklyUsed === 'number' ? r.json.weeklyUsed : null;
}

/** Read the UI message stream to the end; returns the assistant text and any error part. */
async function readTurnStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let error = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const part = JSON.parse(data);
        if (part.type === 'text-delta' && typeof part.delta === 'string') text += part.delta;
        if (part.type === 'error') error = part.errorText ?? JSON.stringify(part);
      } catch {
        /* keep-alive / non-JSON */
      }
    }
  }
  return { text, error };
}

async function waitForTurnEnd(projectId, threadId, deadline) {
  for (;;) {
    const r = await api(
      'GET',
      `/api/agent/claude-code/turn-status?projectId=${encodeURIComponent(projectId)}&threadId=${encodeURIComponent(threadId)}`,
    );
    if (r.json?.endedNormally) return;
    if (r.status === 200 && r.json?.turnId && !r.json.active) {
      throw new CanaryError('agent-turn', 'bridge exited without finishing the turn');
    }
    if (Date.now() > deadline) throw new CanaryError('agent-turn', 'turn did not finish in time');
    await sleep(10_000);
  }
}

async function runModel(projectId, harness, model) {
  const t = await api('POST', `/api/projects/${projectId}/threads`, { model });
  const threadId = t.json?.thread?.id;
  if (!threadId) throw new CanaryError('create-thread', `${t.status}: ${t.text.slice(0, 200)}`);

  const nonce = `canary-${randomBytes(6).toString('hex')}`;
  const file = `canary/check-${model.replace(/[^a-z0-9.-]/gi, '_')}.txt`;
  const prompt =
    `This is an automated health check. Create the file \`${file}\` (relative to the project root) ` +
    `whose entire content is exactly: ${nonce}\n` +
    'Do not change any other file, do not start or restart servers, and do not run builds. ' +
    `When the file is written, reply with only: DONE ${nonce}`;

  const endpoint = harness === 'claude-code' ? '/api/agent/claude-code' : '/api/agent/opencode';
  const deadline = Date.now() + TIMEOUTS.turnTotal;
  const res = await api(
    'POST',
    endpoint,
    {
      projectId,
      platform: 'sandboxed-web',
      threadId,
      messages: [{ id: `msg-${nonce}`, role: 'user', parts: [{ type: 'text', text: prompt }] }],
    },
    { raw: true, timeoutMs: TIMEOUTS.turnStream },
  );
  if (!res.ok) {
    throw new CanaryError('agent-turn', `${endpoint} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  let streamed;
  try {
    streamed = await readTurnStream(res);
  } catch (e) {
    // Route paginates at maxDuration; the bridge keeps going — fall through to polling.
    streamed = { text: '', error: null, cut: String(e) };
  }
  if (streamed.error) throw new CanaryError('agent-turn', `stream error: ${streamed.error.slice(0, 300)}`);
  await waitForTurnEnd(projectId, threadId, deadline);

  const f = await api('GET', `/api/projects/${projectId}/sandbox/files?path=${encodeURIComponent(file)}`);
  if (f.status !== 200) throw new CanaryError('verify-file', `${file} → ${f.status}`);
  if ((f.json?.content ?? '').trim() !== nonce) {
    throw new CanaryError('verify-file', `${file} has unexpected content: ${JSON.stringify((f.json?.content ?? '').slice(0, 80))}`);
  }
  return { replyHadNonce: streamed.text.includes(nonce) };
}

// ─── Run ─────────────────────────────────────────────────────────────────

async function runGroup(runId, group, results) {
  const started = Date.now();
  let project = null;
  try {
    project = await createProject(runId, group.harness);
    const previewUrl = await bootSandbox(project.id);
    results.push({ cell: `${group.harness}/sandbox`, ok: true, ms: Date.now() - started, previewUrl });

    for (const model of group.models) {
      const cellStart = Date.now();
      const before = group.subscription ? await weeklyCreditsUsed() : null;
      let lastError = null;
      let detail = null;
      for (let attempt = 0; attempt <= MODEL_RETRIES; attempt++) {
        try {
          detail = await runModel(project.id, group.harness, model);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          log(`${group.harness}/${model} attempt ${attempt + 1} failed: ${e.message}`);
        }
      }
      const cell = { cell: `${group.harness}/${model}`, ok: !lastError, ms: Date.now() - cellStart };
      if (lastError) cell.error = lastError.message;
      if (detail) cell.replyHadNonce = detail.replyHadNonce;
      if (!lastError && group.subscription && before !== null) {
        const after = await weeklyCreditsUsed();
        if (after !== null && after > before) {
          cell.ok = false;
          cell.error = `subscription turn charged platform credits (${before} → ${after})`;
        }
      }
      results.push(cell);
      log(`${cell.ok ? 'PASS' : 'FAIL'} ${cell.cell}${cell.error ? ` — ${cell.error}` : ''}`);
    }
  } catch (e) {
    results.push({ cell: `${group.harness}/${e.phase ?? 'setup'}`, ok: false, error: e.message, ms: Date.now() - started });
    log(`FAIL ${group.harness} — ${e.message}`);
  } finally {
    if (project) {
      try {
        const cleanup = await deleteProject(project.id);
        results.push({ cell: `${group.harness}/cleanup`, ok: true, cleanup });
      } catch (e) {
        results.push({ cell: `${group.harness}/cleanup`, ok: false, error: e.message });
        log(`FAIL ${group.harness}/cleanup — ${e.message}`);
      }
    }
  }
}

async function notify(title, message, failed) {
  if (!config.ntfyTopic) return;
  try {
    await fetch(`https://ntfy.sh/${config.ntfyTopic}`, {
      method: 'POST',
      headers: { title, priority: failed ? 'high' : 'default', tags: failed ? 'rotating_light' : 'white_check_mark' },
      body: message,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    log(`notify failed: ${e.message}`);
  }
}

async function main() {
  const suite = process.argv[2] ?? 'daily';
  if (!['daily', 'weekly', 'sweep'].includes(suite)) {
    console.error('usage: canary.mjs daily|weekly|sweep');
    process.exit(2);
  }
  const runId = `${suite}-${nowIso().replace(/[:.]/g, '-')}`;
  const results = [];
  const started = Date.now();
  log(`run ${runId} against ${config.baseUrl}`);

  let fatal = null;
  try {
    const userId = await signIn();
    const leftovers = await sweep(userId);
    for (const p of leftovers) results.push({ cell: 'sweep', ok: false, error: p });
    if (suite !== 'sweep') {
      await preflight(suite);
      for (const group of SUITES[suite]) await runGroup(runId, group, results);
      const after = await sweep(userId);
      for (const p of after) results.push({ cell: 'final-sweep', ok: false, error: p });
    }
  } catch (e) {
    fatal = e.message;
    results.push({ cell: e.phase ?? 'run', ok: false, error: e.message });
    log(`FATAL ${e.message}`);
  }

  const failed = results.filter((r) => !r.ok);
  const summary = {
    runId,
    suite,
    baseUrl: config.baseUrl,
    ok: failed.length === 0,
    ms: Date.now() - started,
    fatal,
    results,
  };
  writeJsonAtomic(path.join(STATE, 'runs', `${runId}.json`), summary);
  writeJsonAtomic(path.join(STATE, `last-${suite}.json`), summary);

  const prev = readJson(path.join(STATE, `prev-status-${suite}.json`), { ok: true });
  writeJsonAtomic(path.join(STATE, `prev-status-${suite}.json`), { ok: summary.ok, at: nowIso() });
  if (!summary.ok) {
    await notify(
      `Botflow canary FAILED (${suite})`,
      failed.map((f) => `✗ ${f.cell}: ${f.error}`).join('\n').slice(0, 3500),
      true,
    );
  } else if (!prev.ok) {
    await notify(`Botflow canary recovered (${suite})`, `${results.length} checks passed`, false);
  }

  log(`${summary.ok ? 'OK' : 'FAILED'} — ${results.length - failed.length}/${results.length} checks passed in ${Math.round(summary.ms / 1000)}s`);
  process.exit(summary.ok ? 0 : 1);
}

await main();
