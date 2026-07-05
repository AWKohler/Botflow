import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requireProjectAccess } from '@/lib/project-access';
import { listConvexEnvVars, setConvexEnvVar, deleteConvexEnvVar } from '@/lib/convex-env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Backend (Convex) environment variables.
 *
 * The Convex deployment is the sole source of truth — we store nothing in our
 * DB. Reads/writes proxy live to the deployment via its deploy key, so the
 * Convex dashboard and this panel stay perfectly in sync.
 *
 * Only available for projects with a Convex backend (backendType !== 'none').
 */

async function loadOwnedProject(projectId: string, userId: string) {
  const access = await requireProjectAccess(projectId, userId);
  return access?.project ?? null;
}

/** GET - list the deployment's env vars (reserved keys flagged read-only). */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const project = await loadOwnedProject(id, userId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (project.backendType === 'none') {
    return NextResponse.json({ available: false, vars: [] });
  }

  const result = await listConvexEnvVars(id);
  if (!result.ok) {
    return NextResponse.json({ available: true, error: result.error }, { status: 502 });
  }
  return NextResponse.json({ available: true, vars: result.vars });
}

/** POST - create or update a backend env var. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const project = await loadOwnedProject(id, userId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (project.backendType === 'none') {
    return NextResponse.json({ error: 'This project has no backend.' }, { status: 400 });
  }

  const { key, value } = await req.json() as { key: string; value: string };
  if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return NextResponse.json(
      { error: 'Invalid variable name. Use letters, numbers, and underscores only.' },
      { status: 400 }
    );
  }

  const result = await setConvexEnvVar(id, key, value ?? '');
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ success: true });
}

/** DELETE - remove a backend env var by key. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const project = await loadOwnedProject(id, userId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (project.backendType === 'none') {
    return NextResponse.json({ error: 'This project has no backend.' }, { status: 400 });
  }

  const { key } = await req.json() as { key: string };
  if (!key) return NextResponse.json({ error: 'Key is required' }, { status: 400 });

  const result = await deleteConvexEnvVar(id, key);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ success: true });
}
