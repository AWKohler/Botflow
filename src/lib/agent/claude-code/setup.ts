/**
 * Sandbox setup for the Claude Code agent path.
 *
 * Idempotent helpers that run on every agent turn (cheap when already done):
 *  - resolveSandboxPaths — runs `echo $HOME` once per process to learn the
 *    sandbox user's home dir. Cached per project so we only pay this on
 *    cold boots of the Next.js function.
 *  - ensureClaudeInstalled — installs the official `claude` CLI globally
 *    (sudo) + the Agent SDK in $HOME/.botflow/ (no sudo).
 *  - writeClaudeCredentials — drops the user's OAuth tokens / API key into
 *    $HOME/.claude/.credentials.json so the local claude binary authenticates
 *    against the user's plan.
 *  - writeBridgeScript — drops the small Node bridge at $HOME/.botflow/.
 *
 * Each helper is a fast no-op when its work is already done — we only pay
 * the cost on first boot or after a sandbox restart.
 */
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import {
  BRIDGE_SCRIPT_SOURCE,
  BRIDGE_SCRIPT_VERSION,
} from "./bridge-script";

export interface SandboxPaths {
  /** The sandbox user's home directory (e.g. /home/vercel or /root). */
  home: string;
  /** Our scratch dir for the bridge script + Agent SDK install. */
  bridgeDir: string;
  /** Absolute path to the bridge script. */
  bridgePath: string;
  /** Where claude reads ~/.claude. */
  claudeHome: string;
  /** Absolute path to the credentials file claude reads on startup. */
  credentialsPath: string;
  /** Marker file the install step touches when complete. */
  installMarker: string;
  /** Version marker file we write after dropping the bridge script. */
  bridgeVersionMarker: string;
}

// In-process cache: each Next.js function instance caches HOME per project.
// Vercel doesn't pin instances to projects, so a cold start re-discovers HOME
// (one extra runCommand). Redis is overkill for a sub-50ms shell call.
const pathsCache = new Map<string, SandboxPaths>();

async function discoverHome(projectId: string): Promise<string> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const cmd = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", "echo $HOME"],
  });
  const home = (await cmd.stdout()).trim();
  if (!home || !home.startsWith("/")) {
    throw new Error(
      `Failed to resolve sandbox $HOME (got: ${JSON.stringify(home)}). Sandbox may not be ready.`,
    );
  }
  return home;
}

export async function resolveSandboxPaths(projectId: string): Promise<SandboxPaths> {
  const cached = pathsCache.get(projectId);
  if (cached) return cached;

  const home = await discoverHome(projectId);
  const bridgeDir = `${home}/.botflow`;
  const claudeHome = `${home}/.claude`;
  const paths: SandboxPaths = {
    home,
    bridgeDir,
    bridgePath: `${bridgeDir}/claude-bridge.mjs`,
    claudeHome,
    credentialsPath: `${claudeHome}/.credentials.json`,
    installMarker: `${bridgeDir}/.claude-installed`,
    bridgeVersionMarker: `${bridgeDir}/.claude-bridge.version`,
  };
  pathsCache.set(projectId, paths);
  return paths;
}

/**
 * Install `claude` (global, via sudo) and `@anthropic-ai/claude-agent-sdk`
 * (local in ~/.botflow, no sudo) in the sandbox. Idempotent: checks marker
 * file + binary presence + SDK directory before doing real work.
 *
 * Returns { ok: true } when ready, { ok: false, error } when install failed.
 */
// Pinned versions for the Anthropic SDKs we install in every sandbox. Pinning
// insulates us from breaking publishes upstream — both packages ship daily.
// Override per-deployment via env if a newer version fixes a bug or you want
// to test a release candidate, but the default should always reflect a
// version we've verified works end-to-end.
//
// Bump these when validating a newer release; the installer keys the
// install-marker on these strings, so a change here forces every active
// sandbox to reinstall on its next agent turn.
//
// The two move in lockstep (SDK 0.3.N bundles Claude Code 2.1.N, which is what
// the bridge actually runs). Minimums are set by Anthropic per model: Claude
// Opus 5.5 requires Claude Code 2.1.280+ (the API answers 400 "Claude Code
// 2.1.145 does not support this model" otherwise).
const CLAUDE_AGENT_SDK_VERSION =
  process.env.BOTFLOW_CLAUDE_AGENT_SDK_VERSION || "0.3.290";
const CLAUDE_CODE_CLI_VERSION =
  process.env.BOTFLOW_CLAUDE_CODE_CLI_VERSION || "2.1.290";

/** Compose a content-addressed marker token so changing pinned versions
 *  invalidates the marker and forces a re-install on the next agent turn. */
function installMarkerToken(): string {
  return `sdk=${CLAUDE_AGENT_SDK_VERSION};cli=${CLAUDE_CODE_CLI_VERSION}`;
}

