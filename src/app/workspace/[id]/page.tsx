import { auth } from '@/lib/auth/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireProjectAccess } from '@/lib/project-access';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { IsolationGuard } from './isolation-guard';
import { normalizeProjectPlatform, normalizeBackendType } from '@/lib/project-platform';

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId, redirectToSignIn } = await auth();
  const { id: projectId } = await params;
  const searchParamsResolved = searchParams ? await searchParams : {};
  const initialPrompt = typeof searchParamsResolved.prompt === 'string' ? searchParamsResolved.prompt : undefined;

  if (!userId) {
    return redirectToSignIn({ returnBackUrl: `/workspace/${projectId}` });
  }

  const access = await requireProjectAccess(projectId, userId);
  const proj = access?.project;

  // Prefer query param, fall back to the project's saved platform
  const platform = typeof searchParamsResolved.platform === 'string'
    ? normalizeProjectPlatform(searchParamsResolved.platform)
    : (proj ? normalizeProjectPlatform(proj.platform) : undefined);

  // Backend type controls template selection and which UI affordances are shown
  // (Database tab, convexDeploy tool, .env injection of VITE_CONVEX_URL).
  const backendType = proj ? normalizeBackendType(proj.backendType) : undefined;

  if (!proj) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-6 text-fg">
        <EmptyState
          icon={Lock}
          title="You don’t have access to this project"
          description="If that looks wrong, check that you’re signed in with the right account, or ask the owner to share it with you."
          action={
            <>
              <Link href="/projects" className={buttonClass({ variant: 'primary' })}>
                Go to my projects
              </Link>
              <Link href="/" className={buttonClass({ variant: 'secondary' })}>
                Back home
              </Link>
            </>
          }
        />
      </div>
    );
  }

  await getDb()
    .update(projects)
    .set({ lastOpened: new Date() })
    .where(eq(projects.id, projectId));

  return <IsolationGuard projectId={projectId} initialPrompt={initialPrompt} platform={platform} backendType={backendType} />;
}
