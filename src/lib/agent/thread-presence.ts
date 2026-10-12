/**
 * Who's in a project's threads: member identities (for author labels and
 * viewer avatars) and live presence (which thread each member is viewing).
 *
 * Both ride the threads status poll, so they must stay cheap: identities are
 * cached in Redis, presence is one Redis hash per project. Neither ever
 * touches the sandbox or counts as sandbox activity (no keepalive).
 */
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { projectMembers, type Project } from "@/db/schema";
import { redis } from "@/lib/redis";
import { identityClient } from "@/lib/auth/server";

export interface ThreadPerson {
  name: string;
  /** One or two letters for the avatar chip. */
  initials: string;
  imageUrl?: string;
}

const PEOPLE_TTL_SECONDS = 5 * 60;
/** A viewer counts as present for this long after their last poll. */
const PRESENCE_WINDOW_MS = 15_000;

export function initialsFor(name: string): string {
  const words = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Owner + active members → display identity. Cached; never throws. */
export async function getProjectPeople(project: Pick<Project, "id" | "userId">): Promise<Record<string, ThreadPerson>> {
  const cacheKey = `thread-people:${project.id}`;
  try {
    const cached = await redis.get<Record<string, ThreadPerson> | string>(cacheKey);
    if (cached) return typeof cached === "string" ? JSON.parse(cached) : cached;
  } catch {
    /* cache miss path below */
  }

  const people: Record<string, ThreadPerson> = {};
  try {
    const members = await getDb()
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.status, "active")));
    const ids = [project.userId, ...members.map((m) => m.userId).filter((v): v is string => Boolean(v))];
    const client = await identityClient();
    const { data } = await client.users.getUserList({ userId: [...new Set(ids)], limit: 100 });
    for (const u of data) {
      const name = u.fullName ?? u.primaryEmailAddress?.emailAddress ?? "Member";
      people[u.id] = { name, initials: initialsFor(name), ...(u.imageUrl ? { imageUrl: u.imageUrl } : {}) };
    }
    await redis.setex(cacheKey, PEOPLE_TTL_SECONDS, JSON.stringify(people)).catch(() => {});
  } catch (err) {
    console.error("[thread-presence] could not load project people:", err);
  }
  return people;
}

const presenceKey = (projectId: string) => `thread-presence:${projectId}`;

/** Record that `userId` is looking at `threadId` (or at no thread). */
export async function notePresence(projectId: string, userId: string, threadId: string | null): Promise<void> {
  try {
    await redis.hset(presenceKey(projectId), { [userId]: JSON.stringify({ threadId, at: Date.now() }) });
    await redis.expire(presenceKey(projectId), 60);
  } catch {
    /* presence is best-effort */
  }
}

/** threadId → user ids currently viewing it (fresh entries only). */
export async function threadViewers(projectId: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  try {
    const raw = await redis.hgetall<Record<string, string | { threadId: string | null; at: number }>>(presenceKey(projectId));
    const cutoff = Date.now() - PRESENCE_WINDOW_MS;
    for (const [userId, value] of Object.entries(raw ?? {})) {
      const entry = typeof value === "string" ? (JSON.parse(value) as { threadId: string | null; at: number }) : value;
      if (!entry?.threadId || entry.at < cutoff) continue;
      (out[entry.threadId] ??= []).push(userId);
    }
  } catch {
    /* presence is best-effort */
  }
  return out;
}
