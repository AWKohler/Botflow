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

export async function addMember(projectId: string, userId: string, overrides: Partial<NewMember> = {}) {
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
