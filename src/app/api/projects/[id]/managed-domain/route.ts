import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects, userDomains } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireProjectAccess } from '@/lib/project-access';
import { getUserTierAndLimits } from '@/lib/tier';
import {
  attachPagesCustomDomain,
  detachPagesCustomDomain,
  upsertDnsRecord,
  deleteDnsRecord,
  listDnsRecords,
  ensureBrandedDeploymentUrl,
} from '@/lib/cloudflare-zones';

async function getProject(userId: string, projectId: string) {
  const access = await requireProjectAccess(projectId, userId);
  return access?.project ?? null;
}

/** Build the fully-qualified hostname from a (sub, apex) pair. "" / "@" / apex → apex. */
function buildHostname(sub: string, apex: string): string {
  const s = sub.trim().toLowerCase();
  if (!s || s === '@' || s === apex) return apex;
  if (s.endsWith(`.${apex}`)) return s;
  return `${s}.${apex}`;
}

/** Inverse of buildHostname — CF expects "@" for apex, the leftmost label otherwise. */
function recordNameFor(hostname: string, apex: string): string {
  if (hostname === apex) return '@';
  return hostname.replace(`.${apex}`, '');
}

/**
 * Wire one hostname to the project: create the proxied CNAME in the zone and
 * attach the hostname to the Pages project. Idempotent (upsert + attach handles 409).
 */
async function attachOne(
  zoneId: string,
  pagesProjectName: string,
  hostname: string,
  apex: string,
) {
  const pagesTarget = `${pagesProjectName}.pages.dev`;
  await upsertDnsRecord(zoneId, {
    type: 'CNAME',
    name: recordNameFor(hostname, apex),
    content: pagesTarget,
    proxied: true,
    ttl: 1,
    comment: 'Managed by Botflow',
  });
  await attachPagesCustomDomain(pagesProjectName, hostname);
}

/**
 * Remove one hostname from the project: detach Pages binding and delete the
 * matching CNAME (only if it still points at the Pages target — never delete
 * unrelated records the user may have added).
 */
async function detachOne(
  zoneId: string,
  pagesProjectName: string,
  hostname: string,
) {
  await detachPagesCustomDomain(pagesProjectName, hostname).catch(() => {});
  const records = await listDnsRecords(zoneId).catch(() => [] as Awaited<ReturnType<typeof listDnsRecords>>);
  const match = records.find(
    (r) => r.type === 'CNAME' && r.name === hostname && r.content.endsWith('.pages.dev'),
  );
  if (match) await deleteDnsRecord(zoneId, match.id).catch(() => {});
}

// POST /api/projects/[id]/managed-domain { domainId, subdomain?, mirrorToOther? }
//   subdomain          "" / "@" → apex; "www" → www.apex; "app" → app.apex; default "www"
//   mirrorToOther      true → also serve the "other side": apex if primary is www;
//                              www if primary is apex. Both serve identical content.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: projectId } = await params;
  const project = await getProject(userId, projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  if (!project.cloudflareProjectName) {
    return NextResponse.json(
      { error: 'Project is not published. Publish first, then assign a domain.' },
      { status: 400 },
    );
  }

  const limits = await getUserTierAndLimits(userId);
  if (!limits.managedDomains) {
    return NextResponse.json({ error: 'Managed domains require Pro or Max.', upgrade: true }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    domainId?: string;
    subdomain?: string;
    mirrorToOther?: boolean;
  };
  if (!body.domainId) {
    return NextResponse.json({ error: 'domainId required' }, { status: 400 });
  }

  const db = getDb();
  const [domain] = await db
    .select()
    .from(userDomains)
    .where(and(eq(userDomains.id, body.domainId), eq(userDomains.userId, userId)))
    .limit(1);
  if (!domain) return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
  if (domain.status !== 'active' || !domain.cfZoneId) {
    return NextResponse.json(
      { error: 'Domain is not active yet. Update your registrar nameservers and wait for activation.' },
      { status: 400 },
    );
  }

  const apex = domain.apexDomain;
  const sub = body.subdomain ?? 'www';
  const primaryHostname = buildHostname(sub, apex);

  // If the project was previously attached to a different managed hostname, detach
  // that first so we don't orphan a Pages binding pointing at a stale name.
  if (project.managedDomainHostname && project.managedDomainHostname !== primaryHostname) {
    await detachOne(domain.cfZoneId, project.cloudflareProjectName, project.managedDomainHostname).catch(() => {});
  }

  // Build the list of hostnames to wire up. mirrorToOther adds the natural pair
  // (apex ↔ www) so a user picking "www" can serve apex too with one click.
  const hostnames = new Set<string>([primaryHostname]);
  if (body.mirrorToOther) {
    const other = primaryHostname === apex ? `www.${apex}` : apex;
    hostnames.add(other);
  }

  try {
    for (const h of hostnames) {
      await attachOne(domain.cfZoneId, project.cloudflareProjectName, h, apex);
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const deploymentUrl = `https://${primaryHostname}`;
  await db
    .update(projects)
    .set({
      managedDomainId: domain.id,
      managedDomainHostname: primaryHostname,
      cloudflareDeploymentUrl: deploymentUrl,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, project.id));

  return NextResponse.json({
    ok: true,
    hostname: primaryHostname,
    url: deploymentUrl,
    hostnames: [...hostnames],
  });
}

// DELETE — detach managed domain from this project.
// Cleans up BOTH the primary hostname and the apex/www mirror if one exists.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: projectId } = await params;
  const project = await getProject(userId, projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  if (!project.managedDomainId || !project.managedDomainHostname) {
    return NextResponse.json({ ok: true });
  }

  const db = getDb();
  const [domain] = await db
    .select()
    .from(userDomains)
    .where(eq(userDomains.id, project.managedDomainId))
    .limit(1);

  if (domain?.cfZoneId && project.cloudflareProjectName) {
    // Detach primary + the natural mirror (covers both apex+www if mirrorToOther
    // was used at attach time; harmless no-ops otherwise).
    const apex = domain.apexDomain;
    const primary = project.managedDomainHostname;
    const mirror = primary === apex ? `www.${apex}` : (primary === `www.${apex}` ? apex : null);
    await detachOne(domain.cfZoneId, project.cloudflareProjectName, primary).catch(() => {});
    if (mirror) await detachOne(domain.cfZoneId, project.cloudflareProjectName, mirror).catch(() => {});
  }

  // Fall back to the white-label branded URL (or .pages.dev when unconfigured).
  const fallbackUrl = project.cloudflareProjectName
    ? await ensureBrandedDeploymentUrl(project.cloudflareProjectName)
    : null;

  await db
    .update(projects)
    .set({
      managedDomainId: null,
      managedDomainHostname: null,
      cloudflareDeploymentUrl: fallbackUrl,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, project.id));

  return NextResponse.json({ ok: true, url: fallbackUrl });
}
