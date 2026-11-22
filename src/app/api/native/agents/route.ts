/**
 * GET /api/native/agents
 *
 * Every agent across the caller's projects that deserves attention: running,
 * waiting for input, stopped on an error, or finished since they last looked.
 * The iOS app's Agents tab polls this; one request instead of one per project.
 *
 * Only projects with thread activity in the last two weeks are examined, so
 * the cost follows what is actually going on, not how many projects exist.
 */
import { NextResponse } from "next/server";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { chatSessions, projectMembers, projects } from "@/db/schema";
import { auth } from "@/lib/auth/server";
import { SHARING_ENABLED } from "@/lib/feature-flags";
import { listThreadSummaries } from "@/lib/agent/threads";

export const dynamic = "force-dynamic";

const RECENT_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PROJECTS = 12;

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getDb();

    const owned = await db
      .select({ id: projects.id, name: projects.name, platform: projects.platform, model: projects.model })
      .from(projects)
      .where(and(eq(projects.userId, userId), isNull(projects.deletedAt)));

    let shared: typeof owned = [];
    if (SHARING_ENABLED) {
      const memberships = await db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(and(eq(projectMembers.userId, userId), eq(projectMembers.status, "active")));
      if (memberships.length > 0) {
        shared = await db
          .select({ id: projects.id, name: projects.name, platform: projects.platform, model: projects.model })
          .from(projects)
          .where(and(inArray(projects.id, memberships.map((m) => m.projectId)), isNull(projects.deletedAt)));
      }
    }

    const all = new Map([...owned, ...shared].map((p) => [p.id, p]));
    if (all.size === 0) return NextResponse.json({ agents: [] });

    // Which of those projects had a thread touched recently, newest first.
    const recent = await db
      .select({ projectId: chatSessions.projectId, updatedAt: chatSessions.updatedAt })
      .from(chatSessions)
      .where(
        and(
          inArray(chatSessions.projectId, [...all.keys()]),
          isNull(chatSessions.archivedAt),
          gt(chatSessions.updatedAt, new Date(Date.now() - RECENT_MS)),
        ),
      )
      .orderBy(desc(chatSessions.updatedAt))
      .limit(400);
    const activeIds = [...new Set(recent.map((r) => r.projectId))].slice(0, MAX_PROJECTS);

    const perProject = await Promise.all(
      activeIds.map(async (projectId) => {
        const project = all.get(projectId)!;
        const threads = await listThreadSummaries(project, userId).catch(() => []);
        return threads
          .filter((t) => !t.archived && (t.status !== "idle" || t.unread))
          .map((thread) => ({ projectId, projectName: project.name, platform: project.platform, thread }));
      }),
    );

    return NextResponse.json({ agents: perProject.flat() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("GET /api/native/agents failed:", err);
    return NextResponse.json({ error: "Failed to load agents" }, { status: 500 });
  }
}
