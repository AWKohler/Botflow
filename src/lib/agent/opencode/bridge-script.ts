/**
 * Source of the OpenCode bridge script that runs inside the Vercel Sandbox.
 *
 * Mirrors the CC bridge contract (src/lib/agent/claude-code/bridge-script.ts):
 * reads a JSON config from BOTFLOW_CONFIG_PATH, drives the agent, and streams
 * NDJSON events to stdout with the same envelope the route loop expects —
 *   { type: "ready" }
 *   { type: "session_started", sessionId }
 *   { type: "oc_event", event }                  (opencode Event, session-scoped)
 *   { type: "usage", tokens, breakdown, cost }   (from assistant message.updated)
 *   { type: "compact_boundary", trigger, preTokens }
 *   { type: "end_turn", aborted? }
 *   { type: "error", error }
 *
 * Mechanics (locked by the 1.17.13 integration spike — see
 * docs/features/opencode-agent.md):
 *  - Spawns a PER-TURN `opencode serve` on 127.0.0.1 with an explicit random
 *    high port (--port=0 is NOT honored), passing the full config inline via
 *    OPENCODE_CONFIG_CONTENT. The server dies with the bridge (process-group
 *    kill), so rotated per-turn credentials are never cached across turns;
 *    sessions persist on disk under ~/.local/share/opencode and resume by id.
 *  - Talks to the server with plain fetch + a minimal SSE reader on /event —
 *    deliberately NO @opencode-ai/sdk dependency in the sandbox (four trivial
 *    endpoints; fewer moving parts, no SDK/server version-skew surface).
 *  - Permissions are all-allow in config (the sandbox is the isolation
 *    boundary — same rationale as CC's bypassPermissions); permission.updated
 *    events get a defensive "always" reply as a backstop.
 *  - The builtin `question` tool is disabled per prompt; our MCP
 *    botflow_ask_question is the question primitive (renders the platform's
 *    QuestionPrompt UI via the host callback).
 *  - A MessageAbortedError on session.error is a NORMAL end (user abort), not
 *    an error. Aborts arrive via a sentinel file (or SIGTERM from the stop
 *    route / next turn's prepare script); the bridge polls the sentinel and
 *    calls POST /session/{id}/abort.
 *  - Turn-lifecycle parity with the CC bridge (v25): events are teed to
 *    BOTFLOW_EVENT_FILE so the host can re-attach after its streaming route
 *    dies at maxDuration; the pid is written to BOTFLOW_PID_FILE so the host
 *    can kill/probe this bridge across requests; SIGTERM aborts the session
 *    and nukes the opencode server process group.
 *
 * Bump OPENCODE_SCRIPTS_VERSION whenever THIS file or mcp-script.ts changes —
 * one marker covers both (they're written together by writeOpenCodeScripts).
 *
 * Config shape:
 *   {
 *     prompt: string,
 *     images?: { media_type: string, data: string }[],   // base64
 *     sessionId?: string,                                // resume if valid
 *     model: { providerID: string, modelID: string },
 *     cwd: string,                                       // /vercel/sandbox
 *     appendPromptPath: string,                          // instructions file
 *     opencodeBin: string,                               // absolute binary path
 *     abortPath: string,                                 // sentinel file
 *     mcp?: {
 *       scriptPath: string,
 *       apiBase: string,
 *       toolToken: string,
 *       tools: string[],
 *       oauthProviderIds: string[],
 *     },
 *   }
 */

export const OPENCODE_SCRIPTS_VERSION = "7";

