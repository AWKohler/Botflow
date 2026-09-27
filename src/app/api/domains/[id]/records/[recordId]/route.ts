import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { getDb } from '@/db';
import { userDomains, domainDnsRecords } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { deleteDnsRecord, updateDnsRecord } from '@/lib/cloudflare-zones';

async function getOwned(userId: string, id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(userDomains)
    .where(and(eq(userDomains.id, id), eq(userDomains.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; recordId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id, recordId } = await params;
  const domain = await getOwned(userId, id);
  if (!domain || !domain.cfZoneId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const updated = await updateDnsRecord(domain.cfZoneId, recordId, body);
    const db = getDb();
    await db
      .update(domainDnsRecords)
      .set({
        type: updated.type,
        name: updated.name,
        content: updated.content,
        ttl: updated.ttl,
        priority: updated.priority ?? null,
        proxied: Boolean(updated.proxied),
        updatedAt: new Date(),
      })
      .where(and(eq(domainDnsRecords.domainId, domain.id), eq(domainDnsRecords.cfRecordId, recordId)));
    return NextResponse.json({ record: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; recordId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id, recordId } = await params;
  const domain = await getOwned(userId, id);
  if (!domain || !domain.cfZoneId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    await deleteDnsRecord(domain.cfZoneId, recordId);
    const db = getDb();
    await db
      .delete(domainDnsRecords)
      .where(and(eq(domainDnsRecords.domainId, domain.id), eq(domainDnsRecords.cfRecordId, recordId)));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
