import Link from 'next/link';
import { Database, Lock } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { auth } from '@/lib/auth/server';
import { eq } from 'drizzle-orm';
import { ConvexDashboard } from '@/components/convex/ConvexDashboard';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';

export default async function DatabasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { userId, redirectToSignIn } = await auth();

  if (!userId) {
    return redirectToSignIn({ returnBackUrl: `/workspace/${id}/database` });
  }

  const access = await requireProjectAccess(id, userId);
  const project = access?.project;

  if (!project) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-6 text-fg">
        <EmptyState
          icon={Lock}
          title="You don’t have access to this database"
          description="Ask the project owner to share the project with you."
          action={
            <Link href="/projects" className={buttonClass({ variant: 'primary' })}>
              Go to my projects
            </Link>
          }
        />
      </div>
    );
  }

  // No-backend projects don't have a Convex deployment to inspect. Show a
  // friendly explanation rather than letting the dashboard hit a 404 on the
  // database-session endpoint.
  if (project.backendType === 'none') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-6 text-fg">
        <EmptyState
          icon={Database}
          title="This project has no backend"
          description="It was created without one, so there’s no database to manage."
          action={
            <Link href={`/workspace/${id}`} className={buttonClass({ variant: 'primary' })}>
              Back to the workspace
            </Link>
          }
        />
      </div>
    );
  }

  await getDb()
    .update(projects)
    .set({ lastOpened: new Date() })
    .where(eq(projects.id, id));

  return (
    <div className="w-screen h-screen">
      <ConvexDashboard
        projectId={id}
        convexStatus={project.backendType === 'platform' ? project.convexStatus : undefined}
        isOwner={access?.role !== 'editor'}
      />
    </div>
  );
}