export async function ensureClaudeInstalled(projectId: string): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveSandboxPaths(projectId);

  // Fast path: marker exists AND it matches the current version token AND the
  // binary is still present AND the SDK dir still exists. Any mismatch on
  // versions forces a reinstall (the user bumped the env var, or we shipped
  // a new pin in code).
  const expectedToken = installMarkerToken();
  const check = await sandbox.runCommand({
    cmd: "sh",
    args: [
      "-c",
      `test -f ${paths.installMarker} && [ "$(cat ${paths.installMarker})" = "${expectedToken}" ] && command -v claude >/dev/null 2>&1 && test -d ${paths.bridgeDir}/node_modules/@anthropic-ai/claude-agent-sdk && echo OK || echo MISSING`,
    ],
  });
  if ((await check.stdout()).trim() === "OK") {
    return { ok: true };
  }

  // Step 1: prepare the bridge directory in $HOME (no sudo needed).
  // We write a minimal package.json by hand instead of `npm init -y` —
  // the directory is `.botflow`, which npm rejects as a package name
  // ("Invalid name: '.botflow'"). Hardcoded name sidesteps the issue.
  // Clean node_modules + package-lock first so a re-install genuinely pulls
  // the new version (npm install on an existing tree doesn't downgrade).
  const prepResult = await sandbox.runCommand({
    cmd: "sh",
    args: [
      "-c",
      [
        "set -e",
        `mkdir -p ${paths.bridgeDir}`,
        `cd ${paths.bridgeDir}`,
        `rm -rf node_modules package-lock.json`,
        `printf '%s\\n' '{"name":"botflow-bridge","version":"1.0.0","private":true,"type":"module"}' > package.json`,
        `npm install --no-audit --no-fund --silent @anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION}`,
      ].join(" && "),
    ],
  });
  if (prepResult.exitCode !== 0) {
    const stderr = (await prepResult.stderr()).slice(-2000);
    return {
      ok: false,
      error: `Failed to install Agent SDK in sandbox (exit ${prepResult.exitCode}). ${stderr}`,
    };
  }

  // Step 2: global install of the claude CLI (requires sudo for /usr/local).
  const globalResult = await sandbox.runCommand({
    cmd: "npm",
    args: [
      "install",
      "-g",
      "--no-audit",
      "--no-fund",
      "--silent",
      `@anthropic-ai/claude-code@${CLAUDE_CODE_CLI_VERSION}`,
    ],
    sudo: true,
  });
  if (globalResult.exitCode !== 0) {
    const stderr = (await globalResult.stderr()).slice(-2000);
    return {
      ok: false,
      error: `Failed to install claude CLI in sandbox (exit ${globalResult.exitCode}). ${stderr}`,
    };
  }

  // Step 3: write the marker with the current version token. The fast-path
  // check reads this file and compares it to the expected token; mismatch
  // forces a reinstall.
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `printf '%s' '${installMarkerToken()}' > ${paths.installMarker}`],
  });

  return { ok: true };
}

export interface ClaudeCredentialsInput {
  /** OAuth access token (preferred). */
  accessToken?: string | null;
  /** OAuth refresh token (paired with accessToken). */
  refreshToken?: string | null;
  /** Epoch ms when the access token expires. */
  expiresAt?: number | null;
  /** BYOK fallback (used only when there's no OAuth token). */
  apiKey?: string | null;
}

/**
 * Drop the user's Anthropic credentials into the sandbox at
 * ~/.claude/.credentials.json. The `claude` binary reads this file on each
 * invocation. Format mirrors what Claude Code writes during a real desktop
 * login.
 */
export async function writeClaudeCredentials(
  projectId: string,
  input: ClaudeCredentialsInput,
): Promise<void> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveSandboxPaths(projectId);

  let payload: Record<string, unknown>;
  if (input.accessToken) {
    payload = {
      claudeAiOauth: {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? undefined,
        expiresAt: input.expiresAt ?? undefined,
        scopes: ["user:inference"],
        subscriptionType: undefined,
      },
    };
  } else if (input.apiKey) {
    payload = { apiKey: input.apiKey };
  } else {
    throw new Error("writeClaudeCredentials: no accessToken or apiKey provided");
  }

  // mkdir the .claude dir (no sudo — it's under $HOME) then write the file.
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `mkdir -p ${paths.claudeHome} && chmod 700 ${paths.claudeHome}`],
  });
  await sandbox.writeFiles([
    {
      path: paths.credentialsPath,
      content: Buffer.from(JSON.stringify(payload), "utf-8"),
    },
  ]);
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `chmod 600 ${paths.credentialsPath}`],
  });
}

/**
 * Write the bridge script. Idempotent — compares the in-sandbox version
 * marker to BRIDGE_SCRIPT_VERSION and skips when they match.
 */
export async function writeBridgeScript(projectId: string): Promise<void> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const paths = await resolveSandboxPaths(projectId);

  const check = await sandbox.runCommand({
    cmd: "sh",
    args: [
      "-c",
      `test -f ${paths.bridgePath} && cat ${paths.bridgeVersionMarker} 2>/dev/null || true`,
    ],
  });
  const existing = (await check.stdout()).trim();
  if (existing === BRIDGE_SCRIPT_VERSION) return;

  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `mkdir -p ${paths.bridgeDir}`],
  });
  await sandbox.writeFiles([
    {
      path: paths.bridgePath,
      content: Buffer.from(BRIDGE_SCRIPT_SOURCE, "utf-8"),
    },
    {
      path: paths.bridgeVersionMarker,
      content: Buffer.from(BRIDGE_SCRIPT_VERSION, "utf-8"),
    },
  ]);
}
