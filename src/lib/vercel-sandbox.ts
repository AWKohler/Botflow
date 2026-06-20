import { APIError, Sandbox } from "@vercel/sandbox";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";

const DEFAULT_RUNTIME = "node22";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const SANDBOX_ROOT = "/vercel/sandbox";

// When remaining VM lifetime drops below this on touch, call extendTimeout.
const EXTEND_THRESHOLD_MS = 10 * 60 * 1000;
const EXTEND_BY_MS = 15 * 60 * 1000;

// Keep one rolling auto-snapshot per sandbox; expire after 90 days of disuse
// so abandoned projects don't accumulate snapshot storage forever.
const SNAPSHOT_EXPIRATION_MS = 90 * 24 * 60 * 60 * 1000;

// Common dev-server ports we want to expose. Vercel sandboxes can expose up to 4.
// NOTE: port 8080 is reserved by the Vercel Sandbox system and will be
// rejected with `reserved_port`. Don't add it back without testing.
//  3000 — Next.js / CRA / generic Node
//  5173 — Vite dev server
//  4173 — Vite preview
//  8000 — alternate (Django/Express/Python)
const SANDBOX_PORTS: number[] = [3000, 5173, 4173, 8000];

const TEMPLATE_REPOS = {
  swift: "https://github.com/AWKohler/swift-template.git",
  swiftConvex: "https://github.com/AWKohler/swift-convex-template.git",
  viteConvex: "https://github.com/AWKohler/vite_convex_template.git",
  vite: "https://github.com/AWKohler/vite_template.git",
} as const;

export type SandboxTemplate = keyof typeof TEMPLATE_REPOS;

// Optional per-template branch override. Empty by default — every template
// clones its repo's default branch (main). Add an entry only to temporarily
// validate template changes on a non-main branch before merging.
// (swift-convex-template@feat/auth merged to main, so its pin is removed.)
const TEMPLATE_BRANCHES: Partial<Record<SandboxTemplate, string>> = {};

function assertSandboxAuth(): void {
  const hasOidcToken = Boolean(process.env.VERCEL_OIDC_TOKEN);
  const hasAccessTokenAuth =
    Boolean(process.env.VERCEL_TOKEN) &&
    Boolean(process.env.VERCEL_PROJECT_ID) &&
    Boolean(process.env.VERCEL_TEAM_ID);

  if (!hasOidcToken && !hasAccessTokenAuth) {
    throw new Error(
      "Missing Vercel Sandbox credentials. Run `vercel link` and `vercel env pull`, or set VERCEL_TOKEN, VERCEL_PROJECT_ID, and VERCEL_TEAM_ID.",
    );
  }
}

type SandboxCredentials = { token: string; teamId: string; projectId: string };

// Explicit access-token credentials for the Sandbox SDK.
//
// When VERCEL_TOKEN / VERCEL_PROJECT_ID / VERCEL_TEAM_ID are all set, return
// them so we can pass them directly to `Sandbox.get` / `Sandbox.create`. The
// SDK uses these verbatim and skips its OIDC resolution entirely.
//
// Why this matters: without explicit creds the SDK falls back to OIDC, reading
// a per-request `x-vercel-oidc-token` (prod) or `$VERCEL_OIDC_TOKEN` (local).
// Locally that token doesn't exist, so every sandbox op fails; in prod, if the
// request-scoped OIDC context is ever unavailable the SDK drops into its
// file-based token-refresh path, which throws cryptic errors (e.g. `The "path"
// argument must be of type string. Received undefined`) on the serverless
// filesystem. Passing the access token we already have makes auth deterministic
// in both environments. Returns `undefined` when the trio isn't fully set, so
// callers fall back to OIDC (the only option in that case).
function getSandboxCredentials(): SandboxCredentials | undefined {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) return { token, teamId, projectId };
  return undefined;
}

