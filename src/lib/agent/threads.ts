/**
 * Agent threads — server helpers (docs/features/multi-agent-threads.md).
 *
 * A thread is one conversation with its own agent process in the project's
 * shared sandbox. Rows live in `chat_sessions` (historical name). Every helper
 * here takes the projectId alongside the threadId and filters on BOTH, so a
 * thread id from one project can never address another project's thread.
 */
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import {
  chatQuestions,
  chatSessions,
  chatThreadQueue,
  chatThreadViews,
  envVarRequests,
  oauthProviderRequests,
  stripeConnectRequests,
  type ChatSession,
  type Project,
} from "@/db/schema";
import { resolveModelId, type ModelId } from "./models";
import { getTurnRecords, isTurnLive } from "./claude-code/turn-registry";

export type Thread = ChatSession;

/** What the sidebar shows next to each thread. */
export type ThreadStatus = "running" | "needs_input" | "error" | "idle";

export interface ThreadSummary {
  id: string;
  title: string | null;
  model: ModelId;
  status: ThreadStatus;
  /** Finished a turn since this user last looked at the thread. */
  unread: boolean;
  createdBy: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastTurnEndedAt: string | null;
  /** The live turn, so viewers who didn't start it can follow it. */
  liveTurnId: string | null;
  /** Messages waiting for this thread's agent. */
  queued: number;
}

const TITLE_MAX = 80;

/** Title from a user prompt: first line-ish, whitespace collapsed, capped. */
export function deriveThreadTitle(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || clean.startsWith("[system-note]")) return null;
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean;
}

/** The model a thread runs: its own, else the project's legacy default. */
export function threadModel(thread: Pick<Thread, "model">, project: Pick<Project, "model">): ModelId {
  return resolveModelId(thread.model ?? project.model);
}

export async function getThread(projectId: string, threadId: string): Promise<Thread | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, threadId), eq(chatSessions.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

export async function createThread(
  project: Pick<Project, "id" | "model">,
  userId: string,
  model?: ModelId | null,
): Promise<Thread> {
  const db = getDb();
  const [row] = await db
    .insert(chatSessions)
    .values({
      projectId: project.id,
      createdBy: userId,
      model: model ?? resolveModelId(project.model),
      currentSegmentId: randomUUID(),
    })
    .returning();
  return row;
}

/**
 * The thread a request addresses. With an explicit id it must belong to the
 * project (null otherwise). Without one (older clients, the landing-page
 * first prompt) it's the most recently updated open thread, created on demand.
 */
export async function resolveThread(
  project: Pick<Project, "id" | "model">,
  userId: string,
  threadId: string | null | undefined,
): Promise<Thread | null> {
  if (threadId) return getThread(project.id, threadId);
  const db = getDb();
  const [latest] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.projectId, project.id), isNull(chatSessions.archivedAt)))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(1);
  return latest ?? createThread(project, userId);
}

/** The thread's active segment, minting one for any legacy row without. */
export async function ensureThreadSegment(thread: Thread): Promise<string> {
  if (thread.currentSegmentId) return thread.currentSegmentId;
  const segmentId = randomUUID();
  await getDb()
    .update(chatSessions)
    .set({ currentSegmentId: segmentId })
    .where(eq(chatSessions.id, thread.id));
  return segmentId;
}

/** Name the thread after its first real prompt (no-op once titled). */
export async function setTitleIfEmpty(thread: Thread, promptText: string): Promise<void> {
  if (thread.title) return;
  const title = deriveThreadTitle(promptText);
  if (!title) return;
  await getDb()
    .update(chatSessions)
    .set({ title })
    .where(and(eq(chatSessions.id, thread.id), isNull(chatSessions.title)));
}

export async function noteTurnStarted(threadId: string): Promise<void> {
  const now = new Date();
  await getDb()
    .update(chatSessions)
    .set({ lastTurnStartedAt: now, lastTurnError: null, updatedAt: now })
    .where(eq(chatSessions.id, threadId));
}

export async function noteTurnEnded(threadId: string, error?: string | null): Promise<void> {
  const now = new Date();
  await getDb()
    .update(chatSessions)
    .set({ lastTurnEndedAt: now, lastTurnError: error ?? null, updatedAt: now })
    .where(eq(chatSessions.id, threadId));
}

export async function markThreadViewed(threadId: string, userId: string): Promise<void> {
  const now = new Date();
  await getDb()
    .insert(chatThreadViews)
    .values({ threadId, userId, lastViewedAt: now })
    .onConflictDoUpdate({
      target: [chatThreadViews.threadId, chatThreadViews.userId],
      set: { lastViewedAt: now },
    });
}

