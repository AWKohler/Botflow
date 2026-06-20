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

export type EnvVarTarget = "client" | "server";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate tool input before opening a modal. Returns an error string the
 *  model can act on, or null when the request is well-formed. */
export function validateEnvVarRequest(input: {
  target: unknown;
  key: unknown;
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
  return null;
}

/** Insert a pending request (dismissing any stale pending ones first so the
 *  workspace modal always reflects the newest ask). Returns the request id. */
export async function createEnvVarRequest(params: {
  projectId: string;
  userId: string;
  target: EnvVarTarget;
  key: string;
  message?: string | null;
  isSecret?: boolean;
}): Promise<string> {
  const db = getDb();
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

/** Block until the user completes or dismisses the modal (up to 5 minutes).
 *  On timeout the row is marked dismissed so the workspace modal closes. */
export async function pollEnvVarRequest(params: {
  requestId: string;
  projectId: string;
}): Promise<EnvVarRequestOutcome> {
  const db = getDb();
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
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

  await db
    .update(envVarRequests)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(
      and(
        eq(envVarRequests.id, params.requestId),
        eq(envVarRequests.projectId, params.projectId),
        eq(envVarRequests.status, "pending"),
      ),
    )
    .catch(() => undefined);
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
          `Timed out waiting for the user to enter ${key} (5 minutes). Nothing was saved. ` +
          `Call the tool again when the user is ready.`,
      };
  }
}
