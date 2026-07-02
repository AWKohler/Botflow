/**
 * Swift simulator control plane — Redis-backed desired/actual state.
 *
 * The simulator session is OWNED BY THE BROWSER (it provisions via
 * /swift-preview/start and holds the WebSocket stream), so agent tools can't
 * start it directly. Instead they publish a short-lived "desired" action that
 * the open workspace polls and honors; the workspace publishes the stream's
 * "actual" state back so getSimulatorStatus reflects reality.
 *
 * TTL on the desired key is deliberately short: a start request only affects a
 * workspace that's open right now. Re-opening a project later must never
 * replay a stale request — the simulator never auto-starts on open.
 *
 * Mirrors the dev-server state pattern in workspace-control.ts.
 */
import { getRedis } from "@/lib/redis";

const DESIRED_TTL_SECONDS = 5 * 60;
const ACTUAL_TTL_SECONDS = 2 * 60;
// Build results live longer than actual-state: the agent may come back and
// read the last build outcome (via getSimulatorStatus) well after the build.
const BUILD_TTL_SECONDS = 15 * 60;

function desiredKey(projectId: string): string {
  return `swift-sim:desired:${projectId}`;
}

function actualKey(projectId: string): string {
  return `swift-sim:actual:${projectId}`;
}

function buildKey(projectId: string): string {
  return `swift-sim:build:${projectId}`;
}

export type SimDesiredAction = "start" | "stop";

export interface SimDesiredState {
  action: SimDesiredAction;
  requestedAt: number;
}

export type SimActualStatus =
  | "stopped"
  | "starting"
  | "building"
  | "installing"
  | "live"
  | "failed";

export interface SimActualState {
  state: SimActualStatus;
  deviceModel: string | null;
  updatedAt: number;
}

export async function requestSimulatorAction(
  projectId: string,
  action: SimDesiredAction,
): Promise<SimDesiredState> {
  const state: SimDesiredState = { action, requestedAt: Date.now() };
  const redis = getRedis();
  await redis.setex(desiredKey(projectId), DESIRED_TTL_SECONDS, JSON.stringify(state));
  return state;
}

export async function getSimulatorDesired(
  projectId: string,
): Promise<SimDesiredState | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get<string>(desiredKey(projectId));
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SimDesiredState;
  } catch {
    return null;
  }
}

/** The workspace consumed (or chose to drop) the pending desired action. */
export async function clearSimulatorDesired(projectId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(desiredKey(projectId));
  } catch {
    // Non-fatal — the key expires on its own.
  }
}

/** Published by the browser whenever the stream's state changes. */
export async function publishSimulatorActual(
  projectId: string,
  state: Omit<SimActualState, "updatedAt">,
): Promise<void> {
  try {
    const redis = getRedis();
    await redis.setex(
      actualKey(projectId),
      ACTUAL_TTL_SECONDS,
      JSON.stringify({ ...state, updatedAt: Date.now() } satisfies SimActualState),
    );
  } catch {
    // Non-fatal — status just reads stale/absent.
  }
}

export async function getSimulatorActual(
  projectId: string,
): Promise<SimActualState | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get<string>(actualKey(projectId));
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SimActualState;
  } catch {
    return null;
  }
}

/* ───────────────────────────── build results ─────────────────────────────
 * The workspace publishes each xcodebuild attempt's outcome (started →
 * succeeded/failed, plus structured diagnostics) so the agent's
 * startSimulator tool can BLOCK until the build finishes and hand the
 * errors/warnings back to the model — mirroring how convex_deploy waits for
 * the deploy worker. Diagnostics arrive already sanitized by the sim host
 * (project-relative paths, no host UUIDs/usernames).
 */

/** Mirrors the workspace's SimBuildDiagnostic minus `snippet` (kept small —
 *  the model gets file:line + message, which is what it acts on). */
export interface SimBuildDiagnosticSummary {
  severity: "error" | "warning";
  file: string | null;
  line: number | null;
  column: number | null;
  message: string;
}

export interface SimBuildResult {
  /** Workspace-generated id for one build attempt — lets a waiter tell a new
   *  build apart from a stale terminal publish that lands after its request. */
  buildId: string;
  state: "started" | "succeeded" | "failed";
  diagnostics: SimBuildDiagnosticSummary[];
  /** True once the authoritative xcresult-extracted diagnostics replaced the
   *  live regex-parsed ones. */
  finalized: boolean;
  exitCode?: number | null;
  message?: string | null;
  /** Server-stamped when the publish was received (comparable with
   *  SimDesiredState.requestedAt — both come from our server clock). */
  publishedAt: number;
}

