/**
 * What the Botflow iOS app is told about agents while it is not running:
 *
 *   - an alert when a turn finishes, fails, or the agent asks a question;
 *   - Live Activity updates with the agent's current step, so the Dynamic
 *     Island and Lock Screen keep moving after iOS suspends the app.
 *
 * Everything here is best-effort and never throws: a push that fails must not
 * affect the turn. With no APNs key configured, or no registered device, each
 * function returns without doing anything.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatSessions, projects } from "@/db/schema";
import { redis } from "@/lib/redis";
import { threadViewers } from "@/lib/agent/thread-presence";
import { DEFAULT_BUNDLE_ID, isApnsConfigured, isDeadToken, sendApns } from "./apns";
import { clearLiveActivity, getLiveActivity, hasDevices, listDevices, removeDevice } from "./devices";

export type TurnOutcome = "done" | "failed" | "stopped";

/** Seconds between 1970 and 2001: Swift's `Date` encodes relative to 2001. */
const APPLE_EPOCH_OFFSET = 978_307_200;
const appleDate = (ms: number) => ms / 1000 - APPLE_EPOCH_OFFSET;

/** Mirrors `ToolPresentation` in the iOS app (ios/Shared/AgentActivityAttributes.swift). */
export function describeTool(name: string): { verb: string; symbol: string } {
  const key = (name.split("__").pop() ?? name).toLowerCase();
  switch (key) {
    case "read": case "readfile": case "read_file": return { verb: "Reading", symbol: "doc.text" };
    case "write": case "writefile": case "write_file": return { verb: "Writing", symbol: "square.and.pencil" };
    case "edit": case "multiedit": case "applydiff": case "apply_patch": case "patch": return { verb: "Editing", symbol: "pencil.line" };
    case "bash": case "shell": case "bashoutput": case "exec": return { verb: "Running", symbol: "terminal" };
    case "grep": case "search": case "glob": case "list": case "ls": return { verb: "Searching", symbol: "magnifyingglass" };
    case "task": return { verb: "Delegating", symbol: "person.2" };
    case "webfetch": case "websearch": return { verb: "Browsing", symbol: "globe" };
    case "todowrite": case "todoread": return { verb: "Planning", symbol: "checklist" };
    case "ask_question": case "askuserquestion": return { verb: "Asking you", symbol: "questionmark.bubble" };
    case "startsimulator": case "getsimulatorstatus": case "stopsimulator": return { verb: "Building for iPhone", symbol: "iphone" };
    case "startdevserver": case "refreshpreview": case "getdevserverlog": return { verb: "Starting the preview", symbol: "play.rectangle" };
    case "getbrowserlog": return { verb: "Checking the preview", symbol: "ladybug" };
    case "convexdeploy": return { verb: "Deploying the backend", symbol: "cylinder.split.1x2" };
    default: return { verb: "Working", symbol: "wrench.and.screwdriver" };
  }
}

/**
 * Should a turn started by this person send step heartbeats? Yes when they use
 * the iOS app: the heartbeat feeds its Agents tab (below) and, with an APNs
 * key, its Live Activity. Never throws.
 */
export async function wantsProgressBeacon(userId: string): Promise<boolean> {
  return hasDevices(userId).catch(() => false);
}

export interface TurnProgress {
  tool: string;
  detail: string;
  steps: number;
  at: number;
}

const progressKey = (threadId: string) => `agent:progress:${threadId}`;
const PROGRESS_TTL_SECONDS = 15 * 60;

/** The step a running agent is on, kept briefly for the app's Agents tab. */
export async function recordTurnProgress(threadId: string, progress: Omit<TurnProgress, "at">): Promise<void> {
  await redis.setex(progressKey(threadId), PROGRESS_TTL_SECONDS, JSON.stringify({ ...progress, at: Date.now() })).catch(() => {});
}

export async function getTurnProgress(threadIds: string[]): Promise<Map<string, TurnProgress>> {
  const out = new Map<string, TurnProgress>();
  await Promise.all(
    threadIds.map(async (id) => {
      try {
        const raw = await redis.get<TurnProgress | string>(progressKey(id));
        const parsed = typeof raw === "string" ? (JSON.parse(raw) as TurnProgress) : raw;
        if (parsed && typeof parsed.tool === "string") out.set(id, parsed);
      } catch {
        /* no progress to show */
      }
    }),
  );
  return out;
}

