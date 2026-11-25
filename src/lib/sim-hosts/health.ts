// Live status of a simulator host, from its controller's public /health
// endpoint: { ok, hosts: [{ id, slots, active, kind, lastHeartbeat }] }.

import type { SimHostRow } from "@/db/schema";
import type { SimHostHealth } from "./model";

interface HealthBody {
  ok?: boolean;
  hosts?: Array<{ id?: string; slots?: number; active?: number; kind?: string; lastHeartbeat?: number }>;
}

const TIMEOUT_MS = 3_000;
/** Routing reads health on every simulator start; a few seconds of staleness is fine. */
const CACHE_MS = 5_000;
const cache = new Map<string, { at: number; value: SimHostHealth }>();

export function clearSimHostHealthCache(): void {
  cache.clear();
}

export async function probeSimHostHealth(
  row: Pick<SimHostRow, "controllerUrl" | "agentHostId">,
  opts: { fresh?: boolean } = {},
): Promise<SimHostHealth> {
  const key = `${row.controllerUrl}|${row.agentHostId ?? ""}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const started = Date.now();
  let value: SimHostHealth;
  try {
    const res = await fetch(`${row.controllerUrl.replace(/\/$/, "")}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      value = offline(`Health check returned HTTP ${res.status}`, latencyMs);
    } else {
      const body = (await res.json().catch(() => null)) as HealthBody | null;
      value = body ? summarize(body, row.agentHostId, latencyMs) : offline("Health check returned no JSON", latencyMs);
    }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    value = offline(timedOut ? "Timed out" : "Not reachable", null);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

function offline(error: string, latencyMs: number | null): SimHostHealth {
  return {
    reachable: false,
    agentConnected: false,
    reportedKind: null,
    reportedSlots: null,
    activeSessions: null,
    lastHeartbeatAt: null,
    latencyMs,
    error,
  };
}

/**
 * One registry row ↔ one host agent. With agentHostId set, only that agent
 * counts; without it, every agent on the controller is summed (a controller
 * with one co-located agent, the usual set-up).
 */
function summarize(body: HealthBody, agentHostId: string | null, latencyMs: number): SimHostHealth {
  const agents = (body.hosts ?? []).filter((h) => !agentHostId || h.id === agentHostId);
  if (agents.length === 0) {
    return {
      reachable: true,
      agentConnected: false,
      reportedKind: null,
      reportedSlots: null,
      activeSessions: null,
      lastHeartbeatAt: null,
      latencyMs,
      error: agentHostId ? `Host agent “${agentHostId}” is not connected` : "No host agent connected",
    };
  }
  const kinds = [...new Set(agents.map((a) => a.kind).filter(Boolean))];
  const beat = Math.max(...agents.map((a) => a.lastHeartbeat ?? 0));
  return {
    reachable: true,
    agentConnected: true,
    reportedKind: kinds.length === 1 ? kinds[0]! : kinds.length > 1 ? "mixed" : null,
    reportedSlots: agents.reduce((n, a) => n + (a.slots ?? 0), 0),
    activeSessions: agents.reduce((n, a) => n + (a.active ?? 0), 0),
    lastHeartbeatAt: beat > 0 ? new Date(beat).toISOString() : null,
    latencyMs,
    error: null,
  };
}

/** Sessions this host can still take: the lower of its limit and the agent's slots, minus active ones. */
export function freeSlots(row: Pick<SimHostRow, "maxSessions">, health: SimHostHealth): number {
  const capacity = Math.min(row.maxSessions, health.reportedSlots ?? row.maxSessions);
  return capacity - (health.activeSessions ?? 0);
}
