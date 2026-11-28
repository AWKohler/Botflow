import { and, eq, isNull } from 'drizzle-orm';
import { projectMembers, projects } from '@/db/schema';
import { currentTestDb } from './db';

type NewProject = typeof projects.$inferInsert;
type NewMember = typeof projectMembers.$inferInsert;

export async function createProject(overrides: Partial<NewProject> & { userId: string }) {
  const [row] = await currentTestDb()
    .insert(projects)
    .values({ name: 'Test project', platform: 'sandboxed-web', ...overrides })
    .returning();
  return row;
}

/** Adds a member row. Like a real invite, it marks the project shared
 *  (projects.shared_at) if it wasn't already. */
export async function addMember(projectId: string, userId: string, overrides: Partial<NewMember> = {}) {
  await currentTestDb()
    .update(projects)
    .set({ sharedAt: new Date() })
    .where(and(eq(projects.id, projectId), isNull(projects.sharedAt)));
  const [row] = await currentTestDb()
    .insert(projectMembers)
    .values({
      projectId,
      userId,
      invitedEmail: `${userId}@example.test`,
      invitedBy: 'owner',
      status: 'active',
      acceptedAt: new Date(),
      ...overrides,
    })
    .returning();
  return row;
}
