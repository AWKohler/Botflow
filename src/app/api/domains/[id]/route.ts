import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { userDomains, projects } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { deleteZone, detachPagesCustomDomain, ensureBrandedDeploymentUrl } from '@/lib/cloudflare-zones';

async function getOwned(userId: string, id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(userDomains)
    .where(and(eq(userDomains.id, id), eq(userDomains.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const domain = await getOwned(userId, id);
  if (!domain) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ domain });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const domain = await getOwned(userId, id);
  if (!domain) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const db = getDb();

  // Detach from any project that has this domain assigned + tear down the Pages binding.
  const linkedProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.managedDomainId, domain.id));
  for (const p of linkedProjects) {
    if (p.cloudflareProjectName && p.managedDomainHostname) {
      await detachPagesCustomDomain(p.cloudflareProjectName, p.managedDomainHostname).catch(() => {});
    }
    await db
      .update(projects)
      .set({
        managedDomainId: null,
        managedDomainHostname: null,
        // Fall back to the white-label branded URL (or .pages.dev when unconfigured).
        cloudflareDeploymentUrl: p.cloudflareProjectName
          ? await ensureBrandedDeploymentUrl(p.cloudflareProjectName)
          : null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, p.id));
  }

  if (domain.cfZoneId) {
    try { await deleteZone(domain.cfZoneId); } catch (err) {
      console.warn('deleteZone failed', err);
    }
  }
  await db.delete(userDomains).where(eq(userDomains.id, domain.id));

  return NextResponse.json({ ok: true });
}