// Caps applied at publish time so a pathological build can't blow up the
// Redis value or the model's context.
const MAX_BUILD_DIAGNOSTICS = 80;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 600;

export function sanitizeBuildDiagnostics(
  diags: unknown,
): SimBuildDiagnosticSummary[] {
  if (!Array.isArray(diags)) return [];
  const out: SimBuildDiagnosticSummary[] = [];
  for (const d of diags) {
    if (!d || typeof d !== "object") continue;
    const dd = d as Record<string, unknown>;
    if (dd.severity !== "error" && dd.severity !== "warning") continue;
    if (typeof dd.message !== "string" || !dd.message) continue;
    out.push({
      severity: dd.severity,
      file: typeof dd.file === "string" ? dd.file : null,
      line: typeof dd.line === "number" ? dd.line : null,
      column: typeof dd.column === "number" ? dd.column : null,
      message: dd.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS),
    });
  }
  // Errors first, then warnings — so the cap never drops an error in favor of
  // a warning.
  out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return out.slice(0, MAX_BUILD_DIAGNOSTICS);
}

/** Published by the browser on each build transition (started/succeeded/
 *  failed) and again when finalized diagnostics arrive. */
export async function publishSimulatorBuild(
  projectId: string,
  result: Omit<SimBuildResult, "publishedAt">,
): Promise<void> {
  try {
    const redis = getRedis();
    await redis.setex(
      buildKey(projectId),
      BUILD_TTL_SECONDS,
      JSON.stringify({ ...result, publishedAt: Date.now() } satisfies SimBuildResult),
    );
  } catch {
    // Non-fatal — the waiter times out and reports "no build result".
  }
}

export async function getSimulatorBuild(
  projectId: string,
): Promise<SimBuildResult | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get<string>(buildKey(projectId));
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SimBuildResult;
  } catch {
    return null;
  }
}

export interface SimBuildWaitOutcome {
  /** Did an open workspace consume the start request at all? */
  pickedUp: boolean;
  /** Did a build reach succeeded/failed before the deadline? */
  completed: boolean;
  state?: "succeeded" | "failed";
  diagnostics: SimBuildDiagnosticSummary[];
  finalized: boolean;
  exitCode?: number | null;
  failureMessage?: string | null;
  /** True when we hit the deadline while a build was (or might still be) running. */
  timedOut: boolean;
}

const POLL_INTERVAL_MS = 2_500;
// After a build turns terminal, how long to linger for the authoritative
// xcresult diagnostics before returning the live regex-parsed set.
const FINALIZE_GRACE_MS = 12_000;

/**
 * Block until the build triggered by a start request completes, then return
 * its outcome. Used by BOTH agents' startSimulator tools.
 *
 * Matching: we only accept build publishes stamped at/after `requestedAt`
 * (both timestamps come from our server clock). Once a matching `started`
 * appears we lock onto its buildId, so a stale terminal publish from an
 * earlier user-initiated build can't be mistaken for ours. After a terminal
 * state we linger up to 12s for the finalized xcresult diagnostics.
 */
export async function waitForSimulatorBuild(
  projectId: string,
  opts: {
    requestedAt: number;
    /** Total budget, pickup included. Keep below the route's maxDuration. */
    timeoutMs: number;
    /** How long to wait for an open workspace to consume the request. */
    pickupTimeoutMs?: number;
  },
): Promise<SimBuildWaitOutcome> {
  const deadline = Date.now() + opts.timeoutMs;
  const pickupDeadline = Date.now() + (opts.pickupTimeoutMs ?? 30_000);
  const sleep = () => new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));

  let pickedUp = false;
  let lockedBuildId: string | null = null;
  let terminal: SimBuildResult | null = null;
  let terminalSeenAt = 0;

  while (Date.now() < deadline) {
    await sleep();

    if (!pickedUp) {
      // The workspace's poll GET consumes the desired key exactly once — the
      // key disappearing (before its 5-min TTL) means an open tab took it.
      const desired = await getSimulatorDesired(projectId);
      if (!desired || desired.requestedAt !== opts.requestedAt) {
        pickedUp = true;
      } else if (Date.now() > pickupDeadline) {
        return {
          pickedUp: false,
          completed: false,
          diagnostics: [],
          finalized: false,
          timedOut: false,
        };
      } else {
        continue;
      }
    }

    const build = await getSimulatorBuild(projectId);
    const isOurs =
      build !== null &&
      (build.buildId === lockedBuildId || build.publishedAt >= opts.requestedAt);
    if (build && isOurs) {
      if (build.buildId !== lockedBuildId) {
        // First matching build — or the workspace kicked off a NEWER build
        // (remount/rebuild). Track the latest one; its outcome is what
        // reflects the current code.
        lockedBuildId = build.buildId;
        terminal = null;
        terminalSeenAt = 0;
      }
      if (build.state !== "started") {
        if (!terminal) terminalSeenAt = Date.now();
        terminal = build;
        // Return as soon as the finalized diagnostics arrive, or after a
        // short grace window with whatever the live parser collected.
        if (build.finalized || Date.now() - terminalSeenAt > FINALIZE_GRACE_MS) {
          break;
        }
      }
    }
  }

  if (terminal) {
    return {
      pickedUp: true,
      completed: true,
      state: terminal.state === "failed" ? "failed" : "succeeded",
      diagnostics: terminal.diagnostics ?? [],
      finalized: terminal.finalized,
      exitCode: terminal.exitCode ?? null,
      failureMessage: terminal.message ?? null,
      timedOut: false,
    };
  }
  return {
    pickedUp: true,
    completed: false,
    diagnostics: [],
    finalized: false,
    timedOut: true,
  };
}

