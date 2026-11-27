/**
 * Sandbox setup for the OpenCode agent path. Mirrors the Claude Code setup
 * (src/lib/agent/claude-code/setup.ts): idempotent helpers that run on every
 * agent turn and are fast no-ops when their work is already done.
 *
 * Key divergences from the CC setup, both deliberate:
 *  - Everything installs LOCALLY under ~/.botflow/opencode/ with no sudo —
 *    the bridge invokes the opencode binary by absolute path, so nothing
 *    needs to be on PATH (and the CC installer wipes ~/.botflow/node_modules
 *    wholesale on reinstall, so we must not share its directory).
 *  - Credentials go to OpenCode's auth store at ~/.local/share/opencode/
 *    auth.json (shape verified against opencode 1.17.13 — see
 *    docs/features/opencode-agent.md).
 */
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import { resolveSandboxPaths } from "@/lib/agent/claude-code/setup";
import {
  OPENCODE_BRIDGE_SOURCE,
  OPENCODE_SCRIPTS_VERSION,
} from "./bridge-script";
import { OPENCODE_MCP_SCRIPT_SOURCE } from "./mcp-script";

export interface OpenCodeSandboxPaths {
  /** The sandbox user's home directory. */
  home: string;
  /** Our install dir: ~/.botflow/opencode (NOT shared with the CC bridge dir —
   *  ensureClaudeInstalled rm -rf's ~/.botflow/node_modules on reinstall). */
  ocDir: string;
  bridgePath: string;
  mcpScriptPath: string;
  appendPromptPath: string;
  /** Absolute path to the opencode binary (local node_modules/.bin). */
  binPath: string;
  /** OpenCode's data dir — sessions + auth.json live here. */
  dataDir: string;
  authPath: string;
  installMarker: string;
  scriptsVersionMarker: string;
}

const pathsCache = new Map<string, OpenCodeSandboxPaths>();

export async function resolveOpenCodePaths(projectId: string): Promise<OpenCodeSandboxPaths> {
  const cached = pathsCache.get(projectId);
  if (cached) return cached;

  // Reuse the CC setup's $HOME discovery (cached per project there too).
  const { home } = await resolveSandboxPaths(projectId);
  const ocDir = `${home}/.botflow/opencode`;
  const dataDir = `${home}/.local/share/opencode`;
  const paths: OpenCodeSandboxPaths = {
    home,
    ocDir,
    bridgePath: `${ocDir}/opencode-bridge.mjs`,
    mcpScriptPath: `${ocDir}/botflow-mcp.mjs`,
    appendPromptPath: `${ocDir}/append-prompt.md`,
    binPath: `${ocDir}/node_modules/.bin/opencode`,
    dataDir,
    authPath: `${dataDir}/auth.json`,
    installMarker: `${ocDir}/.opencode-installed`,
    scriptsVersionMarker: `${ocDir}/.opencode-scripts.version`,
  };
  pathsCache.set(projectId, paths);
  return paths;
}

// Pinned versions — see the CC setup's rationale verbatim: pinning insulates
// us from breaking upstream publishes; env overrides allow validating a newer
// release without a deploy; the install marker is keyed on these strings so a
// bump forces a reinstall on the next turn.
//
// Pin bumped 1.17.18 → 1.18.30 (2026-09, for GPT-6 Astra). Astra shipped
// 2026-09-04 and its models.dev entry only reaches the bundled catalog from
// 1.18.28 on: grepping the linux-x64 binaries, `gpt-6-astra` appears 63× in
// 1.18.30 and 0× in 1.17.18. The catalog entry matters even though the bridge
// declares the model explicitly — the declaration is an empty override object,
// so capability flags (reasoning, attachment, tool_call) come from the
// catalog, and `reasoning` is what routes the model down /v1/responses rather
// than /v1/chat/completions.
//
// The 1.18.0 major is a Desktop-app v2 migration; the 1.18.0–1.18.30 release
// notes document NO breaking changes to the config/opencode.json schema,
// auth.json format, SSE event shapes, or builtin tool names — the surfaces the
// integration spike (docs/features/opencode-agent.md) is coupled to. Spot-
// checked directly against the 1.18.30 binary: the config keys we set
// (autoupdate, small_model, permission.doom_loop, permission.external_
// directory), the SSE event names we parse (message.updated,
// message.part.updated, session.status), the "step-start" part type, and the
// "opencode server listening on" readiness line are all still present.
// A full in-sandbox turn is still the last-mile check before/after deploy.
const OPENCODE_VERSION = process.env.BOTFLOW_OPENCODE_VERSION || "1.19.0";
const MCP_SDK_VERSION = process.env.BOTFLOW_MCP_SDK_VERSION || "1.29.0";