export async function clearTurnProgress(threadId: string): Promise<void> {
  await redis.del(progressKey(threadId)).catch(() => {});
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Plain text from Markdown, for a notification body. */
export function plainSummary(markdown: string, max = 170): string {
  return clip(markdown.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]/g, ""), max);
}

async function threadContext(projectId: string, threadId: string) {
  const db = getDb();
  const [[project], [thread]] = await Promise.all([
    db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1),
    db.select({ title: chatSessions.title }).from(chatSessions).where(eq(chatSessions.id, threadId)).limit(1),
  ]);
  return { projectName: project?.name ?? "Botflow", threadTitle: thread?.title ?? "New chat" };
}

/** Is this person looking at the thread right now (in the app or on the web)? */
async function isWatching(projectId: string, threadId: string, userId: string): Promise<boolean> {
  const viewers = await threadViewers(projectId);
  return (viewers[threadId] ?? []).includes(userId);
}

async function sendAlert(input: {
  userId: string;
  projectId: string;
  threadId: string;
  title: string;
  subtitle: string;
  body: string;
  category: "AGENT_FINISHED" | "AGENT_NEEDS_INPUT" | "AGENT_FAILED";
  timeSensitive?: boolean;
}): Promise<number> {
  const devices = await listDevices(input.userId);
  let delivered = 0;
  await Promise.all(
    devices.map(async (device) => {
      const result = await sendApns({
        deviceToken: device.token,
        environment: device.environment,
        topic: device.bundleId || DEFAULT_BUNDLE_ID,
        pushType: "alert",
        priority: 10,
        // One notification per thread: a newer one replaces the older.
        collapseId: `turn-${input.threadId}`,
        expiresAt: Date.now() + 6 * 60 * 60 * 1000,
        payload: {
          aps: {
            alert: { title: input.title, subtitle: input.subtitle, body: input.body },
            sound: "default",
            category: input.category,
            "thread-id": input.projectId,
            ...(input.timeSensitive ? { "interruption-level": "time-sensitive" } : {}),
          },
          projectId: input.projectId,
          threadId: input.threadId,
        },
      });
      if (result.ok) delivered += 1;
      else if (isDeadToken(result)) await removeDevice(input.userId, device.token).catch(() => {});
    }),
  );
  return delivered;
}

interface ActivityState {
  startedAt: number;
  steps: number;
  recent: string[];
}

const activityStateKey = (threadId: string, userId: string) => `native:activity-state:${threadId}:${userId}`;

async function readActivityState(threadId: string, userId: string): Promise<ActivityState> {
  try {
    const raw = await redis.get<ActivityState | string>(activityStateKey(threadId, userId));
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as ActivityState) : raw;
    if (parsed && typeof parsed.startedAt === "number") return parsed;
  } catch {
    /* fall through to a fresh state */
  }
  return { startedAt: Date.now(), steps: 0, recent: [] };
}

/** The app started an activity: remember when, so pushed states keep its clock. */
export async function seedActivityState(userId: string, threadId: string, startedAt: number): Promise<void> {
  const state: ActivityState = { startedAt, steps: 0, recent: [] };
  await redis.setex(activityStateKey(threadId, userId), 8 * 60 * 60, JSON.stringify(state));
}

async function pushActivity(input: {
  userId: string;
  threadId: string;
  event: "update" | "end";
  contentState: Record<string, unknown>;
  dismissAt?: number;
}): Promise<boolean> {
  const target = await getLiveActivity(input.userId, input.threadId);
  if (!target) return false;
  const result = await sendApns({
    deviceToken: target.token,
    environment: target.environment,
    topic: `${DEFAULT_BUNDLE_ID}.push-type.liveactivity`,
    pushType: "liveactivity",
    priority: input.event === "end" ? 10 : 5,
    payload: {
      aps: {
        timestamp: Math.floor(Date.now() / 1000),
        event: input.event,
        "content-state": input.contentState,
        ...(input.dismissAt ? { "dismissal-date": Math.floor(input.dismissAt / 1000) } : {}),
      },
    },
  });
  if (isDeadToken(result)) await clearLiveActivity(input.userId, input.threadId).catch(() => {});
  return result.ok;
}

