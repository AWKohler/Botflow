/**
 * Per-thread message queue (docs/features/multi-agent-threads.md, Phase 2).
 *
 * Any project member can send to any thread. When the thread's agent is busy
 * the message waits here — every viewer sees it — and the server starts it,
 * as its author, when the running turn ends. Draining is idempotent and safe
 * to trigger from several places (turn end, enqueue, a client backstop):
 * rows are claimed with a compare-and-set, and the starter's in-sandbox busy
 * check is the final word — a "busy" refusal just releases the claim.
 */
import type { UIMessage } from "ai";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages, chatThreadQueue, type ChatThreadQueueItem } from "@/db/schema";
import { requireProjectAccess } from "@/lib/project-access";
import { normalizeProjectPlatform } from "@/lib/project-platform";
import { getUserCredentials } from "@/lib/user-credentials";
import { getUserTier } from "@/lib/tier";
import { USE_TOGETHER_KIMI } from "@/lib/feature-flags";
import { credFlagsFromUserCredentials } from "./backend-resolution";
import { deriveAgentBackend } from "./derive-backend";
import { getTurnRecord, isTurnLive } from "./claude-code/turn-registry";
import { ensureThreadSegment, getThread, threadModel } from "./threads";
import { startClaudeCodeTurn } from "./turn-start/claude-code";
import { startOpenCodeTurn } from "./turn-start/opencode";

/** What viewers see for each waiting message. */
export interface QueueItemSummary {
  id: string;
  userId: string;
  /** First text part, for the queue strip. */
  text: string;
  hasImages: boolean;
  status: "queued" | "claimed" | "failed";
  error: string | null;
  createdAt: string;
}

/** A claim older than this belongs to a drain that died mid-start. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

function messageText(message: unknown): { text: string; hasImages: boolean } {
  const parts = (message as { parts?: Array<{ type?: string; text?: string }> })?.parts ?? [];
  const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ").trim();
  const hasImages = parts.some((p) => p.type === "file");
  return { text, hasImages };
}

export async function enqueueMessage(input: {
  projectId: string;
  threadId: string;
  userId: string;
  message: UIMessage;
}): Promise<ChatThreadQueueItem> {
  const [row] = await getDb()
    .insert(chatThreadQueue)
    .values({
      projectId: input.projectId,
      threadId: input.threadId,
      userId: input.userId,
      message: { id: input.message.id, role: "user", parts: input.message.parts },
    })
    .returning();
  return row;
}

/** Waiting (and failed, until removed) messages, oldest first. */
export async function listQueue(threadId: string): Promise<QueueItemSummary[]> {
  const rows = await getDb()
    .select()
    .from(chatThreadQueue)
    .where(
      and(
        eq(chatThreadQueue.threadId, threadId),
        inArray(chatThreadQueue.status, ["queued", "claimed", "failed"]),
      ),
    )
    .orderBy(asc(chatThreadQueue.createdAt))
    .limit(50);
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    ...messageText(r.message),
    status: r.status as QueueItemSummary["status"],
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Remove a waiting or failed message. Any member may (threads are shared). */
export async function cancelQueued(threadId: string, queueId: string): Promise<boolean> {
  const rows = await getDb()
    .update(chatThreadQueue)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(chatThreadQueue.id, queueId),
        eq(chatThreadQueue.threadId, threadId),
        inArray(chatThreadQueue.status, ["queued", "failed"]),
      ),
    )
    .returning({ id: chatThreadQueue.id });
  return rows.length > 0;
}

/** Remove every waiting message in the thread (Stop clears the queue). */
export async function cancelAllQueued(threadId: string): Promise<number> {
  const rows = await getDb()
    .update(chatThreadQueue)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(chatThreadQueue.threadId, threadId), inArray(chatThreadQueue.status, ["queued", "failed"])))
    .returning({ id: chatThreadQueue.id });
  return rows.length;
}

/** Atomically claim the oldest queued message (compare-and-set on status). */
async function claimNext(threadId: string): Promise<ChatThreadQueueItem | null> {
  const db = getDb();
  // Recover claims abandoned by a drain that died mid-start.
  await db
    .update(chatThreadQueue)
    .set({ status: "queued", updatedAt: new Date() })
    .where(
      and(
        eq(chatThreadQueue.threadId, threadId),
        eq(chatThreadQueue.status, "claimed"),
        lt(chatThreadQueue.updatedAt, new Date(Date.now() - STALE_CLAIM_MS)),
      ),
    );
  const [row] = await db
    .update(chatThreadQueue)
    .set({ status: "claimed", updatedAt: new Date() })
    .where(
      and(
        eq(
          chatThreadQueue.id,
          sql`(select ${chatThreadQueue.id} from ${chatThreadQueue}
               where ${chatThreadQueue.threadId} = ${threadId} and ${chatThreadQueue.status} = 'queued'
               order by ${chatThreadQueue.createdAt} limit 1)`,
        ),
        eq(chatThreadQueue.status, "queued"),
      ),
    )
    .returning();
  return row ?? null;
}