export function getSandboxName(projectId: string): string {
  return `botflow-project-${projectId}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Rate-limit retry / structured 429
// ────────────────────────────────────────────────────────────────────────────

export class SandboxRateLimitError extends Error {
  retryAfterSecs: number;
  constructor(retryAfterSecs: number, cause?: unknown) {
    super(`Vercel Sandbox rate-limited; retry after ${retryAfterSecs}s`);
    this.name = "SandboxRateLimitError";
    this.retryAfterSecs = retryAfterSecs;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

function parseRetryAfter(err: APIError<unknown>): number {
  const hdr =
    err.response?.headers?.get?.("retry-after") ||
    err.response?.headers?.get?.("Retry-After") ||
    "";
  const n = parseInt(hdr, 10);
  if (Number.isFinite(n) && n > 0) return Math.min(n, 300);
  return 5;
}

// Retry a Sandbox SDK call on 429 (honor Retry-After) and 5xx (capped backoff).
// Do NOT retry other 4xx — they're permanent (auth, validation, not-found).
// Idempotent reads/lists/get/create-or-get are safe defaults; for writes the
// caller should opt out via { retry: false }.
export async function withSandboxRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; label?: string } = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 4;
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < max) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof APIError)) throw err;
      const status = err.response.status;
      if (status === 429) {
        const retryAfter = parseRetryAfter(err);
        if (attempt === max - 1) throw new SandboxRateLimitError(retryAfter, err);
        await sleep(retryAfter * 1000);
      } else if (status >= 500 && status < 600) {
        if (attempt === max - 1) throw err;
        const backoff = Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 500;
        await sleep(backoff);
      } else {
        throw err;
      }
      attempt++;
    }
  }
  throw lastErr;
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

// ────────────────────────────────────────────────────────────────────────────
// Template selection
// ────────────────────────────────────────────────────────────────────────────

type TemplatePickerInput = {
  platform: string;
  backendType: string;
  sandboxTemplate: string | null;
};

export function pickSandboxTemplate(p: TemplatePickerInput): SandboxTemplate | null {
  // Explicit column wins
  if (
    p.sandboxTemplate === "swift" ||
    p.sandboxTemplate === "swiftConvex" ||
    p.sandboxTemplate === "vite" ||
    p.sandboxTemplate === "viteConvex"
  ) {
    return p.sandboxTemplate;
  }
  if (p.platform === "swift") {
    // Swift with a backend gets the Convex-wired template; "none" stays plain.
    return p.backendType === "none" ? "swift" : "swiftConvex";
  }
  if (p.platform === "sandboxed-web") {
    return p.backendType === "none" ? "vite" : "viteConvex";
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-project mutex around get / create
// ────────────────────────────────────────────────────────────────────────────

const acquireLocks = new Map<string, Promise<Sandbox>>();

async function acquireSandbox(projectId: string): Promise<Sandbox> {
  const existing = acquireLocks.get(projectId);
  if (existing) return existing;

  const p = (async () => {
    try {
      return await doAcquireSandbox(projectId);
    } finally {
      acquireLocks.delete(projectId);
    }
  })();
  acquireLocks.set(projectId, p);
  return p;
}

async function doAcquireSandbox(projectId: string): Promise<Sandbox> {
  assertSandboxAuth();

  const name = getSandboxName(projectId);
  const creds = getSandboxCredentials();

  // 1. Try to resume existing sandbox.
  try {
    return await withSandboxRetry(() => Sandbox.get({ name, ...creds }), { label: "Sandbox.get" });
  } catch (error) {
    if (error instanceof APIError) {
      const status = error.response.status;
      // 404 / 400 = truly gone; fall through to create. Any other status:
      // surface (withSandboxRetry has already exhausted retries for 429/5xx).
      if (status !== 404 && status !== 400) throw error;
      try {
        const body = await error.response.text();
        console.error(`Sandbox.get failed (${status}): ${body}`);
      } catch { /* body already consumed */ }
    } else {
      throw error;
    }
  }

  // 2. Create a fresh sandbox with auto-snapshot retention configured.
  //    Auto-snapshots happen on session stop (Vercel-side default for
  //    persistent sandboxes); snapshotExpiration caps how long they retain
  //    storage for an idle project. The `keepLastSnapshots` knob (count: 1)
  //    is set at runtime via an `as` cast so we still pass it through to
  //    newer SDK versions even though the local typings predate the field.
  const sandbox = await withSandboxRetry(
    () => Sandbox.create({
      ...creds,
      name,
      runtime: DEFAULT_RUNTIME,
      timeout: DEFAULT_TIMEOUT_MS,
      ports: SANDBOX_PORTS,
      snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
      ...({ keepLastSnapshots: { count: 1, deleteEvicted: true } } as object),
    } as Parameters<typeof Sandbox.create>[0]),
    { label: "Sandbox.create" },
  ).catch((error) => {
    if (error instanceof APIError) {
      const errAny = error as unknown as { text?: string; json?: unknown };
      const bodyText =
        errAny.text || (errAny.json ? JSON.stringify(errAny.json) : "");
      console.error(
        `Sandbox.create failed (${error.response.status}) for project ${projectId}:\n` +
          `  body: ${bodyText || "<empty>"}`,
      );
      throw new Error(
        `Failed to create sandbox (${error.response.status}): ${bodyText || error.message}`,
      );
    }
    throw error;
  });

  // 3. After a true 404 → create, the sandbox is empty. Auto-reseed using the
  //    project's stored template so callers don't silently get a blank VM.
  //    Best-effort: failures don't block returning the sandbox.
  try {
    const [project] = await getDb()
      .select({
        platform: projects.platform,
        backendType: projects.backendType,
        sandboxTemplate: projects.sandboxTemplate,
      })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (project) {
      const template = pickSandboxTemplate(project);
      if (template) {
        await seedSandboxInternal(sandbox, template).catch((e) =>
          console.warn(`[vercel-sandbox] auto-reseed after recreate failed: ${e}`),
        );
      }
    }
  } catch (e) {
    console.warn(`[vercel-sandbox] auto-reseed lookup failed: ${e}`);
  }

  return sandbox;
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry point + lifecycle
// ────────────────────────────────────────────────────────────────────────────

export async function getOrCreatePersistentSandbox(projectId: string) {
  const sandbox = await acquireSandbox(projectId);

  // Heartbeat: if the session is close to its timeout, extend it. The SDK is
  // tolerant of extendTimeout being called on a freshly-created sandbox.
  try {
    const session = (sandbox as unknown as {
      session?: {
        stoppedAt?: Date;
        expiresAt?: Date;
        extendTimeout?: (ms: number) => Promise<void>;
      };
      extendTimeout?: (ms: number) => Promise<void>;
    }).session;
    const expiresAt: Date | undefined = session?.expiresAt;
    const extend =
      session?.extendTimeout?.bind(session) ??
      (sandbox as unknown as { extendTimeout?: (ms: number) => Promise<void> })
        .extendTimeout?.bind(sandbox);
    if (expiresAt && extend) {
      const remaining = expiresAt.getTime() - Date.now();
      if (remaining > 0 && remaining < EXTEND_THRESHOLD_MS) {
        await extend(EXTEND_BY_MS).catch(() => undefined);
      }
    }
  } catch { /* SDK shape drift — non-fatal */ }

  // Bookkeeping: record activity for the reaper. Best-effort, never blocks.
  recordSandboxActivity(projectId).catch(() => undefined);

  return sandbox;
}

// Throttle DB activity updates: write at most once per minute per project.
const lastActivityWrite = new Map<string, number>();
const ACTIVITY_DEBOUNCE_MS = 60_000;

async function recordSandboxActivity(projectId: string): Promise<void> {
  const now = Date.now();
  const last = lastActivityWrite.get(projectId) ?? 0;
  if (now - last < ACTIVITY_DEBOUNCE_MS) return;
  lastActivityWrite.set(projectId, now);
  try {
    await getDb()
      .update(projects)
      .set({ lastSandboxActivityAt: new Date(now) })
      .where(eq(projects.id, projectId));
  } catch (e) {
    // Don't break sandbox operations because of a DB hiccup.
    console.warn(`[vercel-sandbox] failed to record activity: ${e}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Seeding
// ────────────────────────────────────────────────────────────────────────────

async function seedSandboxInternal(sandbox: Sandbox, template: SandboxTemplate): Promise<boolean> {
  const check = await sandbox.runCommand("sh", [
    "-c",
    `ls -A ${SANDBOX_ROOT} 2>/dev/null | grep -v '^node_modules$' | grep -v '^\\.git$' | head -1 || true`,
  ]);
  const out = (await check.stdout()).trim();
  if (out) return false;

  const repoUrl = TEMPLATE_REPOS[template];
  const branch = TEMPLATE_BRANCHES[template];
  const branchFlag = branch ? `--branch ${branch} ` : "";
  const tmpDir = `/tmp/${template}-template`;

  const seed = await sandbox.runCommand("sh", [
    "-c",
    [
      "set -e",
      `rm -rf ${tmpDir}`,
      `git clone --depth=1 ${branchFlag}${repoUrl} ${tmpDir}`,
      `cp -a ${tmpDir}/. ${SANDBOX_ROOT}/`,
      `rm -rf ${SANDBOX_ROOT}/.git`,
      `rm -rf ${tmpDir}`,
    ].join(" && "),
  ]);

  if (seed.exitCode !== 0) {
    const stderr = await seed.stderr();
    throw new Error(`Failed to seed ${template} template: ${stderr || `exit ${seed.exitCode}`}`);
  }

  return true;
}

/**
 * Seed a fresh sandbox with the appropriate template if /vercel/sandbox is empty.
 * Returns true if seeded, false if files already existed.
 */
export async function seedSandboxIfEmpty(
  projectId: string,
  template: SandboxTemplate = "swift",
): Promise<boolean> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  return seedSandboxInternal(sandbox, template);
}

