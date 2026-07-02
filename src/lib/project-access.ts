import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects, type Project } from '@/db/schema';

/**
 * Roles a user can hold on a project. Today access == ownership; the
 * project-sharing feature (docs/features/project-sharing-plan.md) adds
 * 'editor' via a project_members lookup inside requireProjectAccess, so
 * every call site picks up membership at once without signature changes.
 */
export type ProjectRole = 'owner' | 'editor';

export interface ProjectAccess {
  project: Project;
  role: ProjectRole;
}

/**
 * Resolve whether `userId` may access `projectId` at `minRole`.
 *
 * Returns null when the project doesn't exist OR the user has no access —
 * callers respond 404 for both, so project existence is never revealed to
 * non-members. Callers keep their own response shape; this helper only
 * answers the access question and hands back the project row (saving the
 * fetch every route was already doing).
 */
export async function requireProjectAccess(
  projectId: string,
  userId: string,
  _minRole: ProjectRole = 'editor',
): Promise<ProjectAccess | null> {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || project.userId !== userId) return null;
  return { project, role: 'owner' };
}
