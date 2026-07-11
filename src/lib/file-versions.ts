/**
 * Conflict safety — file version history + write breadcrumbs
 * (docs/features/project-sharing-plan.md §6.4–6.5).
 *
 * Every INSTRUMENTED write (editor saves, Botflow-agent writeFile/applyDiff)
 * records a version row and a short-lived Redis breadcrumb. Writes that
 * happen inside the sandbox (Claude Code / OpenCode edits, terminal, build
 * tools) are NOT captured — restore therefore covers instrumented writes
 * only, and the UI must say so. Claude Code's own edit tool re-reads before
 * editing (natural CAS), which is why the gap is acceptable (plan §6.4).
 *
 * All functions here are BEST-EFFORT from the caller's perspective: a
 * version-log or breadcrumb failure must never fail the user's save — the
 * exported helpers swallow their own errors and log instead.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { projectFileVersions } from '@/db/schema';
import { redis } from '@/lib/redis';

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Versions kept per (project, path); oldest pruned beyond this. */
const MAX_VERSIONS_PER_FILE = 20;
/** Files larger than this are not versioned (plan §6.5 size cap). */
const MAX_VERSIONED_BYTES = 512 * 1024;

export type WriteActorType = 'user' | 'agent' | 'system';

export interface WriteActor {
  type: WriteActorType;
  /** Clerk id of the human behind the write (the saver, or the agent turn's
   *  acting user). Absent only for system writes. */
  userId?: string;
}

/**
 * Append a version row for an instrumented write. Skips (without error) when
 * the content is oversized or identical to the latest version (hash dedup).
 * Prunes beyond MAX_VERSIONS_PER_FILE. Never throws.
 */
export async function recordFileVersion(opts: {
  projectId: string;
  path: string;
  content: string;
  actor: WriteActor;
}): Promise<void> {
  try {
    const size = Buffer.byteLength(opts.content, 'utf8');
    if (size > MAX_VERSIONED_BYTES) return;
    const hash = sha256Hex(opts.content);
    const db = getDb();

    const [latest] = await db
      .select({ id: projectFileVersions.id, hash: projectFileVersions.hash })
      .from(projectFileVersions)
      .where(and(eq(projectFileVersions.projectId, opts.projectId), eq(projectFileVersions.path, opts.path)))
      .orderBy(desc(projectFileVersions.createdAt))
      .limit(1);
    if (latest?.hash === hash) return;

    await db.insert(projectFileVersions).values({
      projectId: opts.projectId,
      path: opts.path,
      content: opts.content,
      hash,
      size,
      actorType: opts.actor.type,
      actorUserId: opts.actor.userId ?? null,
    });

    // Prune: keep the newest MAX_VERSIONS_PER_FILE rows for this file.
    const stale = await db
      .select({ id: projectFileVersions.id })
      .from(projectFileVersions)
      .where(and(eq(projectFileVersions.projectId, opts.projectId), eq(projectFileVersions.path, opts.path)))
      .orderBy(desc(projectFileVersions.createdAt))
      .offset(MAX_VERSIONS_PER_FILE);
    if (stale.length > 0) {
      await db.delete(projectFileVersions).where(inArray(projectFileVersions.id, stale.map((r) => r.id)));
    }
  } catch (err) {
    console.warn('[file-versions] recordFileVersion failed:', err);
  }
}

// ─── Write breadcrumbs (plan §6.4) ───────────────────────────────────────────

const BREADCRUMB_TTL_SECONDS = 120;

interface WriteBreadcrumb {
  actorType: WriteActorType;
  actorUserId?: string;
  at: number;
}

function breadcrumbKey(projectId: string, path: string): string {
  return `filewrite:${projectId}:${path}`;
}

/** Stamp "who wrote this file last" — short TTL, advisory only. Never throws. */
export async function touchWriteBreadcrumb(
  projectId: string,
  path: string,
  actor: WriteActor,
): Promise<void> {
  try {
    const crumb: WriteBreadcrumb = { actorType: actor.type, actorUserId: actor.userId, at: Date.now() };
    await redis.setex(breadcrumbKey(projectId, path), BREADCRUMB_TTL_SECONDS, JSON.stringify(crumb));
  } catch {
    // advisory only
  }
}

/**
 * When a DIFFERENT actor wrote this file within the breadcrumb window,
 * returns a one-line warning to append to an agent tool result — agents
 * respond well to in-band signals (plan §6.4). Null when clear. Never throws.
 */
export async function recentForeignWriteWarning(
  projectId: string,
  path: string,
  actor: WriteActor,
): Promise<string | null> {
  try {
    const raw = await redis.get<string | WriteBreadcrumb>(breadcrumbKey(projectId, path));
    if (!raw) return null;
    const crumb = typeof raw === 'object' ? raw : (JSON.parse(raw) as WriteBreadcrumb);
    if (!crumb?.at) return null;
    const sameActor =
      crumb.actorUserId && actor.userId
        ? crumb.actorUserId === actor.userId && crumb.actorType === actor.type
        : crumb.actorType === actor.type;
    if (sameActor) return null;
    const seconds = Math.max(1, Math.round((Date.now() - crumb.at) / 1000));
    const who = crumb.actorType === 'user' ? 'a collaborator in the editor' : "another user's agent";
    return `Note: this file was modified ${seconds}s ago by ${who} — re-read it before making further edits if your change assumed older content.`;
  } catch {
    return null;
  }
}
