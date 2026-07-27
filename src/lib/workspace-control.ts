/**
 * Server-side workspace control primitives for the sandboxed-web platform.
 *
 * One shared lib feeds two adapters:
 *  - `src/lib/agent/sandboxed-web-tools.ts` (Botflow agent / AI SDK tools)
 *  - `src/app/api/internal/claude-code-tool/route.ts` (Claude Code MCP)
 *
 * All execution stays on this server. The browser's only role is to *capture*
 * iframe postMessage events and POST them to `/api/projects/:id/browser-log`,
 * which feeds a Redis ring buffer that `getSandboxBrowserLog` reads from.
 *
 * For dev-server start/stop/log we drive the user's Vercel Sandbox directly via
 * `vercel-sandbox.ts` helpers.
 */
import { getOrCreatePersistentSandbox, sandboxBash } from "@/lib/vercel-sandbox";
import { getProjectSandboxProvider } from "@/lib/sandbox-provider";
import { signPreviewUrl } from "@/lib/preview-token";
import { materializeFrontendEnv } from "@/lib/sandbox-env";
import { getRedis } from "@/lib/redis";
import { sanitizeOutput } from "@/lib/output-sanitizer";
import { buildBotflowViteConfig } from "@/lib/preview-editor/wrapper";

const DEV_LOG_PATH = "/tmp/dev-server.log";
const BROWSER_LOG_MAX = 2000;
const BROWSER_LOG_TTL_SECONDS = 24 * 60 * 60;
const DEVSERVER_STATE_TTL_SECONDS = 6 * 60 * 60;

export function browserLogKey(projectId: string): string {
  return `browser-log:${projectId}`;
}

export function previewRefreshKey(projectId: string): string {
  return `preview-refresh:${projectId}`;
}

export function devServerStateKey(projectId: string): string {
  return `devserver-state:${projectId}`;
}

/**
 * Snapshot of the dev server's externally-visible state. Published to Redis
 * whenever start/stop succeeds; the SandboxedWebWorkspace polls and reflects
 * this into its preview pane so the agent and the user see the same thing.
 */
export interface DevServerState {
  running: boolean;
  previewUrl: string | null;
  port: number | null;
  /** Timestamp of the last state change (start or stop). Used by the client
   *  poll to detect new changes without false-positive remounts. */
  updatedAt: number;
}

async function publishDevServerState(
  projectId: string,
  state: DevServerState,
): Promise<void> {
  try {
    const redis = getRedis();
    await redis.setex(
      devServerStateKey(projectId),
      DEVSERVER_STATE_TTL_SECONDS,
      JSON.stringify(state),
    );
  } catch {
    // Non-fatal — the next poll will just show stale state until things recover.
  }
}

export async function getDevServerState(projectId: string): Promise<DevServerState | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get<string>(devServerStateKey(projectId));
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as DevServerState;
  } catch {
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Dev server reachability — never let the user see Vercel's 502 page
 * ────────────────────────────────────────────────────────────────────── */

const PROBE_MIN_INTERVAL_SECONDS = 5;

function devServerProbeStampKey(projectId: string): string {
  return `devserver-probe:${projectId}`;
}

/**
 * If Redis claims the dev server is running, verify the public preview URL is
 * actually reachable. When the sandbox stops listening (the dreaded
 * `502 SANDBOX_NOT_LISTENING`), flip the published state to stopped so the
 * workspace unmounts the iframe before the user ever sees Vercel's error page.
 *
 * Throttled via a Redis stamp so the workspace's 2s preview-state poll doesn't
 * turn into a probe-per-poll. Returns the (possibly corrected) state.
 */
export async function verifyDevServerReachable(
  projectId: string,
  state: DevServerState | null,
): Promise<DevServerState | null> {
  if (!state || !state.running || !state.previewUrl) return state;

  // Plain-http preview URLs are tailnet-only sandbox-host routes (the
  // Cloudflare-tunneled ones are https, as are all Vercel *.vercel.run
  // URLs) — from production this fetch can never succeed, so probing would
  // only stall the polling route by the 3s timeout. Dead dev servers on
  // those projects are still caught by the in-VM reconciler in
  // isSandboxDevServerRunning.
  if (!state.previewUrl.startsWith("https://")) return state;

  try {
    const redis = getRedis();
    // NX+EX: only one caller wins the probe slot per interval window.
    const claimed = await redis.set(devServerProbeStampKey(projectId), "1", {
      nx: true,
      ex: PROBE_MIN_INTERVAL_SECONDS,
    });
    if (!claimed) return state;
  } catch {
    return state; // Redis hiccup — don't probe unthrottled.
  }

  try {
    const probe = await fetch(state.previewUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    });
    if (probe.status >= 500) {
      const stopped: DevServerState = {
        running: false,
        previewUrl: null,
        port: null,
        updatedAt: Date.now(),
      };
      await publishDevServerState(projectId, stopped);
      return stopped;
    }
  } catch {
    // Network/timeout — could be a transient blip on our side; don't kill a
    // possibly-healthy preview over it. A genuine dead sandbox answers fast
    // with a 502, which the branch above catches.
  }
  return state;
}