/** Threads that have an open question or human-in-the-loop request. */
async function threadsNeedingInput(projectId: string, threadIds: string[]): Promise<Set<string>> {
  if (threadIds.length === 0) return new Set();
  const db = getDb();
  const [questions, oauth, envVars, stripe] = await Promise.all([
    db
      .select({ threadId: chatQuestions.threadId })
      .from(chatQuestions)
      .where(and(eq(chatQuestions.projectId, projectId), eq(chatQuestions.status, "pending"), inArray(chatQuestions.threadId, threadIds))),
    db
      .select({ threadId: oauthProviderRequests.threadId })
      .from(oauthProviderRequests)
      .where(and(eq(oauthProviderRequests.projectId, projectId), eq(oauthProviderRequests.status, "pending"), inArray(oauthProviderRequests.threadId, threadIds))),
    db
      .select({ threadId: envVarRequests.threadId })
      .from(envVarRequests)
      .where(and(eq(envVarRequests.projectId, projectId), eq(envVarRequests.status, "pending"), inArray(envVarRequests.threadId, threadIds))),
    db
      .select({ threadId: stripeConnectRequests.threadId })
      .from(stripeConnectRequests)
      .where(and(eq(stripeConnectRequests.projectId, projectId), eq(stripeConnectRequests.status, "pending"), inArray(stripeConnectRequests.threadId, threadIds))),
  ]);
  const out = new Set<string>();
  for (const r of [...questions, ...oauth, ...envVars, ...stripe]) if (r.threadId) out.add(r.threadId);
  return out;
}

/** Pure status rule, separated for tests. Needs-input wins over running: an
 *  agent blocked on the user is the thing to surface. */
export function computeThreadStatus(input: {
  live: boolean;
  needsInput: boolean;
  lastTurnError: string | null;
}): ThreadStatus {
  if (input.needsInput) return "needs_input";
  if (input.live) return "running";
  if (input.lastTurnError) return "error";
  return "idle";
}

const MAX_LISTED_THREADS = 100;

/** Every thread of the project with live status, newest activity first. */
export async function listThreadSummaries(
  project: Pick<Project, "id" | "model">,
  userId: string,
): Promise<ThreadSummary[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.projectId, project.id))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(MAX_LISTED_THREADS);
  const ids = rows.map((r) => r.id);
  const openIds = rows.filter((r) => !r.archivedAt).map((r) => r.id);

  const [records, needsInput, views, queueCounts] = await Promise.all([
    getTurnRecords(project.id, openIds),
    threadsNeedingInput(project.id, openIds),
    ids.length
      ? db
          .select()
          .from(chatThreadViews)
          .where(and(eq(chatThreadViews.userId, userId), inArray(chatThreadViews.threadId, ids)))
      : Promise.resolve([]),
    openIds.length
      ? db
          .select({ threadId: chatThreadQueue.threadId, n: count() })
          .from(chatThreadQueue)
          .where(and(inArray(chatThreadQueue.threadId, openIds), inArray(chatThreadQueue.status, ["queued", "claimed"])))
          .groupBy(chatThreadQueue.threadId)
      : Promise.resolve([]),
  ]);
  const queued = new Map(queueCounts.map((q) => [q.threadId, Number(q.n)]));
  const viewedAt = new Map(views.map((v) => [v.threadId, v.lastViewedAt.getTime()]));

  return rows.map((r) => {
    const record = records.get(r.id);
    const live = isTurnLive(record);
    const ended = r.lastTurnEndedAt?.getTime() ?? 0;
    return {
      id: r.id,
      title: r.title,
      model: threadModel(r, project),
      status: computeThreadStatus({ live, needsInput: needsInput.has(r.id), lastTurnError: r.lastTurnError }),
      unread: !live && ended > 0 && ended > (viewedAt.get(r.id) ?? 0),
      createdBy: r.createdBy,
      archived: Boolean(r.archivedAt),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      lastTurnEndedAt: r.lastTurnEndedAt?.toISOString() ?? null,
      liveTurnId: live && record ? record.turnId : null,
      queued: queued.get(r.id) ?? 0,
    };
  });
}

/** Titles of OTHER threads with a live agent — feeds the cross-agent
 *  awareness note appended to a new turn's system prompt. */
export async function otherRunningThreadTitles(projectId: string, threadId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ id: chatSessions.id, title: chatSessions.title })
    .from(chatSessions)
    .where(and(eq(chatSessions.projectId, projectId), isNull(chatSessions.archivedAt)))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(MAX_LISTED_THREADS);
  const others = rows.filter((r) => r.id !== threadId);
  const records = await getTurnRecords(projectId, others.map((r) => r.id));
  return others.filter((r) => isTurnLive(records.get(r.id))).map((r) => r.title ?? "Untitled thread");
}

/** System-prompt note telling an agent it shares the sandbox with others. */
export function awarenessNote(otherTitles: string[]): string | null {
  if (otherTitles.length === 0) return null;
  const list = otherTitles.map((t) => `- ${t}`).join("\n");
  return [
    "Other agents are working in this same project right now, in separate threads:",
    list,
    "They share this filesystem and dev server with you. Re-read any file right before you edit it, keep your changes focused on your own task, and avoid unrelated refactors, dependency upgrades, or restarting the dev server unless your task needs it.",
  ].join("\n");
}
