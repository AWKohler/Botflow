import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projectEnvVars } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { requireProjectAccess } from '@/lib/project-access';
import { materializeFrontendEnv, platformConvexEnvVar } from '@/lib/sandbox-env';
import { isReservedEnvKey } from '@/lib/platform-env';

/**
 * Frontend (Vite) environment variables.
 *
 * Source of truth: the `project_env_vars` table. After every mutation we
 * regenerate /vercel/sandbox/.env from the DB (see materializeFrontendEnv) so
 * the running dev server and the next production build pick up the change.
 *
 * Backend (Convex) env vars are handled by the sibling route
 * `env/backend/route.ts` and live on the Convex deployment, not here.
 */

async function loadOwnedProject(projectId: string, userId: string) {
  const access = await requireProjectAccess(projectId, userId);
  return access?.project ?? null;
}

/**
 * GET - List frontend env vars (user-defined) plus the read-only,
 * platform-managed VITE_CONVEX_URL / EXPO_PUBLIC_CONVEX_URL.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const project = await loadOwnedProject(id, userId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const db = getDb();
  const envVars = await db.select().from(projectEnvVars)
    .where(eq(projectEnvVars.projectId, id));

  const systemEnvVars: Array<{ key: string; value: string; isSystem: true; isSecret: false }> = [];
  const platformVar = platformConvexEnvVar(project);
  if (platformVar) {
    systemEnvVars.push({ ...platformVar, isSystem: true, isSecret: false });
  }

  return NextResponse.json({
    envVars: envVars
      .filter((e) => !isReservedEnvKey(e.key)) // never surface a reserved key as user-editable
      .map((e) => ({
        id: e.id,
        key: e.key,
        value: e.value,
        isSecret: e.isSecret,
        isSystem: false,
      })),
    systemEnvVars,
  });
}

/**
 * POST - Create or update a single frontend env var.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const project = await loadOwnedProject(id, userId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json();
  const { key, value, isSecret } = body as { key: string; value: string; isSecret?: boolean };

  if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return NextResponse.json(
      { error: 'Invalid variable name. Use letters, numbers, and underscores only. Must start with a letter or underscore.' },
      { status: 400 }
    );
  }

  if (isReservedEnvKey(key)) {
    return NextResponse.json(
      { error: 'This variable is managed by Botflow and can’t be edited here.' },
      { status: 400 }
    );
  }

  const db = getDb();
  const [envVar] = await db.insert(projectEnvVars)
    .values({ projectId: id, key: key.toUpperCase(), value, isSecret: isSecret ?? false })
    .onConflictDoUpdate({
      target: [projectEnvVars.projectId, projectEnvVars.key],
      set: { value, isSecret: isSecret ?? false, updatedAt: new Date() },
    })
    .returning();

  // Push the change into the sandbox .env (best-effort: a stopped/expired
  // sandbox shouldn't block saving — it'll be regenerated on next dev start).
  let synced = true;
  let syncError: string | undefined;
  try {
    await materializeFrontendEnv(id);
  } catch (e) {
    synced = false;
    syncError = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json({
    id: envVar.id,
    key: envVar.key,
    value: envVar.value,
    isSecret: envVar.isSecret,
    isSystem: false,
    synced,
    syncError,
  }, { status: 201 });
}

/**
 * PUT - Bulk import frontend env vars from .env content.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const project = await loadOwnedProject(id, userId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { content } = await req.json() as { content: string };

  const lines = content.split('\n');
  const parsed: Array<{ key: string; value: string }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1].toUpperCase();
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (isReservedEnvKey(key)) continue; // silently skip platform-managed keys
    parsed.push({ key, value });
  }

  const db = getDb();
  let imported = 0;
  for (const { key, value } of parsed) {
    await db.insert(projectEnvVars)
      .values({ projectId: id, key, value, isSecret: false })
      .onConflictDoUpdate({
        target: [projectEnvVars.projectId, projectEnvVars.key],
        set: { value, updatedAt: new Date() },
      });
    imported++;
  }

  let synced = true;
  let syncError: string | undefined;
  try {
    await materializeFrontendEnv(id);
  } catch (e) {
    synced = false;
    syncError = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json({ imported, synced, syncError });
}

/**
 * DELETE - Remove a frontend env var by key.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const project = await loadOwnedProject(id, userId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { key } = await req.json() as { key: string };
  if (!key) return NextResponse.json({ error: 'Key is required' }, { status: 400 });

  if (isReservedEnvKey(key)) {
    return NextResponse.json(
      { error: 'This variable is managed by Botflow and can’t be deleted here.' },
      { status: 400 }
    );
  }

  const db = getDb();
  await db.delete(projectEnvVars)
    .where(and(
      eq(projectEnvVars.projectId, id),
      eq(projectEnvVars.key, key.toUpperCase())
    ));

  let synced = true;
  let syncError: string | undefined;
  try {
    await materializeFrontendEnv(id);
  } catch (e) {
    synced = false;
    syncError = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json({ success: true, synced, syncError });
}