function installMarkerToken(): string {
  return `oc=${OPENCODE_VERSION};mcp=${MCP_SDK_VERSION}`;
}

/**
 * Install opencode + the MCP SDK locally in ~/.botflow/opencode (no sudo).
 * Idempotent: marker + binary + module-dir checks gate the slow path.
 */
export async function ensureOpenCodeInstalled(projectId: string): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveOpenCodePaths(projectId);

  const expectedToken = installMarkerToken();
  const check = await sandbox.runCommand({
    cmd: "sh",
    args: [
      "-c",
      `test -f ${paths.installMarker} && [ "$(cat ${paths.installMarker})" = "${expectedToken}" ] && test -x ${paths.binPath} && test -d ${paths.ocDir}/node_modules/@modelcontextprotocol/sdk && echo OK || echo MISSING`,
    ],
  });
  if ((await check.stdout()).trim() === "OK") {
    return { ok: true };
  }

  // Slow path. Clean node_modules + lockfile first so a re-install genuinely
  // pulls the pinned versions (npm install on an existing tree doesn't
  // downgrade). The hardcoded package name sidesteps npm rejecting the
  // directory name as a package name.
  const install = await sandbox.runCommand({
    cmd: "sh",
    args: [
      "-c",
      [
        "set -e",
        `mkdir -p ${paths.ocDir}`,
        `cd ${paths.ocDir}`,
        `rm -rf node_modules package-lock.json`,
        `printf '%s\\n' '{"name":"botflow-opencode","version":"1.0.0","private":true,"type":"module"}' > package.json`,
        `npm install --no-audit --no-fund --silent opencode-ai@${OPENCODE_VERSION} @modelcontextprotocol/sdk@${MCP_SDK_VERSION}`,
      ].join(" && "),
    ],
  });
  if (install.exitCode !== 0) {
    const stderr = (await install.stderr()).slice(-2000);
    return {
      ok: false,
      error: `Failed to install opencode in sandbox (exit ${install.exitCode}). ${stderr}`,
    };
  }

  // Verify the platform binary actually resolved (opencode-ai ships per-OS
  // binaries as optionalDependencies) before declaring success.
  const versionCheck = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `${paths.binPath} --version 2>&1 || true`],
  });
  const reported = (await versionCheck.stdout()).trim();
  if (!reported.includes(OPENCODE_VERSION)) {
    return {
      ok: false,
      error: `opencode binary did not resolve after install (--version said: ${reported.slice(0, 300) || "<empty>"}).`,
    };
  }

  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `printf '%s' '${installMarkerToken()}' > ${paths.installMarker}`],
  });

  return { ok: true };
}

export interface OpenCodeAuthInput {
  /** Codex (ChatGPT-plan) OAuth tokens — THE one documented exception where
   *  a real credential enters the sandbox: opencode 1.17.13's codex plugin
   *  hardcodes its endpoint and self-refreshes, so it can't ride the proxy.
   *  Pre-sharing-GA blocker; see docs/features/llm-proxy.md. */
  codex?: {
    accessToken: string;
    refreshToken?: string | null;
    /** Epoch ms. */
    expiresAt?: number | null;
  } | null;
  /** Every other mode: a bfap_ LLM-proxy token masquerading as the
   *  provider's api key. The real key (the user's BYOK or the platform's)
   *  is injected server-side at /api/internal/llm-proxy — NEVER written
   *  here. */
  proxy?: {
    /** opencode catalog provider id (anthropic/openai/google/fireworks-ai/togetherai). */
    providerID: string;
    token: string;
  } | null;
}

/** Matches every OpenCode process we launch (bridge + `opencode serve`):
 *  both run from under ~/.botflow/opencode/. The bracket keeps pgrep/pkill
 *  from matching the shell that runs them. */
const OPENCODE_PROCESS_PATTERN = "[/]\\.botflow/opencode/";
/** Just the bridges — one per running agent turn. */
const OPENCODE_BRIDGE_PATTERN = "[/]\\.botflow/opencode/opencode-bridge";

export const PURGE_OK_MARKER = "BOTFLOW_PURGED";
const FENCED_MARKER = "BOTFLOW_FENCED";
const WRITTEN_MARKER = "BOTFLOW_WRITTEN";

/** Thrown when a personal-credential write or read is refused because the
 *  sandbox has been shared (its fence marker exists). */
export class SandboxSharedError extends Error {
  constructor() {
    super("The project sandbox has been shared; personal credentials are refused");
  }
}