export interface BrowserLogEntry {
  timestamp: number;
  level: "log" | "warn" | "error";
  message: string;
  type: "console" | "error" | "hmr";
}

/* ──────────────────────────────────────────────────────────────────────────
 * Dev server lifecycle
 * ────────────────────────────────────────────────────────────────────── */

export interface StartDevServerResult {
  ok: boolean;
  message: string;
  previewUrl?: string;
  port?: number;
  log?: string;
  /** Response headers from the upstream proxy on the successful probe.
   *  Surfaced so the workspace UI can diagnose iframe-blocking directives. */
  responseHeaders?: Record<string, string>;
  /** Tail of pnpm install output when the install step failed. */
  installStderr?: string;
  installStdout?: string;
}

/**
 * Start the Vite dev server in the user's sandbox. Idempotent — if vite is
 * already running on the requested port the previous instance is killed and
 * a fresh one is started (necessary because the wrapper config or env may
 * have changed between calls).
 *
 * Mirrors the behavior of POST /api/projects/[id]/sandbox/devserver, which is
 * now a thin wrapper around this function.
 */
export async function startSandboxDevServer(
  projectId: string,
  opts: { port?: number; installFirst?: boolean } = {},
): Promise<StartDevServerResult> {
  const port = opts.port ?? 5173;
  const installFirst = opts.installFirst ?? false;

  try {
    const sandbox = await getOrCreatePersistentSandbox(projectId);
    const provider = await getProjectSandboxProvider(projectId);

    let previewUrl: string;
    try {
      previewUrl = sandbox.domain(port);
    } catch {
      return {
        ok: false,
        message: `Port ${port} was not declared at sandbox creation. Allowed: 3000, 5173, 4173, 8000.`,
      };
    }
    // sandbox-host previews served via the Cloudflare tunnel require a signed
    // token; append it before the URL is probed, published, or iframed.
    // No-op when PREVIEW_SIGNING_SECRET is unset.
    if (provider === "sandbox-host") {
      previewUrl = signPreviewUrl(previewUrl);
    }

    // Kill any prior vite/dev server.
    await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", "pkill -f 'vite' 2>/dev/null || true; sleep 0.3; rm -f " + DEV_LOG_PATH],
      cwd: "/vercel/sandbox",
    });

    if (installFirst) {
      const installResult = await sandbox.runCommand({
        cmd: "pnpm",
        args: ["install", "--prefer-offline"],
        cwd: "/vercel/sandbox",
      });
      if (installResult.exitCode !== 0) {
        const err = await installResult.stderr();
        const out = await installResult.stdout();
        return {
          ok: false,
          message: `pnpm install failed (exit ${installResult.exitCode}).`,
          installStderr: err.slice(-2000),
          installStdout: out.slice(-2000),
        };
      }
    }

    // Verify vite is actually installed before we try to spawn it.
    const viteCheck = await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", "test -x /vercel/sandbox/node_modules/.bin/vite && echo OK || echo MISSING"],
      cwd: "/vercel/sandbox",
    });
    const viteStatus = (await viteCheck.stdout()).trim();
    if (viteStatus !== "OK") {
      return {
        ok: false,
        message:
          "vite is not installed at node_modules/.bin/vite. Pass installFirst: true on the next call, or check the template's package.json.",
      };
    }

    // Write the wrapper Vite config that overlays `server.allowedHosts: true`
    // (Vite 5+ rejects the random *.vercel.run host without this) and, in dev,
    // the Botflow visual-editor plugin (source-location stamping + in-iframe
    // selection runtime). See src/lib/preview-editor/wrapper.ts.
    const WRAPPER_CONFIG = buildBotflowViteConfig();
    await sandbox.writeFiles([{
      path: "/vercel/sandbox/.botflow-vite.config.mjs",
      content: Buffer.from(WRAPPER_CONFIG, "utf-8"),
    }]);

    // Regenerate /vercel/sandbox/.env from the DB (frontend vars + the
    // platform-managed VITE_CONVEX_URL) so Vite inlines fresh values on this
    // start. DB is the source of truth — this overwrites any drift on disk.
    try {
      await materializeFrontendEnv(projectId);
    } catch (envErr) {
      console.warn("[startSandboxDevServer] failed to materialize .env:", envErr);
    }

    // Spawn vite detached so it survives this request.
    await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        `exec ./node_modules/.bin/vite --config .botflow-vite.config.mjs --host 0.0.0.0 --port ${port} --strictPort > ${DEV_LOG_PATH} 2>&1`,
      ],
      cwd: "/vercel/sandbox",
      detached: true,
      env: { HOST: "0.0.0.0" },
    });

    // Poll for readiness. For https URLs (Vercel's forwarded domain, or a
    // sandbox-host preview behind the Cloudflare tunnel) hit the *public*
    // URL — only return success when the iframe will actually work — and
    // capture upstream headers so the workspace UI can diagnose
    // iframe-blocking directives. Plain-http sandbox-host routes are
    // tailnet-only (unreachable from production servers), so probe vite from
    // inside the VM instead.
    const probeOnce = async (): Promise<{
      status: number;
      headers?: Record<string, string>;
      body?: string;
    }> => {
      if (!previewUrl.startsWith("https://")) {
        const res = await sandbox.runCommand({
          cmd: "sh",
          args: [
            "-c",
            `curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${port}/`,
          ],
          cwd: "/vercel/sandbox",
        });
        const status = parseInt((await res.stdout()).trim(), 10);
        // curl prints 000 while the port isn't accepting connections yet.
        return { status: Number.isFinite(status) && status >= 100 ? status : 599 };
      }
      const probe = await fetch(previewUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(3_000),
      });
      const headers: Record<string, string> = {};
      probe.headers.forEach((v, k) => { headers[k] = v; });
      // Capture a snippet of error bodies so the loop can tell the preview
      // router's own 403 apart from the user's app returning 403.
      const body =
        probe.status >= 400 ? (await probe.text().catch(() => "")).slice(0, 256) : undefined;
      return { status: probe.status, headers, body };
    };

    const deadline = Date.now() + 45_000;
    let lastStatus = 0;
    while (Date.now() < deadline) {
      try {
        const { status, headers, body } = await probeOnce();
        lastStatus = status;
        // The sandbox-host preview router's own 403 means our token was
        // missing or didn't verify — retrying can't fix that, and treating it
        // as "up" would publish a preview the user can't render. Fail loudly
        // with the actual misconfiguration.
        if (status === 403 && body?.includes("preview access denied")) {
          return {
            ok: false,
            message:
              "The preview router rejected this deployment's token. " +
              (previewUrl.includes("_bft=")
                ? "PREVIEW_SIGNING_SECRET does not match the sandbox-host previewSigningSecret."
                : "The host requires signed preview tokens but PREVIEW_SIGNING_SECRET is not set in this environment."),
            previewUrl,
          };
        }
        if (status < 500) {
          // Publish to Redis so the workspace's poll picks up the running
          // state without needing client-side coordination. This is what
          // makes the agent's startDevServer call materialize the preview
          // iframe in the user's browser.
          await publishDevServerState(projectId, {
            running: true,
            previewUrl,
            port,
            updatedAt: Date.now(),
          });
          return {
            ok: true,
            message: `Dev server started on ${previewUrl} (port ${port}).`,
            previewUrl,
            port,
            responseHeaders: headers,
          };
        }
      } catch {
        // network/timeout — keep polling
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Timed out — collect diagnostics so the model can read what went wrong.
    const diag = await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        [
          "echo '--- log ---'",
          `tail -n 60 ${DEV_LOG_PATH} 2>/dev/null || echo '(log empty or missing)'`,
          "echo '--- ps ---'",
          "ps -ef 2>/dev/null | grep -E 'vite|node' | grep -v grep || echo '(no vite/node processes)'",
          "echo '--- listening ports ---'",
          "(ss -ltnp 2>/dev/null || netstat -ltn 2>/dev/null || echo '(no ss/netstat)') | head -20",
        ].join(" && "),
      ],
      cwd: "/vercel/sandbox",
    });
    const diagOut = (await diag.stdout()).trim();

    return {
      ok: false,
      message: `Dev server did not become reachable on ${previewUrl} within 45s (last upstream status: ${lastStatus}).`,
      previewUrl,
      log: diagOut.slice(-3000),
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Failed to start dev server",
    };
  }
}