async function settle(id: string, patch: Partial<typeof chatThreadQueue.$inferInsert>): Promise<void> {
  await getDb()
    .update(chatThreadQueue)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(chatThreadQueue.id, id));
}

/** The thread's current-segment conversation as UIMessages (for the preamble). */
export async function loadThreadConversation(threadId: string, segmentId: string): Promise<UIMessage[]> {
  const rows = await getDb()
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.sessionId, threadId), eq(chatMessages.segmentId, segmentId)))
    .orderBy(desc(chatMessages.createdAt))
    .limit(200);
  return rows.reverse().map((r) => {
    const content = r.content as { parts?: UIMessage["parts"] } | null;
    return {
      id: r.messageId,
      role: r.role as UIMessage["role"],
      parts: Array.isArray(content?.parts) ? content.parts : [],
    };
  });
}

async function readRefusal(response: Response): Promise<{ reason: string | null; error: string }> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; reason?: string; message?: string };
  return {
    reason: body.reason ?? null,
    error: body.error ?? body.message ?? `Could not start (HTTP ${response.status})`,
  };
}

export type DrainOutcome =
  | { started: true; turnId: string; queueId: string }
  | { started: false; why: "empty" | "busy" | "failed" | "no_thread" };

/**
 * Start the thread's oldest queued message if its agent is idle. Safe to call
 * any time; at most one turn per thread ever runs (sandbox busy check).
 */
export async function drainThreadQueue(input: {
  projectId: string;
  threadId: string;
  origin: string;
}): Promise<DrainOutcome> {
  const { projectId, threadId, origin } = input;

  // Cheap early-out while a turn is plainly live (the sandbox check below is
  // authoritative; this just avoids claiming rows for nothing).
  const record = await getTurnRecord(projectId, threadId).catch(() => null);
  if (isTurnLive(record) && Date.now() - (record?.startedAt ?? 0) < 15 * 60 * 1000) {
    return { started: false, why: "busy" };
  }

  const item = await claimNext(threadId);
  if (!item) return { started: false, why: "empty" };

  const thread = await getThread(projectId, threadId);
  if (!thread) {
    await settle(item.id, { status: "failed", error: "This chat no longer exists." });
    return { started: false, why: "no_thread" };
  }
  // The author must still be on the project — the turn runs (and bills) as them.
  const access = await requireProjectAccess(projectId, item.userId);
  if (!access) {
    await settle(item.id, { status: "failed", error: "The person who queued this no longer has access to the project." });
    return { started: false, why: "failed" };
  }
  const project = access.project;

  const segmentId = await ensureThreadSegment(thread);
  const queued = item.message as UIMessage;
  const history = (await loadThreadConversation(threadId, segmentId)).filter((m) => m.id !== queued.id);
  const messages: UIMessage[] = [...history, queued];

  const platform = normalizeProjectPlatform(project.platform);
  const creds = await getUserCredentials(item.userId);
  const tier = await getUserTier(item.userId);
  const derived = deriveAgentBackend({
    model: threadModel(thread, project),
    platform,
    creds: credFlagsFromUserCredentials(creds),
    tier,
    useTogetherKimi: USE_TOGETHER_KIMI,
  });
  const start = derived.backend === "claude-code" ? startClaudeCodeTurn : startOpenCodeTurn;

  let result;
  try {
    result = await start({ userId: item.userId, projectId, platform, messages, project, thread, origin });
  } catch (err) {
    console.error("[thread-queue] start threw:", err);
    await settle(item.id, { status: "queued" });
    return { started: false, why: "failed" };
  }

  if (result.ok) {
    await settle(item.id, { status: "sent", turnId: result.turnId, error: null });
    return { started: true, turnId: result.turnId, queueId: item.id };
  }
  const refusal = await readRefusal(result.response);
  if (refusal.reason === "thread_busy" || refusal.reason === "capacity") {
    // Transient: put it back; the next turn end (or the client backstop) retries.
    await settle(item.id, { status: "queued" });
    return { started: false, why: "busy" };
  }
  await settle(item.id, { status: "failed", error: refusal.error.slice(0, 500) });
  return { started: false, why: "failed" };
}
