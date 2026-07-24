/**
 * Shared logic for the agent's "request env var" tool — used by BOTH agent
 * backends (Botflow's requestEnvVar in sandboxed-web-tools.ts and Claude
 * Code's request_env_var case in /api/internal/claude-code-tool).
 *
 * Flow mirrors the OAuth-provider modal handshake:
 *   1. The agent calls the tool with a variable NAME + target; we insert a
 *      pending env_var_requests row.
 *   2. The workspace polls GET /api/projects/[id]/env/request, sees the
 *      pending row, and opens the EnvVarModal where the user types the VALUE.
 *   3. Saving POSTs to the same route, which writes the value (Vite .env or
 *      Convex deployment) and marks the row completed. Dismissing (X) marks
 *      it dismissed.
 *   4. The tool blocks here, polling the row, and reports completed /
 *      declined / timed-out back to the model. The VALUE itself never reaches
 *      the agent.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { envVarRequests } from "@/db/schema";
import { isReservedEnvKey } from "@/lib/platform-env";
import { clearAgentWaiting, markAgentWaiting } from "@/lib/agent/modal-wait";

export type EnvVarTarget = "client" | "server";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate tool input before opening a modal. Returns an error string the
 *  model can act on, or null when the request is well-formed. */
export function validateEnvVarRequest(input: {
  target: unknown;
  key: unknown;
  isSecret?: unknown;
}): string | null {
  if (input.target !== "client" && input.target !== "server") {
    return "target must be 'client' (frontend Vite .env) or 'server' (Convex deployment).";
  }
  if (typeof input.key !== "string" || !ENV_KEY_RE.test(input.key)) {
    return "Invalid variable name. Use letters, numbers, and underscores only; must start with a letter or underscore.";
  }
  if (isReservedEnvKey(input.key)) {
    return `${input.key} is managed by Botflow and can't be set by the user.`;
  }
  // A CLIENT (frontend) env var is compiled into the browser bundle and written
  // to the sandbox .env — it is NOT secret and the agent can read it. Refuse to
  // collect an actual secret there; real secrets must go to the server (Convex)
  // target, which is never exposed to the frontend or the sandbox.
  if (input.target === "client" && input.isSecret === true) {
    return "Client (frontend) env vars are embedded in the browser bundle and readable from the sandbox — they are NOT secret. For an actual secret (API key, token), use target='server' (Convex deployment). If this value is genuinely public (a publishable key, a feature flag, a public URL), set isSecret=false.";
  }
  return null;
}

/** Insert a pending request (dismissing any stale pending ones first so the
 *  workspace modal always reflects the newest ask). Returns the request id.
 *
 *  If a pending request for the SAME key+target already exists, it is reused
 *  instead of being replaced — the user may be mid-typing in that very modal,
 *  and a retry by the agent must not yank it out from under them. */
export async function createEnvVarRequest(params: {
  projectId: string;
  userId: string;
  target: EnvVarTarget;
  key: string;
  message?: string | null;
  isSecret?: boolean;
}): Promise<string> {
  const db = getDb();
  const [existing] = await db
    .select({ id: envVarRequests.id })
    .from(envVarRequests)
    .where(
      and(
        eq(envVarRequests.projectId, params.projectId),
        eq(envVarRequests.status, "pending"),
        eq(envVarRequests.key, params.key),
        eq(envVarRequests.target, params.target),
      ),
    )
    .limit(1);
  if (existing) {
    // Bump updatedAt: it doubles as the wait-start timestamp for the agent's
    // wait ceiling, and a fresh tool call means the wait restarts now.
    await db
      .update(envVarRequests)
      .set({ updatedAt: new Date() })
      .where(eq(envVarRequests.id, existing.id));
    return existing.id;
  }

  await db
    .update(envVarRequests)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(
      and(
        eq(envVarRequests.projectId, params.projectId),
        eq(envVarRequests.status, "pending"),
      ),
    );

  const [record] = await db
    .insert(envVarRequests)
    .values({
      projectId: params.projectId,
      userId: params.userId,
      target: params.target,
      key: params.key,
      message: params.message ?? null,
      isSecret: params.isSecret ?? false,
      status: "pending",
    })
    .returning({ id: envVarRequests.id });
  return record.id;
}

export type EnvVarRequestOutcome = "completed" | "dismissed" | "timeout";