export interface StopDevServerResult {
  ok: boolean;
  message: string;
  alreadyStopped?: boolean;
}

export async function stopSandboxDevServer(projectId: string): Promise<StopDevServerResult> {
  try {
    // Check first so we can report alreadyStopped accurately.
    const before = await isSandboxDevServerRunning(projectId);
    if (!before.ok) {
      return { ok: false, message: before.message };
    }
    if (!before.running) {
      return { ok: true, message: "Dev server was not running.", alreadyStopped: true };
    }

    await sandboxBash(
      projectId,
      "pkill -f 'vite' 2>/dev/null || true; sleep 0.3; rm -f " + DEV_LOG_PATH,
    );
    await publishDevServerState(projectId, {
      running: false,
      previewUrl: null,
      port: null,
      updatedAt: Date.now(),
    });
    return { ok: true, message: "Dev server stopped." };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Failed to stop dev server",
    };
  }
}

export interface IsRunningResult {
  ok: boolean;
  running: boolean;
  message: string;
}

export async function isSandboxDevServerRunning(projectId: string): Promise<IsRunningResult> {
  try {
    const result = await sandboxBash(
      projectId,
      "pgrep -f 'vite' >/dev/null 2>&1 && echo running || echo stopped",
    );
    const output = result.stdout.trim();
    const running = output === "running";
    // Reconcile cached state if it drifted (e.g., vite crashed silently).
    // Only write if we have a definite mismatch; otherwise let the start/stop
    // calls own the truth so we don't churn the workspace's poll handler.
    const cached = await getDevServerState(projectId);
    if (cached && cached.running !== running) {
      await publishDevServerState(projectId, {
        running,
        previewUrl: running ? cached.previewUrl : null,
        port: running ? cached.port : null,
        updatedAt: Date.now(),
      });
    }
    return {
      ok: true,
      running,
      message: running ? "Dev server is running." : "Dev server is not running.",
    };
  } catch (err) {
    return {
      ok: false,
      running: false,
      message: err instanceof Error ? err.message : "Failed to probe dev server",
    };
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Logs
 * ────────────────────────────────────────────────────────────────────── */

export interface LogResult {
  ok: boolean;
  message: string;
  log?: string;
}

export async function getSandboxDevServerLog(
  projectId: string,
  linesBack = 200,
): Promise<LogResult> {
  // Clamp to a sane range so the model doesn't accidentally pull megabytes.
  const lines = Math.max(1, Math.min(2000, Math.floor(linesBack) || 200));
  try {
    const result = await sandboxBash(
      projectId,
      `tail -n ${lines} ${DEV_LOG_PATH} 2>/dev/null || echo '(no dev server log found — start the dev server first)'`,
    );
    const log = result.stdout;
    if (!log.trim()) {
      return {
        ok: false,
        message:
          "Dev server has no output yet. It may not be running — call isDevServerRunning or startDevServer first.",
      };
    }
    return {
      ok: true,
      message: `Retrieved last ${lines} lines of dev server output.`,
      log,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Failed to read dev server log",
    };
  }
}

/** Push browser-side log entries into the Redis ring buffer. Called from the
 *  POST /api/projects/:id/browser-log endpoint after the client batches them. */
export async function pushBrowserLogEntries(
  projectId: string,
  entries: BrowserLogEntry[],
): Promise<void> {
  if (!entries.length) return;
  const redis = getRedis();
  const key = browserLogKey(projectId);
  // Sanitize and JSON-encode each. lpush puts newest at head.
  const encoded = entries.map((e) =>
    JSON.stringify({
      timestamp: typeof e.timestamp === "number" ? e.timestamp : Date.now(),
      level: e.level === "warn" || e.level === "error" ? e.level : "log",
      message: sanitizeOutput(String(e.message ?? "")).slice(0, 8000),
      type: e.type === "error" || e.type === "hmr" ? e.type : "console",
    }),
  );
  // Upstash supports variadic lpush.
  await redis.lpush(key, ...encoded);
  await redis.ltrim(key, 0, BROWSER_LOG_MAX - 1);
  await redis.expire(key, BROWSER_LOG_TTL_SECONDS);
}

export async function clearBrowserLog(projectId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(browserLogKey(projectId));
}

export async function getSandboxBrowserLog(
  projectId: string,
  linesBack = 200,
): Promise<LogResult> {
  const lines = Math.max(1, Math.min(BROWSER_LOG_MAX, Math.floor(linesBack) || 200));
  try {
    const redis = getRedis();
    // List has newest at head; we want oldest-first for chronological display.
    const raw = await redis.lrange(browserLogKey(projectId), 0, lines - 1);
    if (!raw || raw.length === 0) {
      return {
        ok: false,
        message:
          "No browser console logs available yet. The preview may not have loaded, or the user's browser hasn't yet pushed any events.",
      };
    }
    const entries: BrowserLogEntry[] = [];
    for (const item of raw) {
      try {
        const obj = typeof item === "string" ? JSON.parse(item) : (item as BrowserLogEntry);
        if (obj && typeof obj === "object") entries.push(obj as BrowserLogEntry);
      } catch {
        // skip malformed entries
      }
    }
    entries.reverse(); // oldest first

    const formatted = entries
      .map((e) => {
        const time = new Date(e.timestamp).toLocaleTimeString();
        const icon = e.level === "error" ? "❌" : e.level === "warn" ? "⚠️" : "ℹ️";
        const typeLabel = e.type === "console" ? "" : e.type === "error" ? "[Error] " : "[HMR] ";
        return `${time} ${icon} ${typeLabel}${e.message}`;
      })
      .join("\n");

    const errors = entries.filter((e) => e.level === "error").length;
    const warnings = entries.filter((e) => e.level === "warn").length;

    return {
      ok: true,
      message: `Retrieved ${entries.length} browser log entries (${errors} errors, ${warnings} warnings).`,
      log: formatted,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Failed to read browser log",
    };
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Preview refresh — server pushes a signal, the workspace polls + reloads
 * ────────────────────────────────────────────────────────────────────── */

export interface RefreshResult {
  ok: boolean;
  message: string;
  refreshAt?: number;
}

export async function requestSandboxPreviewRefresh(projectId: string): Promise<RefreshResult> {
  try {
    const refreshAt = Date.now();
    const redis = getRedis();
    // 60s is plenty — the client polls every 2s, so it'll see this within
    // a single poll cycle. After that there's no point keeping the key around.
    await redis.setex(previewRefreshKey(projectId), 60, String(refreshAt));
    return {
      ok: true,
      message: "Preview refresh requested. The preview pane should reload within ~2 seconds.",
      refreshAt,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Failed to request preview refresh",
    };
  }
}

/** Read the last refresh timestamp (or null). Called by the preview-state
 *  polling endpoint the workspace hits every 2s. */
export async function getPreviewRefreshAt(projectId: string): Promise<number | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get<string>(previewRefreshKey(projectId));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
