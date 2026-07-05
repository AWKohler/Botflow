import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { userDomains } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getUserTierAndLimits } from '@/lib/tier';
import { createZone } from '@/lib/cloudflare-zones';

/**
 * The platform's white-label deployment domain (e.g. botflow-site.app) lives in
 * the same CF account but is infrastructure, not a user domain — it must never
 * be listable or addable as a managed domain.
 */
function isPlatformDomain(apex: string): boolean {
  const branded = process.env.CLOUDFLARE_BRANDED_DOMAIN?.toLowerCase();
  if (!branded) return false;
  const a = apex.toLowerCase();
  return a === branded || a.endsWith(`.${branded}`);
}

// GET /api/domains — list user's managed domains
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();
  const allRows = await db
    .select()
    .from(userDomains)
    .where(eq(userDomains.userId, userId))
    .orderBy(desc(userDomains.createdAt));
  const rows = allRows.filter((r) => !isPlatformDomain(r.apexDomain));

  const limits = await getUserTierAndLimits(userId);
  return NextResponse.json({
    domains: rows,
    canAdd: limits.managedDomains && rows.length < limits.maxManagedDomains,
    tier: limits.tier,
    managedDomainsEnabled: limits.managedDomains,
    maxManagedDomains: limits.maxManagedDomains,
  });
}

// POST /api/domains { apexDomain } — create new zone in CF, return nameservers
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const limits = await getUserTierAndLimits(userId);
  if (!limits.managedDomains) {
    return NextResponse.json(
      { error: 'Managed domains require a Pro or Max plan.', upgrade: true },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { apexDomain?: string };
  const raw = (body.apexDomain ?? '').trim().toLowerCase();
  // Strip protocol, leading "www.", trailing slashes.
  const apex = raw
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(apex)) {
    return NextResponse.json({ error: 'Invalid domain name' }, { status: 400 });
  }
  if (isPlatformDomain(apex)) {
    return NextResponse.json({ error: 'This domain is reserved by the platform.' }, { status: 400 });
  }

  const db = getDb();
  const existing = await db.select().from(userDomains).where(eq(userDomains.userId, userId));
  if (existing.length >= limits.maxManagedDomains) {
    return NextResponse.json(
      { error: `You've reached your managed-domain limit (${limits.maxManagedDomains}).` },
      { status: 403 },
    );
  }
  if (existing.some((d) => d.apexDomain === apex)) {
    return NextResponse.json({ error: 'Domain already added.' }, { status: 409 });
  }

  let zone;
  try {
    zone = await createZone(apex);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // CF reports zone.status === 'active' even when the user previously pointed
  // NS at CF and later reverted at their registrar. Trusting that status causes
  // the UI to skip the "set your nameservers" instructions, leaving users with
  // a managed-domain that no one can resolve. Always start as pending_ns so the
  // detail view explains what to do; the status poll will flip it active once
  // CF's NS check confirms.
  const [row] = await db
    .insert(userDomains)
    .values({
      userId,
      apexDomain: apex,
      cfZoneId: zone.id,
      status: 'pending_ns',
      nameservers: zone.name_servers,
    })
    .returning();

  return NextResponse.json({ domain: row });
}
