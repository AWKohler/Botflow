/**
 * Env-var entry requests — the modal handshake for the agent's requestEnvVar
 * tool (see src/lib/agent/env-var-requests.ts for the flow).
 *
 * GET  ?requestId=<uuid> — agent polling: status of a specific request.
 * GET  (no params)       — workspace polling: latest pending request, so the
 *                          workspace can open the EnvVarModal.
 * POST { requestId, value }            — save the value and complete.
 * POST { requestId, dismissed: true }  — user hit X / Cancel.
 * DELETE                               — dismiss ALL pending requests (used
 *                          when the user stops the agent mid-turn).
 *
 * The value is written server-side only: client target → project_env_vars +
 * sandbox .env rematerialization; server target → Convex deployment env. It
 * is never echoed back to the agent.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { envVarRequests, projectEnvVars, projects } from "@/db/schema";
import { materializeFrontendEnv } from "@/lib/sandbox-env";
import { setConvexEnvVar } from "@/lib/convex-env";
import { isReservedEnvKey } from "@/lib/platform-env";
import { isAgentWaiting, MODAL_STALE_AFTER_MS } from "@/lib/agent/modal-wait";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function loadOwnedProject(projectId: string, userId: string) {
  const db = getDb();
  const [project] = await db
    .select({ id: projects.id, userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || project.userId !== userId) return null;
  return project;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    const { id: projectId } = await params;
    if (!(await loadOwnedProject(projectId, userId))) {
      return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
    }

    const db = getDb();
    const requestId = req.nextUrl.searchParams.get("requestId");

    if (requestId) {
      const [row] = await db
        .select({ status: envVarRequests.status })
        .from(envVarRequests)
        .where(and(eq(envVarRequests.id, requestId), eq(envVarRequests.projectId, projectId)))
        .limit(1);
      return NextResponse.json({ ok: true, status: row?.status ?? "not_found" });
    }

    const [pending] = await db
      .select({
        id: envVarRequests.id,
        target: envVarRequests.target,
        key: envVarRequests.key,
        message: envVarRequests.message,
        isSecret: envVarRequests.isSecret,
        updatedAt: envVarRequests.updatedAt,
      })
      .from(envVarRequests)
      .where(and(eq(envVarRequests.projectId, projectId), eq(envVarRequests.status, "pending")))
      .orderBy(desc(envVarRequests.createdAt))
      .limit(1);

    // Lazy stale-expiry: agent pollers no longer dismiss rows on timeout, so
    // long-abandoned requests are retired here — never while an agent is
    // actively waiting on them.
    if (
      pending &&
      Date.now() - pending.updatedAt.getTime() > MODAL_STALE_AFTER_MS &&
      !(await isAgentWaiting("env-var", pending.id))
    ) {
      await db
        .update(envVarRequests)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(and(eq(envVarRequests.id, pending.id), eq(envVarRequests.status, "pending")));
      return NextResponse.json({ ok: true, pending: null });
    }

    return NextResponse.json({
      ok: true,
      pending: pending
        ? {
            id: pending.id,
            target: pending.target,
            key: pending.key,
            message: pending.message,
            isSecret: pending.isSecret,
          }
        : null,
    });
  } catch (err) {
    console.error("[env/request] GET error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    const { id: projectId } = await params;
    if (!(await loadOwnedProject(projectId, userId))) {
      return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
    }

    const body = (await req.json()) as {
      requestId?: string;
      value?: string;
      dismissed?: boolean;
    };
    if (!body.requestId) {
      return NextResponse.json({ ok: false, error: "requestId is required." }, { status: 400 });
    }

    const db = getDb();
    const [request] = await db
      .select()
      .from(envVarRequests)
      .where(and(eq(envVarRequests.id, body.requestId), eq(envVarRequests.projectId, projectId)))
      .limit(1);
    if (!request) {
      return NextResponse.json({ ok: false, error: "Request not found." }, { status: 404 });
    }

    if (body.dismissed) {
      // Only dismiss a still-pending request — a delayed dismiss must NOT flip a
      // just-completed one back to dismissed.
      await db
        .update(envVarRequests)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(and(eq(envVarRequests.id, request.id), eq(envVarRequests.status, "pending")));
      return NextResponse.json({ ok: true, status: "dismissed" });
    }

    if (request.status !== "pending") {
      return NextResponse.json(
        { ok: false, error: "This request is no longer pending." },
        { status: 409 },
      );
    }
    const value = typeof body.value === "string" ? body.value : "";
    if (!value.trim()) {
      return NextResponse.json({ ok: false, error: "Value is required." }, { status: 400 });
    }
    if (isReservedEnvKey(request.key)) {
      return NextResponse.json(
        { ok: false, error: "This variable is managed by Botflow and can't be set here." },
        { status: 400 },
      );
    }

    // Atomically CLAIM the request (pending → "completing") BEFORE writing the
    // value, so a concurrent dismiss/timeout can't win mid-write and make the
    // agent observe a transient 'dismissed'. The agent poller treats any
    // non-terminal status (incl. 'completing') as keep-waiting.
    const [claimed] = await db
      .update(envVarRequests)
      .set({ status: "completing", updatedAt: new Date() })
      .where(and(eq(envVarRequests.id, request.id), eq(envVarRequests.status, "pending")))
      .returning({ id: envVarRequests.id });
    if (!claimed) {
      return NextResponse.json(
        { ok: false, error: "This request is no longer pending (it was dismissed or already completed)." },
        { status: 409 },
      );
    }

    try {
      if (request.target === "server") {
        const result = await setConvexEnvVar(projectId, request.key, value);
        if (!result.ok) {
          // Revert so the user can retry.
          await db
            .update(envVarRequests)
            .set({ status: "pending", updatedAt: new Date() })
            .where(eq(envVarRequests.id, request.id))
            .catch(() => undefined);
          return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
        }
      } else {
        await db
          .insert(projectEnvVars)
          .values({
            projectId,
            key: request.key.toUpperCase(),
            value,
            isSecret: request.isSecret,
          })
          .onConflictDoUpdate({
            target: [projectEnvVars.projectId, projectEnvVars.key],
            set: { value, isSecret: request.isSecret, updatedAt: new Date() },
          });
        // Best-effort: a stopped/expired sandbox shouldn't block saving — the
        // .env is regenerated on the next dev-server start anyway.
        try {
          await materializeFrontendEnv(projectId);
        } catch {
          /* regenerated on next dev start */
        }
      }
    } catch (e) {
      // Revert on any unexpected failure so the request isn't stuck 'completing'.
      await db
        .update(envVarRequests)
        .set({ status: "pending", updatedAt: new Date() })
        .where(eq(envVarRequests.id, request.id))
        .catch(() => undefined);
      throw e;
    }

    // Side effect durable → finalize. We hold the claim, so this can't be raced.
    await db
      .update(envVarRequests)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(envVarRequests.id, request.id));

    // Tell the modal whether an agent poller is still actively waiting on this
    // request (if not, the workspace sends a system-note so the agent learns
    // the value arrived).
    const agentWaiting = await isAgentWaiting("env-var", request.id);

    return NextResponse.json({
      ok: true,
      status: "completed",
      key: request.key,
      target: request.target,
      agentWaiting,
    });
  } catch (err) {
    console.error("[env/request] POST error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    const { id: projectId } = await params;
    if (!(await loadOwnedProject(projectId, userId))) {
      return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
    }

    const db = getDb();
    await db
      .update(envVarRequests)
      .set({ status: "dismissed", updatedAt: new Date() })
      .where(and(eq(envVarRequests.projectId, projectId), eq(envVarRequests.status, "pending")));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[env/request] DELETE error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