/**
 * Seed an empty sandbox by extracting a gzipped-tar source bundle (produced by
 * `tarSandboxProject`, e.g. a forked public project's source) into the sandbox
 * root, instead of cloning a template repo. Returns true if seeded, false if the
 * sandbox already had content.
 */
export async function seedSandboxFromBundle(
  projectId: string,
  bundleUrl: string,
): Promise<boolean> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);

  const check = await sandbox.runCommand("sh", [
    "-c",
    `ls -A ${SANDBOX_ROOT} 2>/dev/null | grep -v '^node_modules$' | grep -v '^\\.git$' | head -1 || true`,
  ]);
  if ((await check.stdout()).trim()) return false;

  const res = await fetch(bundleUrl);
  if (!res.ok) throw new Error(`Failed to download source bundle (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());

  const tmp = `/tmp/seed-${projectId}.tar.gz`;
  await sandbox.writeFiles([{ path: tmp, content: buf }]);

  const extract = await sandbox.runCommand("sh", [
    "-c",
    `mkdir -p ${SANDBOX_ROOT} && tar xzf ${tmp} -C ${SANDBOX_ROOT} && rm -f ${tmp}`,
  ]);
  if (extract.exitCode !== 0) {
    throw new Error(`Bundle extract failed: ${(await extract.stderr()) || `exit ${extract.exitCode}`}`);
  }
  return true;
}

/**
 * Write a `.env` file at the sandbox root from a record of key/value pairs.
 */
export async function writeSandboxEnvFile(
  projectId: string,
  envVars: Record<string, string>,
): Promise<void> {
  const lines = Object.entries(envVars)
    .filter(([k, v]) => k && typeof v === "string")
    .map(([k, v]) => `${k}=${v}`);
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  await sandbox.writeFiles([{
    path: `${SANDBOX_ROOT}/.env`,
    content: Buffer.from(lines.join("\n") + (lines.length ? "\n" : ""), "utf-8"),
  }]);
}

export type PersistentSandboxSmokeTest = {
  sandboxName: string;
  runtime: string | undefined;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function runPersistentSandboxSmokeTest(
  projectId: string,
): Promise<PersistentSandboxSmokeTest> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const result = await sandbox.runCommand("node", [
    "-e",
    [
      "const payload = {",
      `  projectId: ${JSON.stringify(projectId)},`,
      "  runtime: process.version,",
      "  cwd: process.cwd(),",
      "};",
      "console.log(JSON.stringify(payload));",
    ].join("\n"),
  ]);

  return {
    sandboxName: sandbox.name,
    runtime: sandbox.runtime,
    exitCode: result.exitCode,
    stdout: await result.stdout(),
    stderr: await result.stderr(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Reaper helpers (lifecycle teardown)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Permanently delete the persistent sandbox for a project — VM + auto-snapshot.
 * Used by the reaper when a project is being archived/deleted. Idempotent:
 * a 404 from the SDK is treated as success.
 */
export async function deletePersistentSandbox(projectId: string): Promise<void> {
  assertSandboxAuth();
  const name = getSandboxName(projectId);
  const creds = getSandboxCredentials();
  try {
    const sandbox = await withSandboxRetry(() => Sandbox.get({ name, ...creds }), {
      label: "Sandbox.get(reaper)",
    });
    const s = sandbox as unknown as { delete?: () => Promise<void>; stop?: () => Promise<void> };
    if (typeof s.delete === "function") {
      await withSandboxRetry(() => s.delete!(), { label: "Sandbox.delete" });
    } else if (typeof s.stop === "function") {
      // Older SDK: stop is the best we can do.
      await withSandboxRetry(() => s.stop!(), { label: "Sandbox.stop" });
    }

    // Also evict any retained snapshots so storage actually drops to zero.
    try {
      const ls = (sandbox as unknown as {
        listSnapshots?: (p?: { limit?: number }) => Promise<{ snapshots: { id: string }[] }>;
        deleteSnapshot?: (id: string) => Promise<void>;
      });
      if (ls.listSnapshots && ls.deleteSnapshot) {
        const page = await ls.listSnapshots({ limit: 50 });
        for (const snap of page.snapshots ?? []) {
          await ls.deleteSnapshot(snap.id).catch(() => undefined);
        }
      }
    } catch { /* best-effort */ }
  } catch (error) {
    if (error instanceof APIError && (error.response.status === 404 || error.response.status === 400)) {
      return; // already gone
    }
    throw error;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers used by the persistent agent (server-side tool execution)
// ────────────────────────────────────────────────────────────────────────────

function toAbsPath(projectRelative: string): string {
  const trimmed = projectRelative.startsWith("/")
    ? projectRelative.slice(1)
    : projectRelative;
  return trimmed ? `${SANDBOX_ROOT}/${trimmed}` : SANDBOX_ROOT;
}

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function sandboxRun(
  projectId: string,
  cmd: string,
  args: string[] = [],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);

  const command = await sandbox.runCommand({
    cmd,
    args,
    cwd: opts.cwd ?? SANDBOX_ROOT,
    detached: true,
  });

  // Wire the previously-dead timeoutMs option: if the underlying wait()
  // hasn't resolved by the deadline, kill the command and surface a real
  // timeout error rather than hanging the caller indefinitely.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortCtrl: AbortController | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    abortCtrl = new AbortController();
    timer = setTimeout(() => abortCtrl?.abort(), opts.timeoutMs);
  }
  try {
    const result = await command.wait(abortCtrl ? { signal: abortCtrl.signal } : undefined);
    return {
      exitCode: result.exitCode,
      stdout: await result.stdout(),
      stderr: await result.stderr(),
    };
  } catch (e) {
    if (abortCtrl?.signal.aborted) {
      throw new Error(`sandboxRun timed out after ${opts.timeoutMs}ms: ${cmd}`);
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function sandboxBash(
  projectId: string,
  script: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return sandboxRun(projectId, "bash", ["-lc", script], opts);
}

export async function sandboxReadFile(
  projectId: string,
  projectRelativePath: string,
): Promise<{ content: string; binary: boolean } | null> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const buf = await sandbox.readFileToBuffer({ path: toAbsPath(projectRelativePath) });
  if (!buf) return null;
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { content, binary: false };
  } catch {
    return { content: Buffer.from(buf).toString("base64"), binary: true };
  }
}

export async function sandboxWriteFile(
  projectId: string,
  projectRelativePath: string,
  content: string,
): Promise<void> {
  const sandbox = await getOrCreatePersistentSandbox(projectId);
  const abs = toAbsPath(projectRelativePath);
  const dir = abs.substring(0, abs.lastIndexOf("/"));
  if (dir && dir !== SANDBOX_ROOT) {
    // mkDir from the SDK throws APIError 400 if the dir already exists, so
    // shell out to `mkdir -p` instead — idempotent and recursive.
    await sandbox.runCommand("mkdir", ["-p", dir]);
  }
  await sandbox.writeFiles([{
    path: abs,
    content: Buffer.from(content, "utf-8"),
  }]);
}

export async function sandboxListFiles(
  projectId: string,
  projectRelativePath: string,
  recursive: boolean,
): Promise<Array<{ path: string; type: "file" | "folder" }>> {
  const abs = toAbsPath(projectRelativePath);
  const findArgs = recursive
    ? [abs, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-name", ".DS_Store", "-printf", "%y %p\n"]
    : [abs, "-mindepth", "1", "-maxdepth", "1", "-not", "-name", "node_modules", "-not", "-name", ".git", "-not", "-name", ".DS_Store", "-printf", "%y %p\n"];

  const { stdout } = await sandboxRun(projectId, "find", findArgs);

  const entries: Array<{ path: string; type: "file" | "folder" }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx < 0) continue;
    const kind = trimmed.slice(0, spaceIdx);
    const rawPath = trimmed.slice(spaceIdx + 1);
    const projPath = rawPath.replace(SANDBOX_ROOT, "") || "/";
    if (projPath === "/" || projPath === "") continue;
    entries.push({ path: projPath, type: kind === "d" ? "folder" : "file" });
  }
  return entries;
}

/**
 * Cheap "did the file tree change?" probe.
 *
 * Returns a single short signature string derived from the path, type, size,
 * and mtime of every file/folder in the project (excluding node_modules/.git).
 * The client polls this on an interval and only re-fetches the full listing
 * when the signature differs from the last one it saw — so the common case
 * (nothing changed) costs one `find | cksum` and a few bytes over the wire,
 * not a full recursive tree transfer.
 *
 * Because the signature folds in size+mtime, it flips on creates, deletes,
 * renames, AND in-place edits (e.g. `touch`, agent writes, `git pull`).
 */
export async function sandboxTreeSignature(projectId: string): Promise<string> {
  // `%y %s %T@ %p` → type, size, mtime(epoch), path. Sorting makes the hash
  // order-independent across find's traversal; cksum gives "<sum> <bytes>".
  const script =
    `find ${SANDBOX_ROOT} ` +
    `-not -path '*/node_modules/*' -not -path '*/.git/*' -not -name .DS_Store ` +
    `-printf '%y %s %T@ %p\\n' | LC_ALL=C sort | cksum`;
  // No `pipefail`: `find` can exit non-zero on a benign traversal warning, and
  // we don't want that to mask a perfectly good signature. The pipeline's exit
  // is `cksum`'s, which only fails if it couldn't read stdin at all.
  const res = await sandboxBash(projectId, script, { timeoutMs: 30_000 });
  // Non-zero usually means a transient hiccup; return empty so the caller
  // treats it as "unknown" and doesn't trigger a spurious reconcile.
  if (res.exitCode !== 0) return "";
  return res.stdout.trim();
}

// Recursive grep using ripgrep when available, falling back to grep -r.
export async function sandboxGrep(
  projectId: string,
  pattern: string,
  opts: { path?: string; glob?: string; caseInsensitive?: boolean; maxResults?: number } = {},
): Promise<Array<{ file: string; line: number; text: string }>> {
  const searchPath = toAbsPath(opts.path ?? "/");
  const max = opts.maxResults ?? 200;
  const flags = ["--no-heading", "--line-number", "--color=never"];
  if (opts.caseInsensitive) flags.push("-i");
  if (opts.glob) flags.push("--glob", opts.glob);
  flags.push("--max-count", "20");
  flags.push("-e", pattern, searchPath);

  let stdout = "";
  // When `rg` isn't installed in the sandbox image, the sandbox API rejects
  // the spawn with a 400 (APIError) instead of returning an exit code — treat
  // that the same as a non-0/1 exit and fall back to grep.
  const rg = await sandboxRun(projectId, "rg", flags).catch(() => null);
  if (rg && (rg.exitCode === 0 || rg.exitCode === 1)) {
    stdout = rg.stdout;
  } else {
    // ripgrep not available — fall back to grep -rn
    const grepFlags = ["-rn", "--exclude-dir=node_modules", "--exclude-dir=.git"];
    if (opts.caseInsensitive) grepFlags.push("-i");
    if (opts.glob) grepFlags.push(`--include=${opts.glob}`);
    grepFlags.push("-e", pattern, searchPath);
    const grep = await sandboxRun(projectId, "grep", grepFlags);
    stdout = grep.stdout;
  }

  const results: Array<{ file: string; line: number; text: string }> = [];
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    const first = raw.indexOf(":");
    if (first < 0) continue;
    const second = raw.indexOf(":", first + 1);
    if (second < 0) continue;
    const file = raw.slice(0, first).replace(SANDBOX_ROOT, "");
    const line = parseInt(raw.slice(first + 1, second), 10);
    const text = raw.slice(second + 1);
    if (Number.isNaN(line)) continue;
    results.push({ file, line, text });
    if (results.length >= max) break;
  }
  return results;
}

/**
 * Tar (gzipped) the project's source tree from the persistent sandbox and
 * return it as a Buffer.
 */
export async function tarSandboxProject(
  projectId: string,
  opts: { excludeConvex?: boolean } = {},
): Promise<Buffer> {
  const excludes = [
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=.build",
    "--exclude=build",
    "--exclude=dist",
    "--exclude=*.xcodeproj/xcuserdata",
    "--exclude=*.xcodeproj/project.xcworkspace/xcuserdata",
    "--exclude=DerivedData",
    "--exclude=.DS_Store",
  ];
  // Swift simulator builds don't compile the TypeScript Convex backend, so the
  // /convex tree is dead weight in the bytes shipped to the controller on every
  // start/rebuild. The backend reaches Convex through the separate deploy
  // pipeline (buildConvexDeployZip), not this tarball.
  if (opts.excludeConvex) {
    excludes.push("--exclude=./convex", "--exclude=convex");
  }
  const cmd = [
    "set -o pipefail",
    `tar czf - ${excludes.join(" ")} -C ${SANDBOX_ROOT} . 2>/dev/null | base64 -w 0`,
    'rc=$?',
    '[ $rc -eq 0 ] || [ $rc -eq 1 ]',
  ].join(" ; ");
  const res = await sandboxBash(projectId, cmd, { timeoutMs: 120_000 });
  if (res.exitCode !== 0) {
    throw new Error(`tar failed (${res.exitCode}): ${res.stderr || res.stdout || "(no output)"}`);
  }
  const b64 = res.stdout.trim();
  if (!b64) {
    throw new Error("tar produced empty output");
  }
  return Buffer.from(b64, "base64");
}

export async function sandboxGlob(
  projectId: string,
  pattern: string,
  opts: { path?: string; maxResults?: number } = {},
): Promise<string[]> {
  const searchPath = toAbsPath(opts.path ?? "/");
  const max = opts.maxResults ?? 500;

  const script = [
    "set -e",
    "shopt -s globstar nullglob dotglob",
    `cd ${searchPath}`,
    `for f in ${pattern}; do`,
    `  case "$f" in`,
    `    */node_modules/*|node_modules/*|*/.git/*|.git/*) continue ;;`,
    `  esac`,
    `  printf '%s\\n' "$f"`,
    `done`,
  ].join("\n");

  const { stdout } = await sandboxRun(projectId, "bash", ["-c", script]);
  const lines = stdout.split("\n").filter(Boolean);
  return lines.slice(0, max).map(p => {
    const abs = p.startsWith("/") ? p : `${searchPath}/${p}`;
    return abs.replace(SANDBOX_ROOT, "") || "/";
  });
}