export const OPENCODE_BRIDGE_SOURCE = `#!/usr/bin/env node
/* eslint-disable */
/**
 * Botflow OpenCode bridge. Generated file — the source of truth is
 * src/lib/agent/opencode/bridge-script.ts.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, access, unlink } from "node:fs/promises";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Tee every event to BOTFLOW_EVENT_FILE (in addition to stdout) — same
// contract as the CC bridge (v25): the file is what lets the host re-attach
// to this turn after its streaming route dies at maxDuration. The bridge
// (and the turn) keep going regardless.
const EVENT_FILE = process.env.BOTFLOW_EVENT_FILE || null;

function emit(event) {
  const line = JSON.stringify(event) + "\\n";
  process.stdout.write(line);
  if (EVENT_FILE) {
    try { appendFileSync(EVENT_FILE, line); } catch { /* tee is best-effort */ }
  }
}

function fail(message) {
  emit({ type: "error", error: message });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const configPath = process.env.BOTFLOW_CONFIG_PATH;
if (!configPath) fail("BOTFLOW_CONFIG_PATH env var is required");

let config;
try {
  config = JSON.parse(await readFile(configPath, "utf-8"));
} catch (err) {
  fail("Failed to read config file: " + (err && err.message ? err.message : String(err)));
}

const {
  prompt,
  images,
  sessionId: resumeSessionId,
  model,
  cwd,
  appendPromptPath,
  opencodeBin,
  abortPath,
  mcp,
  provider: providerConfig,
} = config;

if (!opencodeBin || !model || !model.providerID || !model.modelID) {
  fail("Config missing opencodeBin/model");
}

// Advertise our pid so the host can kill/probe this bridge from a later
// request — same contract as the CC bridge (one in-sandbox agent per
// project; the next turn's prepare script kills us first).
const pidFile = process.env.BOTFLOW_PID_FILE;
if (pidFile) {
  try {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, String(process.pid));
  } catch { /* liveness probing degrades gracefully without it */ }
}

emit({ type: "ready" });

// ---------------------------------------------------------------------------
// opencode.json — passed inline via OPENCODE_CONFIG_CONTENT (highest
// file-level precedence; nothing written into the user's project).
// The model is DECLARED explicitly: the binary's bundled models.dev snapshot
// lags our registry, and undeclared models don't resolve.
// ---------------------------------------------------------------------------
const ocConfig = {
  autoupdate: false,
  share: "disabled",
  permission: {
    edit: "allow",
    bash: "allow",
    webfetch: "allow",
    doom_loop: "allow",
    external_directory: "allow",
  },
  instructions: [appendPromptPath],
  // Pin the small model (title generation etc.) to the turn's model: its
  // calls transit the same proxied provider and must be priced/allowlisted.
  small_model: model.providerID + "/" + model.modelID,
  provider: {
    [model.providerID]: {
      // Proxied modes route the provider through /api/internal/llm-proxy
      // with the bfap_ token as the api key; codex-oauth mode has no
      // providerConfig (auth.json carries the real ChatGPT tokens).
      ...(providerConfig && providerConfig.baseURL
        ? {
            options: {
              baseURL: providerConfig.baseURL,
              apiKey: providerConfig.apiKey,
              ...(providerConfig.headers ? { headers: providerConfig.headers } : {}),
            },
          }
        : {}),
      models: {
        [model.modelID]: {},
      },
    },
  },
};
if (mcp && mcp.scriptPath) {
  ocConfig.mcp = {
    botflow: {
      type: "local",
      command: ["node", mcp.scriptPath],
      environment: {
        BOTFLOW_API_BASE: mcp.apiBase,
        BOTFLOW_TOOL_TOKEN: mcp.toolToken,
        BOTFLOW_TOOLS: (mcp.tools || []).join(","),
        BOTFLOW_OAUTH_PROVIDER_IDS: (mcp.oauthProviderIds || []).join(","),
        // Vercel preview deployments answer cookie-less requests with an HTML
        // auth page; this is the official automation bypass (preview-only).
        ...(mcp.vercelBypass ? { BOTFLOW_VERCEL_BYPASS: mcp.vercelBypass } : {}),
      },
      enabled: true,
      // Tool-LIST fetch timeout (default 5000ms) — generous headroom for cold
      // node startup of the MCP script.
      timeout: 15000,
    },
  };
}

// ---------------------------------------------------------------------------
// Spawn "opencode serve" — explicit random high port, retry on collision.
// Readiness line: "opencode server listening on <url>".
// ---------------------------------------------------------------------------
let serveChild = null;

function killServer() {
  if (!serveChild || serveChild.killed) return;
  try {
    process.kill(-serveChild.pid, "SIGKILL");
  } catch {
    try { serveChild.kill("SIGKILL"); } catch { /* gone */ }
  }
}
process.on("exit", killServer);

// SIGTERM = superseded by a new turn or explicit user stop. Node's default
// signal death would NOT fire the "exit" handler, orphaning the opencode
// server (which keeps burning the user's own credits) — so handle it: abort
// the session (best-effort, so opencode records a clean abort), nuke the
// server process group, and exit.
process.on("SIGTERM", () => {
  try { emit({ type: "error", error: "Turn stopped (superseded by a new turn or stopped by the user)." }); } catch {}
  try {
    if (sessionId) {
      api("POST", "/session/" + encodeURIComponent(sessionId) + "/abort").catch(() => {});
    }
  } catch {}
  setTimeout(() => {
    killServer();
    process.exit(1);
  }, 1000);
});

async function startServer() {
  let lastOutput = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(opencodeBin, ["serve", "--hostname=127.0.0.1", "--port=" + port], {
      cwd,
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(ocConfig) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group so killServer nukes any MCP children too
    });

    const result = await new Promise((resolve) => {
      let out = "";
      const timer = setTimeout(() => resolve({ ok: false, out, timeout: true }), 45000);
      child.stdout.on("data", (d) => {
        out += d.toString();
        const m = out.match(/opencode server listening on (\\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve({ ok: true, url: m[1] });
        }
      });
      child.stderr.on("data", (d) => { out += d.toString(); });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve({ ok: false, out, exited: true });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, out: out + String(err), exited: true });
      });
    });

    if (result.ok) {
      serveChild = child;
      return result.url;
    }
    lastOutput = result.out || "";
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    if (result.timeout) break; // a timeout won't improve with a new port
  }
  fail("opencode serve failed to start. Output tail: " + lastOutput.slice(-1500));
}

const baseUrl = await startServer();

// ---------------------------------------------------------------------------
// Minimal HTTP helpers (directory-scoped endpoints).
// ---------------------------------------------------------------------------
const dirQuery = "?directory=" + encodeURIComponent(cwd);

async function api(method, path, body) {
  const res = await fetch(baseUrl + path + dirQuery, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

// ---------------------------------------------------------------------------
// Session: resume when the pointer is still valid, else create fresh.
// ---------------------------------------------------------------------------
let sessionId = null;
if (resumeSessionId) {
  try {
    const res = await api("GET", "/session/" + encodeURIComponent(resumeSessionId));
    if (res.ok) sessionId = resumeSessionId;
  } catch { /* fall through to create */ }
}
if (!sessionId) {
  const res = await api("POST", "/session", { title: "Botflow agent session" });
  if (!res.ok) fail("Failed to create session (HTTP " + res.status + "): " + (await res.text().catch(() => "")));
  const session = await res.json();
  sessionId = session.id;
}
emit({ type: "session_started", sessionId });

// ---------------------------------------------------------------------------
// Event pump — subscribe BEFORE prompting so nothing races past us.
// SSE frames: "data: {json}\\n\\n".
// ---------------------------------------------------------------------------
let seenBusy = false;
let promptAccepted = false;
let abortRequested = false;
let finished = false;

function extractSessionID(event) {
  const p = event && event.properties;
  if (!p) return null;
  if (typeof p.sessionID === "string") return p.sessionID;
  if (p.part && typeof p.part.sessionID === "string") return p.part.sessionID;
  if (p.info && typeof p.info.sessionID === "string") return p.info.sessionID;
  return null;
}

function finish(aborted) {
  if (finished) return;
  finished = true;
  emit({ type: "end_turn", ...(aborted ? { aborted: true } : {}) });
  killServer();
  process.exit(0);
}

function handleEvent(event) {
  const sid = extractSessionID(event);
  // Global events (server.connected etc.) and other sessions' traffic are
  // not the translator's business.
  if (sid !== sessionId) return;

  emit({ type: "oc_event", event });

  const t = event.type;
  const p = event.properties || {};

  if (t === "message.updated" && p.info && p.info.role === "assistant" && p.info.tokens) {
    const tk = p.info.tokens;
    const cacheRead = Number((tk.cache && tk.cache.read) || 0);
    const cacheWrite = Number((tk.cache && tk.cache.write) || 0);
    const input = Number(tk.input || 0);
    const output = Number(tk.output || 0);
    emit({
      type: "usage",
      source: "assistant",
      tokens: input + cacheRead + cacheWrite,
      breakdown: { input, output, cacheCreate: cacheWrite, cacheRead },
      cost: Number(p.info.cost || 0),
    });
  } else if (t === "session.compacted") {
    emit({ type: "compact_boundary", trigger: "auto", preTokens: 0 });
  } else if (t === "permission.updated" && p.id) {
    // Config is all-allow; this is the backstop for permission types the
    // config keys don't cover. Fire-and-forget.
    api("POST", "/session/" + encodeURIComponent(sessionId) + "/permissions/" + encodeURIComponent(p.id), {
      response: "always",
    }).catch(() => {});
  } else if (t === "session.status") {
    const statusType = p.status && p.status.type;
    if (statusType === "busy" || statusType === "retry") seenBusy = true;
    else if (statusType === "idle" && promptAccepted && seenBusy) finish(abortRequested);
  } else if (t === "session.idle") {
    if (promptAccepted && seenBusy) finish(abortRequested);
  } else if (t === "session.error") {
    const name = p.error && p.error.name ? String(p.error.name) : "";
    if (name.includes("Aborted")) {
      // User abort — a normal end, not a failure.
      finish(true);
    } else {
      const message = p.error && p.error.data && p.error.data.message
        ? String(p.error.data.message)
        : (name || "Unknown session error");
      emit({ type: "error", error: name ? name + ": " + message : message });
      killServer();
      process.exit(1);
    }
  }
}

async function pumpEvents() {
  const res = await fetch(baseUrl + "/event", { headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) fail("Failed to subscribe to /event (HTTP " + res.status + ")");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; data lines carry the JSON.
    const frames = buffer.split("\\n\\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          handleEvent(JSON.parse(payload));
        } catch { /* non-JSON keepalive — ignore */ }
      }
    }
  }
  if (!finished) fail("Event stream closed before the turn completed");
}

const pump = pumpEvents().catch((err) => {
  if (!finished) fail("Event pump failed: " + (err && err.message ? err.message : String(err)));
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
const parts = [];
if (typeof prompt === "string" && prompt.length > 0) {
  parts.push({ type: "text", text: prompt });
}
if (Array.isArray(images) && images.length > 0) {
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img || typeof img.data !== "string" || img.data.length === 0) continue;
    const mime = typeof img.media_type === "string" ? img.media_type : "image/jpeg";
    const ext = (mime.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "");
    const filePath = "/tmp/.botflow-oc-img-" + process.pid + "-" + i + "." + ext;
    try {
      await writeFile(filePath, Buffer.from(img.data, "base64"));
      parts.push({ type: "file", mime, filename: "image-" + i + "." + ext, url: "file://" + filePath });
    } catch { /* one broken image shouldn't sink the turn */ }
  }
}
if (parts.length === 0) fail("Nothing to prompt with (no text or images)");

{
  const res = await api("POST", "/session/" + encodeURIComponent(sessionId) + "/prompt_async", {
    model: { providerID: model.providerID, modelID: model.modelID },
    // Our MCP botflow_ask_question is the question primitive; the builtin
    // would render nowhere.
    tools: { question: false },
    parts,
  });
  if (res.status !== 204 && !res.ok) {
    fail("prompt_async rejected (HTTP " + res.status + "): " + (await res.text().catch(() => "")).slice(0, 800));
  }
  promptAccepted = true;
}

// If the prompt was accepted but the session never goes busy, something is
// wedged (bad model id, provider auth failure that didn't surface as an
// event) — don't hang until the route's maxDuration reaps us.
setTimeout(() => {
  if (!seenBusy && !finished) {
    fail("Session never started working within 60s of prompt acceptance");
  }
}, 60000).unref();

// Whole-turn watchdog — the LAST line of defense against a forgotten bridge
// burning the user's own credits. Generous on purpose: turns legitimately
// outlive the route (the client reattaches via the event file), and a modal
// wait alone can hold the turn open for 20 minutes. Wedged bridges are
// normally killed much earlier by the client's no-progress reattach guard or
// the next turn's prepare script.
setTimeout(() => {
  if (!finished) fail("Turn watchdog expired (60 minutes)");
}, 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Abort sentinel — the route touches this file when the client aborts.
// ---------------------------------------------------------------------------
const abortPoll = setInterval(async () => {
  if (!abortPath || finished || abortRequested) return;
  try {
    await access(abortPath);
  } catch {
    return; // sentinel not present
  }
  abortRequested = true;
  try { await unlink(abortPath); } catch { /* best effort */ }
  api("POST", "/session/" + encodeURIComponent(sessionId) + "/abort").catch(() => {});
  // The abort lands as MessageAbortedError / idle through the event pump.
}, 2000);
abortPoll.unref();

await pump;
`;
