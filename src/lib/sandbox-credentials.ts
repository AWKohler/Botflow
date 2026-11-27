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
 *     project is becoming shared" can never interleave.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects, type Project } from "@/db/schema";
import { redis } from "@/lib/redis";
import { isSandboxPlatform } from "@/lib/project-platform";
import { purgeOpenCodeCredentials } from "@/lib/agent/opencode/setup";

/** Longer than any critical section (cold sandbox resume + purge). */
const LOCK_TTL_SECONDS = 180;
const lockKey = (projectId: string) => `sandbox-credential-lock:${projectId}`;

export class SandboxCredentialLockTimeout extends Error {
  constructor() {
    super("Timed out waiting for the project's sandbox credential lock");
  }
}

async function withCredentialLock<T>(projectId: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
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
    const state = await loadCredentialState(projectId);
    if (!state) throw new Error(`secureProjectForSharing: project ${projectId} not found`);
    if (!state.sharedAt) {
      await db.update(projects).set({ sharedAt: new Date() }).where(eq(projects.id, projectId));
    }
    if (state.sandboxCredentials === "none") return { stoppedAgents: 0 };

    let stoppedAgents = 0;
    if (isSandboxPlatform(state.platform)) {
      ({ stoppedAgents } = await purgeOpenCodeCredentials(projectId));
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
  fn: () => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<{ ok: true; value: T } | { ok: false; reason: "shared" }> {
  return withCredentialLock(projectId, opts.waitMs ?? 15_000, async () => {
    const state = await loadCredentialState(projectId);
    if (!state || !personalSandboxCredentialsAllowed(state)) return { ok: false, reason: "shared" };
    if (state.sandboxCredentials !== "present") {
      await getDb().update(projects).set({ sandboxCredentials: "present" }).where(eq(projects.id, projectId));
    }
    return { ok: true, value: await fn() };
  });
}
