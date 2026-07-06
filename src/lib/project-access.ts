import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects, projectMembers, type Project } from '@/db/schema';
import { SHARING_ENABLED } from '@/lib/feature-flags';

/**
 * Roles a user can hold on a project. The owner is projects.userId (never a
 * project_members row); active members hold 'editor'
 * (docs/features/project-sharing-plan.md §3).
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
 *
 * minRole 'owner' marks owner-only surfaces (delete, publish, domains,
 * billing integrations, member management). Default 'editor' admits the
 * owner plus ACTIVE members when SHARING_ENABLED; with the flag off,
 * behavior is strictly single-owner regardless of member rows.
 */
export async function requireProjectAccess(
  projectId: string,
  userId: string,
  minRole: ProjectRole = 'editor',
): Promise<ProjectAccess | null> {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;
  if (project.userId === userId) return { project, role: 'owner' };
  if (!SHARING_ENABLED || minRole === 'owner') return null;

  const [member] = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        eq(projectMembers.status, 'active'),
      ),
    )
    .limit(1);
  if (!member) return null;
  return { project, role: 'editor' };
}

/** Secret-bearing project fields an editor must never receive
 *  (plan §3.3 role matrix — field-level filtering). */
const OWNER_ONLY_FIELDS = [
  'convexDeployKey',
  'userConvexDeployKey',
  'stripeWebhookSecret',
  'revenuecatWebhookSecret',
] as const;

/**
 * Strip secret fields from a project row before returning it to a non-owner.
 * Owners get the row unchanged (existing client behavior depends on it).
 */
export function sanitizeProjectForRole(project: Project, role: ProjectRole): Project {
  if (role === 'owner') return project;
  const clone: Project = { ...project };
  for (const f of OWNER_ONLY_FIELDS) clone[f] = null;
  return clone;
}
