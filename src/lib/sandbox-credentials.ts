/**
 * Personal credentials and shared sandboxes.
 *
 * A project sandbox is readable and writable by every member (terminal,
 * files, agents). The one personal credential that can live there is the
 * owner's Codex (ChatGPT-plan) sign-in, written by OpenCode turns, because
 * OpenCode's ChatGPT plugin can't be routed through the LLM proxy.
 *
 * Rules:
 *  1. Once a project has been shared (projects.shared_at, sticky), no
 *     personal credential is ever written to its sandbox again, and nothing
 *     is ever adopted FROM it. Removing every member does not restore trust:
 *     an ex-member could have planted tokens or left a process behind.
 *  2. Before anyone else gets access, the sandbox is purged: every OpenCode
 *     process is killed and the auth store deleted, verified, fail-closed.
 *  3. Both of the above and every Codex credential write/adoption run under
 *     one per-project lock, so "a Codex turn is writing tokens" and "the
 *     project is becoming shared" don't interleave in the database.
 *  4. Correctness does NOT depend on that lock's timing:
 *     - in the database, sharing and the writer's claim are single
 *       compare-and-set statements (a writer may mark the sandbox 'present'
 *       only while shared_at IS NULL; sharing sets shared_at and reads the
 *       state in one statement), so a share always sees a writer that may
 *       write, and a writer that loses never writes;
 *     - in the sandbox, the purge first sets a sticky marker, and every
 *       Codex write is one shell that refuses if the marker exists and
 *       re-checks it after writing (src/lib/agent/opencode/setup.ts). A
 *       write shell that starts after the marker exists writes nothing; one
 *       that started before it finishes long before the purge verifies.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chatSessions, projectMembers, projects, type Project } from "@/db/schema";
import { REDIS_CONFIGURED, redis } from "@/lib/redis";
import { isSandboxPlatform } from "@/lib/project-platform";
import { SandboxCredentialRefused, purgeOpenCodeCredentials } from "@/lib/agent/opencode/setup";
import { getTurnRecords, isTurnLive, markTurnDead } from "@/lib/agent/claude-code/turn-registry";
import { revokeToolToken } from "@/lib/agent/claude-code/tool-token";
import { revokeLlmProxyToken } from "@/lib/agent/llm-proxy/token";

/** Covers a cold sandbox resume + purge. Sandbox safety doesn't depend on
 *  it (see rule 4); it only keeps the database state consistent. */
const LOCK_TTL_SECONDS = 60;
const lockKey = (projectId: string) => `sandbox-credential-lock:${projectId}`;

export class SandboxCredentialLockTimeout extends Error {
  constructor() {
    super("Timed out waiting for the project's sandbox credential lock");
  }
}

/** A personal-credential write cleared to run before the project was shared
 *  may still be in flight; nobody else may be admitted until it ends. */
export class SandboxCredentialWriteInProgress extends Error {
  constructor() {
    super("A personal-credential write may still be in flight in this project's sandbox");
  }
}

/** Longer than any route that writes a personal credential can live
 *  (maxDuration 300s), so a stalled writer is certainly dead after it. */
const CREDENTIAL_WRITE_WINDOW_SECONDS = 360;

/** No real Redis is configured, so the credential lock can't be taken. */
export class SandboxCredentialLockUnavailable extends Error {
  constructor() {
    super("Sandbox credential operations need Redis (UPSTASH_REDIS_REST_URL/TOKEN)");
  }
}

async function withCredentialLock<T>(projectId: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
  // The no-op Redis fallback "grants" every lock; never accept that here.
  if (!REDIS_CONFIGURED) throw new SandboxCredentialLockUnavailable();
  const key = lockKey(projectId);
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const res = await redis.set(key, token, { nx: true, ex: LOCK_TTL_SECONDS });
    if (res === "OK") break;
    if (Date.now() >= deadline) throw new SandboxCredentialLockTimeout();
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock (it may have expired and been re-taken).
    const current = await redis.get<string>(key).catch(() => null);
    if (current === token) await redis.del(key).catch(() => {});
  }
}

/** False once the project has ever been shared. */
export function personalSandboxCredentialsAllowed(project: Pick<Project, "sharedAt">): boolean {
  return project.sharedAt == null;
}

