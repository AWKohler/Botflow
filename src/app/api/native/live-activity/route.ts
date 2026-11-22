/**
 * POST /api/native/live-activity  { token, projectId, threadId, environment?, startedAt? }
 *
 * The iOS app started a Live Activity for an agent it is following and hands
 * over that activity's push token, so the server can keep it up to date (and
 * end it) while the app is suspended.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import { requireProjectAccess } from "@/lib/project-access";
import { getThread } from "@/lib/agent/threads";
import { APNS_TOKEN_PATTERN, registerLiveActivity } from "@/lib/native/devices";
import { seedActivityState } from "@/lib/native/agent-push";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    token?: unknown;
    projectId?: unknown;
    threadId?: unknown;
    environment?: unknown;
    startedAt?: unknown;
  } | null;
  const token = typeof body?.token === "string" ? body.token.toLowerCase() : "";
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  const threadId = typeof body?.threadId === "string" ? body.threadId : "";
  if (!APNS_TOKEN_PATTERN.test(token) || !projectId || !threadId) {
    return NextResponse.json({ error: "token, projectId and threadId are required" }, { status: 400 });
  }
  const access = await requireProjectAccess(projectId, userId);
  if (!access || !(await getThread(projectId, threadId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const environment = body?.environment === "development" ? "development" : "production";
    await registerLiveActivity(userId, threadId, { token, environment, projectId });
    const startedAt = typeof body?.startedAt === "number" && Number.isFinite(body.startedAt) ? body.startedAt : Date.now();
    await seedActivityState(userId, threadId, startedAt);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("POST /api/native/live-activity failed:", err);
    return NextResponse.json({ error: "Could not register the activity" }, { status: 500 });
  }
}