/** One short polling window (for the Claude Code tool route, whose bridge-side
 *  caller loops until terminal). Refreshes the "agent is waiting" marker so a
 *  late submit knows whether anyone is still listening. Returns 'pending' when
 *  the window closes without a terminal status — the row is NOT touched. */
export async function pollEnvVarRequestOnce(params: {
  requestId: string;
  projectId: string;
  windowMs?: number;
}): Promise<"completed" | "dismissed" | "pending"> {
  const db = getDb();
  const deadline = Date.now() + (params.windowMs ?? 20_000);
  void markAgentWaiting("env-var", params.requestId);
  for (;;) {
    const [row] = await db
      .select({ status: envVarRequests.status })
      .from(envVarRequests)
      .where(
        and(
          eq(envVarRequests.id, params.requestId),
          eq(envVarRequests.projectId, params.projectId),
        ),
      )
      .limit(1);
    if (!row) return "dismissed"; // row disappeared — treat as declined
    if (row.status === "completed") return "completed";
    if (row.status === "dismissed") return "dismissed";
    if (Date.now() >= deadline) return "pending";
    await new Promise<void>((r) => setTimeout(r, 2500));
  }
}

/** Block until the user completes or dismisses the modal (up to 4.5 minutes —
 *  bounded by the caller's serverless maxDuration; used by the Botflow rail).
 *
 *  On timeout the row is left PENDING and the modal stays open: a timeout
 *  means "the user hasn't finished yet", never "the user declined". The
 *  workspace's lazy stale-expiry eventually clears truly abandoned rows, and
 *  a late submit triggers a system-note back to the agent. */
export async function pollEnvVarRequest(params: {
  requestId: string;
  projectId: string;
}): Promise<EnvVarRequestOutcome> {
  const db = getDb();
  const deadline = Date.now() + 270 * 1000;
  while (Date.now() < deadline) {
    void markAgentWaiting("env-var", params.requestId);
    await new Promise<void>((r) => setTimeout(r, 2500));
    const [row] = await db
      .select({ status: envVarRequests.status })
      .from(envVarRequests)
      .where(
        and(
          eq(envVarRequests.id, params.requestId),
          eq(envVarRequests.projectId, params.projectId),
        ),
      )
      .limit(1);
    if (!row) return "dismissed"; // row disappeared — treat as declined
    if (row.status === "completed") return "completed";
    if (row.status === "dismissed") return "dismissed";
  }
  // Giving up: drop the wait marker NOW so a submit seconds later correctly
  // notifies the agent instead of assuming an active waiter, then do one
  // FINAL status read — a save that landed between the last poll and the
  // marker clear would otherwise be swallowed (the modal saw an active
  // waiter, so no system-note, but no poller will ever read the result).
  await clearAgentWaiting("env-var", params.requestId);
  const [finalRow] = await db
    .select({ status: envVarRequests.status })
    .from(envVarRequests)
    .where(
      and(
        eq(envVarRequests.id, params.requestId),
        eq(envVarRequests.projectId, params.projectId),
      ),
    )
    .limit(1);
  if (finalRow?.status === "completed") return "completed";
  if (finalRow?.status === "dismissed") return "dismissed";
  return "timeout";
}

/** Canonical tool-result strings so both agent backends report identically. */
export function envVarOutcomeMessage(
  outcome: EnvVarRequestOutcome,
  key: string,
  target: EnvVarTarget,
): { ok: boolean; content: string } {
  const where =
    target === "client"
      ? "the frontend .env (restart-safe; the dev server picks it up automatically)"
      : "the Convex deployment";
  switch (outcome) {
    case "completed":
      return {
        ok: true,
        content:
          `${key} was set on ${where}. The value was entered by the user and stored server-side — ` +
          `it is intentionally not shown to you. Continue with the implementation that uses it.`,
      };
    case "dismissed":
      return {
        ok: false,
        content:
          `User declined to set ${key} — the modal was dismissed and nothing was saved. ` +
          `Do not retry automatically. Continue without it and tell the user they can set it later ` +
          `from the workspace Env panel.`,
      };
    case "timeout":
      return {
        ok: false,
        content:
          `The user has NOT entered ${key} yet — the modal is still open in their workspace; nothing was dismissed or declined. ` +
          `Do NOT say the user dismissed or declined it. Continue with other work; you'll get a system note when they save it, ` +
          `or you can call the tool again later to resume waiting.`,
      };
  }
}
