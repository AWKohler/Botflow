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

function desiredKey(projectId: string): string {
  return `swift-sim:desired:${projectId}`;
}

function actualKey(projectId: string): string {
  return `swift-sim:actual:${projectId}`;
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

/** Combined status for the agent's getSimulatorStatus tool. */
export async function getSimulatorStatus(projectId: string): Promise<{
  ok: true;
  state: SimActualStatus;
  deviceModel: string | null;
  pendingAction: SimDesiredAction | null;
  note: string;
}> {
  const [actual, desired] = await Promise.all([
    getSimulatorActual(projectId),
    getSimulatorDesired(projectId),
  ]);
  const state = actual?.state ?? "stopped";
  return {
    ok: true,
    state,
    deviceModel: actual?.deviceModel ?? null,
    pendingAction: desired?.action ?? null,
    note:
      actual === null
        ? "No recent state reported by the workspace — the simulator is stopped or the user's workspace tab is closed."
        : "State as reported by the user's open workspace.",
  };
}