/**
 * Shared tool-facing formatter so the Botflow and Claude Code agents get the
 * exact same build report from startSimulator.
 */
export function formatBuildWaitOutcome(outcome: SimBuildWaitOutcome): {
  ok: boolean;
  status: "workspace-closed" | "build-succeeded" | "build-failed" | "timeout";
  message: string;
  errors?: SimBuildDiagnosticSummary[];
  warnings?: SimBuildDiagnosticSummary[];
} {
  if (!outcome.pickedUp) {
    return {
      ok: false,
      status: "workspace-closed",
      message:
        "No open workspace picked up the simulator start request within 30 seconds — " +
        "the user's workspace tab is closed or hidden. The request stays pending for 5 minutes; " +
        "tell the user to open (or focus) the project workspace to run the build.",
    };
  }
  if (!outcome.completed) {
    return {
      ok: false,
      status: "timeout",
      message:
        "The workspace picked up the request but the build did not finish within the wait window " +
        "(large builds and queued simulator slots can take a while). It may still be running — " +
        "call get_simulator_status to check; it includes the last build's outcome once done.",
    };
  }
  const errors = outcome.diagnostics.filter((d) => d.severity === "error");
  const warnings = outcome.diagnostics.filter((d) => d.severity === "warning");
  if (outcome.state === "failed") {
    return {
      ok: false,
      status: "build-failed",
      message:
        `Build FAILED with ${errors.length} error(s) and ${warnings.length} warning(s)` +
        (outcome.failureMessage ? ` — ${outcome.failureMessage}` : "") +
        (errors.length === 0
          ? ". No structured diagnostics were captured; the failure is likely a project-level " +
            "(non-compile) issue — check project structure and configuration."
          : ". Fix the errors below, then call startSimulator again."),
      errors,
      warnings,
    };
  }
  return {
    ok: true,
    status: "build-succeeded",
    message:
      `Build succeeded with ${warnings.length} warning(s). ` +
      "The app is installing and launching on the simulator in the user's workspace." +
      (warnings.length > 0
        ? " Consider addressing the warnings below if they are relevant to your change."
        : ""),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Combined status for the agent's getSimulatorStatus tool. */
export async function getSimulatorStatus(projectId: string): Promise<{
  ok: true;
  state: SimActualStatus;
  deviceModel: string | null;
  pendingAction: SimDesiredAction | null;
  lastBuild: {
    state: SimBuildResult["state"];
    errorCount: number;
    warningCount: number;
    diagnostics: SimBuildDiagnosticSummary[];
    finalized: boolean;
    message?: string | null;
    ageSeconds: number;
  } | null;
  note: string;
}> {
  const [actual, desired, build] = await Promise.all([
    getSimulatorActual(projectId),
    getSimulatorDesired(projectId),
    getSimulatorBuild(projectId),
  ]);
  const state = actual?.state ?? "stopped";
  return {
    ok: true,
    state,
    deviceModel: actual?.deviceModel ?? null,
    pendingAction: desired?.action ?? null,
    lastBuild: build
      ? {
          state: build.state,
          errorCount: build.diagnostics.filter((d) => d.severity === "error").length,
          warningCount: build.diagnostics.filter((d) => d.severity === "warning").length,
          diagnostics: build.diagnostics,
          finalized: build.finalized,
          message: build.message ?? null,
          ageSeconds: Math.max(0, Math.round((Date.now() - build.publishedAt) / 1000)),
        }
      : null,
    note:
      actual === null
        ? "No recent state reported by the workspace — the simulator is stopped or the user's workspace tab is closed."
        : "State as reported by the user's open workspace.",
  };
}