/** Sticky in-sandbox "this sandbox has been shared" marker. It is the fence
 *  that makes credential safety independent of any lock's timing: a purge
 *  creates it FIRST, and every Codex write checks it before AND after
 *  writing, so whichever order the two land in, no token file survives. */
function sharedMarkerPath(home: string): string {
  return `${home}/.botflow/sandbox-shared`;
}

/**
 * Remove every trace of a personal credential from the project sandbox:
 * set the shared fence marker, delete OpenCode's auth store (and temp
 * variants), kill every OpenCode process (one started before the delete may
 * hold tokens in memory; one started after has none), delete again, then
 * VERIFY no process is left and the file is gone. Process-listing errors
 * count as failure, never as "nothing running". Throws unless verified.
 * Returns how many agent bridges (running turns) were stopped.
 */
export async function purgeOpenCodeCredentials(projectId: string): Promise<{ stoppedAgents: number }> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveOpenCodePaths(projectId);
  const auth = paths.authPath;
  const marker = sharedMarkerPath(paths.home);
  const pat = `'${OPENCODE_PROCESS_PATTERN}'`;
  const bridges = `'${OPENCODE_BRIDGE_PATTERN}'`;
  // pgrep exit status: 0 = matches, 1 = no matches, anything else = error.
  const script = [
    `command -v pgrep >/dev/null 2>&1 && command -v pkill >/dev/null 2>&1 || { echo BOTFLOW_PURGE_NO_TOOLS; exit 5; }`,
    `mkdir -p ${paths.home}/.botflow && touch ${marker} || { echo BOTFLOW_PURGE_NO_MARKER; exit 7; }`,
    `rm -f ${auth} ${auth}.*`,
    `B=$(pgrep -f ${bridges}); rc=$?`,
    `if [ $rc -gt 1 ]; then echo BOTFLOW_PURGE_PGREP_ERROR; exit 6; fi`,
    `N=$(printf '%s' "$B" | grep -c . || true)`,
    `pkill -TERM -f ${pat} 2>/dev/null`,
    `i=0`,
    `while [ $i -lt 30 ]; do pgrep -f ${pat} >/dev/null 2>&1; rc=$?; [ $rc -eq 1 ] && break; [ $rc -gt 1 ] && { echo BOTFLOW_PURGE_PGREP_ERROR; exit 6; }; sleep 0.1; i=$((i+1)); done`,
    `pkill -KILL -f ${pat} 2>/dev/null`,
    `sleep 0.2`,
    `rm -f ${auth} ${auth}.*`,
    `pgrep -f ${pat} >/dev/null 2>&1; rc=$?`,
    `if [ $rc -eq 0 ]; then echo BOTFLOW_PURGE_PROCS_LEFT; exit 3; fi`,
    `if [ $rc -ne 1 ]; then echo BOTFLOW_PURGE_PGREP_ERROR; exit 6; fi`,
    `if [ -e ${auth} ]; then echo BOTFLOW_PURGE_FILE_LEFT; exit 4; fi`,
    `echo "${PURGE_OK_MARKER} $N"`,
  ].join("\n");
  const res = await sandbox.runCommand({ cmd: "sh", args: ["-c", script] });
  const out = (await res.stdout()).trim();
  const match = out.match(new RegExp(`${PURGE_OK_MARKER} (\\d+)`));
  if (res.exitCode !== 0 || !match) {
    throw new Error(`purgeOpenCodeCredentials: not verified (exit ${res.exitCode}): ${out.slice(0, 200)}`);
  }
  return { stoppedAgents: Number(match[1]) };
}

/**
 * Write the turn's credential surface into OpenCode's auth store. With the
 * LLM proxy this is a bfap_ token, never a real key — the sole exception is
 * the Codex OAuth entry (see OpenCodeAuthInput), which is written FENCED:
 * refused if the sandbox's shared marker exists before the write, and
 * removed again if it appears during it (throws SandboxSharedError).
 * Provider ids verified against opencode 1.17.13's catalog.
 */