/** The agent started a step. Called (throttled) by the in-sandbox bridge. */
export async function pushTurnProgress(input: {
  userId: string;
  threadId: string;
  tool: string;
  detail: string;
  steps: number;
}): Promise<boolean> {
  try {
    await recordTurnProgress(input.threadId, { tool: input.tool, detail: clip(input.detail, 80), steps: input.steps });
    if (!isApnsConfigured()) return false;
    if (!(await getLiveActivity(input.userId, input.threadId))) return false;
    const { verb, symbol } = describeTool(input.tool);
    const detail = clip(input.detail, 60);
    const state = await readActivityState(input.threadId, input.userId);
    const line = detail ? `${verb} ${detail}` : verb;
    const recent = state.recent[state.recent.length - 1] === line ? state.recent : [...state.recent, line].slice(-3);
    const next: ActivityState = { startedAt: state.startedAt, steps: Math.max(state.steps, input.steps), recent };
    await redis.setex(activityStateKey(input.threadId, input.userId), 8 * 60 * 60, JSON.stringify(next));
    const asking = input.tool.toLowerCase().includes("ask");
    return await pushActivity({
      userId: input.userId,
      threadId: input.threadId,
      event: "update",
      contentState: {
        phase: asking ? "needsInput" : "working",
        action: verb,
        detail,
        symbol,
        steps: next.steps,
        recent,
        startedAt: appleDate(next.startedAt),
      },
    });
  } catch (err) {
    console.error("[native-push] progress failed:", err);
    return false;
  }
}

/** A turn ended: close the Live Activity and, unless the person is watching, alert them. */
export async function notifyTurnEnded(input: {
  userId: string;
  projectId: string;
  threadId: string;
  outcome: TurnOutcome;
  summary: string;
}): Promise<void> {
  try {
    await clearTurnProgress(input.threadId);
    if (!isApnsConfigured()) return;
    const state = await readActivityState(input.threadId, input.userId);
    const failed = input.outcome === "failed";
    const summary = plainSummary(input.summary) || (failed ? "Open Botflow to see what went wrong." : "Open Botflow to see what changed.");
    await pushActivity({
      userId: input.userId,
      threadId: input.threadId,
      event: "end",
      dismissAt: Date.now() + (failed ? 10 : 2) * 60 * 1000,
      contentState: {
        phase: failed ? "failed" : "done",
        action: failed ? "Stopped" : "Finished",
        detail: input.outcome === "stopped" ? "" : summary,
        symbol: failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill",
        steps: state.steps,
        recent: state.recent,
        startedAt: appleDate(state.startedAt),
        endedAt: appleDate(Date.now()),
      },
    });
    await Promise.all([
      clearLiveActivity(input.userId, input.threadId).catch(() => {}),
      redis.del(activityStateKey(input.threadId, input.userId)).catch(() => {}),
    ]);

    // A stop is something the person just did; nothing to tell them.
    if (input.outcome === "stopped") return;
    if (await isWatching(input.projectId, input.threadId, input.userId)) return;
    const { projectName, threadTitle } = await threadContext(input.projectId, input.threadId);
    await sendAlert({
      userId: input.userId,
      projectId: input.projectId,
      threadId: input.threadId,
      title: failed ? `${projectName}: the agent stopped` : `${projectName}: the agent finished`,
      subtitle: clip(threadTitle, 80),
      body: summary,
      category: failed ? "AGENT_FAILED" : "AGENT_FINISHED",
    });
  } catch (err) {
    console.error("[native-push] turn-ended failed:", err);
  }
}

/** The agent asked a question and is blocked until it is answered. */
export async function notifyNeedsInput(input: {
  userId: string;
  projectId: string;
  threadId: string;
  question: string;
}): Promise<void> {
  try {
    if (!isApnsConfigured()) return;
    const state = await readActivityState(input.threadId, input.userId);
    await pushActivity({
      userId: input.userId,
      threadId: input.threadId,
      event: "update",
      contentState: {
        phase: "needsInput",
        action: "Asking you",
        detail: clip(input.question, 60),
        symbol: "questionmark.bubble",
        steps: state.steps,
        recent: state.recent,
        startedAt: appleDate(state.startedAt),
      },
    });
    if (await isWatching(input.projectId, input.threadId, input.userId)) return;
    const { projectName, threadTitle } = await threadContext(input.projectId, input.threadId);
    await sendAlert({
      userId: input.userId,
      projectId: input.projectId,
      threadId: input.threadId,
      title: `${projectName} needs your input`,
      subtitle: clip(threadTitle, 80),
      body: clip(input.question, 170) || "The agent has a question for you.",
      category: "AGENT_NEEDS_INPUT",
      timeSensitive: true,
    });
  } catch (err) {
    console.error("[native-push] needs-input failed:", err);
  }
}
