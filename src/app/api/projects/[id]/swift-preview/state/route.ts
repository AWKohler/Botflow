/**
 * Simulator desired/actual state — the workspace's side of the sim control
 * plane (see src/lib/swift-sim-control.ts).
 *
 *   GET    → polled by the open workspace (~2.5s). Returns the pending desired
 *            action (set by the agent's startSimulator/stopSimulator tools)
 *            and consumes it: a desired action is delivered exactly once.
 *   POST   → the workspace publishes the stream's actual state on every
 *            transition (starting/building/live/failed/stopped) so the agent's
 *            getSimulatorStatus tool reflects reality.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import {
  clearSimulatorDesired,
  getSimulatorDesired,
  publishSimulatorActual,
  type SimActualStatus,
} from "@/lib/swift-sim-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTUAL_STATES: SimActualStatus[] = [
  "stopped",
  "starting",
  "building",
  "installing",
  "live",
  "failed",
];

async function loadAuthorizedProject(projectId: string) {
  const { userId } = await auth();
  if (!userId) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== userId || project.platform !== "swift") {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  if (await swiftRuntimeForbidden(project.platform, userId)) {
    return {
      error: NextResponse.json(
        { error: "Swift projects are currently in private beta." },
        { status: 403 },
      ),
    };
  }
  return { project };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await loadAuthorizedProject(id);
  if ("error" in result) return result.error;

  const desired = await getSimulatorDesired(id);
  if (desired) {
    // Exactly-once delivery: the polling workspace acts on it; nobody else
    // should see it again (including this same workspace on the next tick).
    await clearSimulatorDesired(id);
  }
  return NextResponse.json({ desired });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await loadAuthorizedProject(id);
  if ("error" in result) return result.error;

  const body = (await req.json().catch(() => null)) as {
    state?: string;
    deviceModel?: string | null;
  } | null;
  if (!body || !ACTUAL_STATES.includes(body.state as SimActualStatus)) {
    return NextResponse.json(
      { error: `state must be one of: ${ACTUAL_STATES.join(", ")}` },
      { status: 400 },
    );
  }

  await publishSimulatorActual(id, {
    state: body.state as SimActualStatus,
    deviceModel: typeof body.deviceModel === "string" ? body.deviceModel : null,
  });
  return NextResponse.json({ ok: true });
}