export async function writeOpenCodeAuth(
  projectId: string,
  input: OpenCodeAuthInput,
): Promise<void> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveOpenCodePaths(projectId);

  const payload: Record<string, unknown> = {};
  if (input.codex?.accessToken) {
    payload.openai = {
      type: "oauth",
      access: input.codex.accessToken,
      refresh: input.codex.refreshToken ?? "",
      expires: input.codex.expiresAt ?? 0,
    };
  }
  if (input.proxy?.token) {
    payload[input.proxy.providerID] = { type: "api", key: input.proxy.token };
  }
  if (Object.keys(payload).length === 0) {
    throw new Error("writeOpenCodeAuth: no credentials provided");
  }

  if (input.codex?.accessToken) {
    // One shell, no temp file written before the fence check: content goes
    // in as base64 and is decoded only after the marker check passes.
    const b64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
    const marker = sharedMarkerPath(paths.home);
    const tmp = `${paths.authPath}.w${Date.now().toString(36)}`;
    const script = [
      `if [ -e ${marker} ]; then echo ${FENCED_MARKER}; exit 9; fi`,
      `mkdir -p ${paths.dataDir} && chmod 700 ${paths.dataDir} || exit 1`,
      `umask 077`,
      `printf '%s' '${b64}' | base64 -d > ${tmp} || { rm -f ${tmp}; exit 1; }`,
      `mv -f ${tmp} ${paths.authPath} || { rm -f ${tmp}; exit 1; }`,
      `if [ -e ${marker} ]; then rm -f ${paths.authPath}; echo ${FENCED_MARKER}; exit 9; fi`,
      `echo ${WRITTEN_MARKER}`,
    ].join("\n");
    const res = await sandbox.runCommand({ cmd: "sh", args: ["-c", script] });
    const out = (await res.stdout()).trim();
    if (out.includes(FENCED_MARKER)) throw new SandboxSharedError();
    if (res.exitCode !== 0 || !out.includes(WRITTEN_MARKER)) {
      throw new Error(`writeOpenCodeAuth: codex write failed (exit ${res.exitCode})`);
    }
    return;
  }

  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `mkdir -p ${paths.dataDir} && chmod 700 ${paths.dataDir}`],
  });
  await sandbox.writeFiles([
    {
      path: paths.authPath,
      content: Buffer.from(JSON.stringify(payload), "utf-8"),
    },
  ]);
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `chmod 600 ${paths.authPath}`],
  });
}

/**
 * Read back the sandbox's auth.json to recover a Codex token rotation.
 * Returns null — adopt nothing — if unreadable, or if the sandbox has ever
 * been shared (its contents may have been planted by someone else).
 */
export async function readOpenCodeAuth(
  projectId: string,
): Promise<Record<string, unknown> | null> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveOpenCodePaths(projectId);
  const marker = sharedMarkerPath(paths.home);
  const cmd = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `if [ -e ${marker} ]; then echo ${FENCED_MARKER}; exit 0; fi; cat ${paths.authPath} 2>/dev/null || true`],
  });
  const raw = (await cmd.stdout()).trim();
  if (!raw || raw === FENCED_MARKER) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Write the bridge + MCP scripts. Idempotent — one version marker covers
 * both (bump OPENCODE_SCRIPTS_VERSION when EITHER script source changes).
 */
export async function writeOpenCodeScripts(projectId: string): Promise<void> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveOpenCodePaths(projectId);

  const check = await sandbox.runCommand({
    cmd: "sh",
    args: [
      "-c",
      `test -f ${paths.bridgePath} && test -f ${paths.mcpScriptPath} && cat ${paths.scriptsVersionMarker} 2>/dev/null || true`,
    ],
  });
  const existing = (await check.stdout()).trim();
  if (existing === OPENCODE_SCRIPTS_VERSION) return;

  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `mkdir -p ${paths.ocDir}`],
  });
  await sandbox.writeFiles([
    {
      path: paths.bridgePath,
      content: Buffer.from(OPENCODE_BRIDGE_SOURCE, "utf-8"),
    },
    {
      path: paths.mcpScriptPath,
      content: Buffer.from(OPENCODE_MCP_SCRIPT_SOURCE, "utf-8"),
    },
    {
      path: paths.scriptsVersionMarker,
      content: Buffer.from(OPENCODE_SCRIPTS_VERSION, "utf-8"),
    },
  ]);
}

/**
 * Write the per-turn instructions file (referenced from the generated config
 * via `instructions: [path]` — append semantics on top of OpenCode's default
 * agent prompt, mirroring CC's preset+append). Unconditional write: content
 * varies with project state, like credentials.
 */
export async function writeOpenCodeAppendPrompt(
  projectId: string,
  content: string,
  threadId: string,
): Promise<string> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveOpenCodePaths(projectId);
  // One file per thread: concurrently running threads get different prompts
  // (the cross-agent awareness note names the OTHER threads).
  const path = `${paths.ocDir}/append-prompt-${threadId.replace(/[^0-9a-f-]/gi, "")}.md`;
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `mkdir -p ${paths.ocDir}`],
  });
  await sandbox.writeFiles([
    {
      path,
      content: Buffer.from(content, "utf-8"),
    },
  ]);
  return path;
}
