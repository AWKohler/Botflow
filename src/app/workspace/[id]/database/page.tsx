import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
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

  const project = (await requireProjectAccess(id, userId))?.project;

  if (!project) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-elevated text-[var(--sand-text)]">
        <div className="max-w-md text-center space-y-4 p-8 rounded-2xl border border-border bg-white shadow-sm">
          <h1 className="text-2xl font-semibold">No access to this project</h1>
          <p className="text-sm text-neutral-600">
            You don&apos;t have permission to view this database.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Link
              href="/projects"
              className="inline-flex items-center rounded-xl bg-black px-4 py-2 text-sm font-medium text-white shadow hover:opacity-90 transition"
            >
              Go to my projects
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // No-backend projects don't have a Convex deployment to inspect. Show a
  // friendly explanation rather than letting the dashboard hit a 404 on the
  // database-session endpoint.
  if (project.backendType === 'none') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-elevated text-[var(--sand-text)]">
        <div className="max-w-md text-center space-y-4 p-8 rounded-2xl border border-border bg-white shadow-sm">
          <h1 className="text-2xl font-semibold">No backend connected</h1>
          <p className="text-sm text-neutral-600">
            This project was created without a backend, so there is no database to manage.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Link
              href={`/workspace/${id}`}
              className="inline-flex items-center rounded-xl bg-black px-4 py-2 text-sm font-medium text-white shadow hover:opacity-90 transition"
            >
              Back to workspace
            </Link>
          </div>
        </div>
      </div>
    );
  }

  await getDb()
    .update(projects)
    .set({ lastOpened: new Date() })
    .where(eq(projects.id, id));

  return (
    <div className="w-screen h-screen">
      <ConvexDashboard projectId={id} />
    </div>
  );
}
