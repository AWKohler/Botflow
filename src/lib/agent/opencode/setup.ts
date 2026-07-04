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
// bump forces a reinstall on the next turn. opencode 1.17.13 is the version
// the integration spike verified (docs/features/opencode-agent.md) — reverify
// the spike findings before bumping.
const OPENCODE_VERSION = process.env.BOTFLOW_OPENCODE_VERSION || "1.17.13";
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
  /** Codex (ChatGPT-plan) OAuth tokens — wins over the OpenAI API key when
   *  present (opencode prefers an oauth entry over an api entry, so we write
   *  exactly one `openai` entry). */
  codex?: {
    accessToken: string;
    refreshToken?: string | null;
    /** Epoch ms. */
    expiresAt?: number | null;
  } | null;
  openaiApiKey?: string | null;
  fireworksApiKey?: string | null;
  googleApiKey?: string | null;
  togetherApiKey?: string | null;
}

/**
 * Write the user's credentials into OpenCode's auth store. Only providers the
 * user actually holds credentials for get an entry, and NEVER `anthropic` —
 * Claude plans flow exclusively through Claude Code (ToS), and Anthropic BYOK
 * keeps its existing botflow/claude-code routing.
 *
 * Provider ids verified against opencode 1.17.13's catalog:
 * openai / google / fireworks-ai / togetherai.
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
  } else if (input.openaiApiKey) {
    payload.openai = { type: "api", key: input.openaiApiKey };
  }
  if (input.fireworksApiKey) {
    payload["fireworks-ai"] = { type: "api", key: input.fireworksApiKey };
  }
  if (input.googleApiKey) {
    payload.google = { type: "api", key: input.googleApiKey };
  }
  if (input.togetherApiKey) {
    payload.togetherai = { type: "api", key: input.togetherApiKey };
  }
  if (Object.keys(payload).length === 0) {
    throw new Error("writeOpenCodeAuth: no credentials provided");
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
 * Read back the sandbox's auth.json (or null if unreadable). Used after a
 * turn to detect whether opencode rotated the Codex refresh token mid-turn —
 * if it did, the route persists the rotated pair so the next turn's
 * server-side refresh doesn't use a stale token.
 */
export async function readOpenCodeAuth(
  projectId: string,
): Promise<Record<string, unknown> | null> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveOpenCodePaths(projectId);
  const cmd = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `cat ${paths.authPath} 2>/dev/null || true`],
  });
  const raw = (await cmd.stdout()).trim();
  if (!raw) return null;
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
): Promise<void> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveOpenCodePaths(projectId);
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `mkdir -p ${paths.ocDir}`],
  });
  await sandbox.writeFiles([
    {
      path: paths.appendPromptPath,
      content: Buffer.from(content, "utf-8"),
    },
  ]);
}