async function loadCredentialState(projectId: string) {
  const [row] = await getDb()
    .select({
      id: projects.id,
      platform: projects.platform,
      sharedAt: projects.sharedAt,
      sandboxCredentials: projects.sandboxCredentials,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

export interface SecureForSharingResult {
  /** OpenCode agents that were running and had to be stopped. */
  stoppedAgents: number;
}

/**
 * Mark the project shared (sticky) and make sure its sandbox holds no
 * personal credential. Call BEFORE granting anyone else access; throws (and
 * the caller must refuse) if the sandbox can't be verified clean.
 * Cheap when the sandbox is known clean: no sandbox is woken.
 */
export async function secureProjectForSharing(
  projectId: string,
  opts: { waitMs?: number } = {},
): Promise<SecureForSharingResult> {
  return withCredentialLock(projectId, opts.waitMs ?? 45_000, async () => {
    const db = getDb();
    // ONE statement marks the project shared and reads the credential state
    // as of that moment. A credential writer flips the state to 'present'
    // only WHERE shared_at IS NULL, so either its flip landed first (we see
    // 'present' and purge) or it fails and never writes — whatever the
    // timing of either side.
    const [state] = await db
      .update(projects)
      .set({ sharedAt: sql`coalesce(${projects.sharedAt}, now())` })
      .where(eq(projects.id, projectId))
      .returning({
        platform: projects.platform,
        sandboxCredentials: projects.sandboxCredentials,
        credentialWriteUntil: projects.credentialWriteUntil,
      });
    if (!state) throw new Error(`secureProjectForSharing: project ${projectId} not found`);
    // A writer that claimed before this share may still be running (it can
    // outlive the lock, never its route): don't let anyone in until it has
    // finished or certainly died. shared_at is already set, so no new
    // writer can claim meanwhile.
    // Compared on the app clock, which also set the window (independent of
    // the database's time zone).
    if (state.credentialWriteUntil && state.credentialWriteUntil.getTime() > Date.now()) {
      throw new SandboxCredentialWriteInProgress();
    }
    if (state.sandboxCredentials === "none") return { stoppedAgents: 0 };

    let stoppedAgents = 0;
    if (isSandboxPlatform(state.platform)) {
      ({ stoppedAgents } = await purgeOpenCodeCredentials(projectId));
      await retireOpenCodeTurns(projectId);
    }
    await db.update(projects).set({ sandboxCredentials: "none" }).where(eq(projects.id, projectId));
    return { stoppedAgents };
  });
}

/**
 * Run `fn` (which writes a personal credential into the sandbox, or adopts
 * one from it) only while the project has never been shared, holding the
 * credential lock throughout. Marks the sandbox as holding a credential
 * BEFORE `fn` runs, so a later share always purges.
 */
export async function withPersonalSandboxCredential<T>(
  projectId: string,
  fn: (claim: { until: Date }) => Promise<T>,
  opts: {
    waitMs?: number;
    /** 'read' (e.g. the post-turn rotation sync) only reads the sandbox: it
     *  runs under the lock and the shared checks but claims no write window. */
    mode?: "write" | "read";
  } = {},
): Promise<{ ok: true; value: T } | { ok: false; reason: "shared" | "busy" }> {
  return withCredentialLock(projectId, opts.waitMs ?? 15_000, async () => {
    const state = await loadCredentialState(projectId);
    if (!state || !personalSandboxCredentialsAllowed(state)) return { ok: false, reason: "shared" };
    // Belt and braces: any member row at all (e.g. an invite written by an
    // older deployment that didn't set shared_at) means shared.
    const [member] = await getDb()
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId))
      .limit(1);
    if (member) {
      await getDb().update(projects).set({ sharedAt: new Date() }).where(eq(projects.id, projectId));
      return { ok: false, reason: "shared" };
    }
    if (opts.mode === "read") {
      const value = await fn({ until: new Date(0) });
      // Re-validate AFTER the sandbox read: a read that outlived its lease
      // may have run after a share admitted someone who planted the file.
      // Callers must only act on the returned value, never inside fn.
      const after = await loadCredentialState(projectId);
      const [memberAfter] = await getDb()
        .select({ id: projectMembers.id })
        .from(projectMembers)
        .where(eq(projectMembers.projectId, projectId))
        .limit(1);
      if (!after || after.sharedAt || memberAfter) return { ok: false, reason: "shared" };
      return { ok: true, value };
    }
    const claim = await claimSandboxForCredential(projectId);
    if (claim === "shared" || claim === "busy") return { ok: false, reason: claim };
    const release = () =>
      getDb()
        .update(projects)
        .set({ credentialWriteUntil: null })
        .where(and(eq(projects.id, projectId), eq(projects.credentialWriteUntil, claim.until)))
        .catch((err) => console.warn("[sandbox-credentials] could not release write window:", err));
    let value: T;
    try {
      value = await fn(claim);
    } catch (err) {
      // Release early only when the sandbox definitely wrote nothing. Any
      // other failure (transport error, timeout) leaves it unknown whether
      // the shell is still running, so the window stays until it expires.
      if (err instanceof SandboxCredentialRefused) await release();
      throw err;
    }
    await release();
    return { ok: true, value };
  });
}

/**
 * Compare-and-set: claim the sandbox for a personal credential only if the
 * project is STILL unshared at this instant (pairs with the single
 * statement in secureProjectForSharing) AND no earlier write's window is
 * still open — an earlier write that failed ambiguously may still be
 * running, and replacing its window would let a share admit someone while
 * it does. Opens the in-flight window that keeps a share from admitting
 * anyone until this write is over. Exported for tests.
 */
export async function claimSandboxForCredential(
  projectId: string,
): Promise<{ until: Date } | "shared" | "busy"> {
  const now = new Date();
  // Millisecond precision (computed here, not with now()) so the release
  // can match this exact value after a round trip.
  const until = new Date(now.getTime() + CREDENTIAL_WRITE_WINDOW_SECONDS * 1000);
  const [row] = await getDb()
    .update(projects)
    .set({ sandboxCredentials: "present", credentialWriteUntil: until })
    .where(
      and(
        eq(projects.id, projectId),
        isNull(projects.sharedAt),
        or(isNull(projects.credentialWriteUntil), lte(projects.credentialWriteUntil, now)),
      ),
    )
    .returning({ id: projects.id });
  if (row) return { until };
  const state = await loadCredentialState(projectId);
  return !state || state.sharedAt ? "shared" : "busy";
}

/** After a purge killed every OpenCode process: mark their turns dead (so
 *  threads stop showing them as running and recovery won't reattach) and
 *  revoke their callback and LLM-proxy tokens. */
async function retireOpenCodeTurns(projectId: string): Promise<void> {
  const threads = await getDb()
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(eq(chatSessions.projectId, projectId));
  const records = await getTurnRecords(projectId, threads.map((t) => t.id));
  for (const [threadId, record] of records) {
    if (record.backend !== "opencode" || !isTurnLive(record)) continue;
    if (record.toolToken) await revokeToolToken(record.toolToken).catch(() => {});
    if (record.llmProxyToken) await revokeLlmProxyToken(record.llmProxyToken).catch(() => {});
    await markTurnDead(projectId, threadId, record.turnId).catch(() => {});
  }
}
