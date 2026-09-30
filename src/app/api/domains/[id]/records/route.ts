import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { getDb } from '@/db';
import { userDomains, domainDnsRecords } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { createDnsRecord, listDnsRecords } from '@/lib/cloudflare-zones';

async function getOwned(userId: string, id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(userDomains)
    .where(and(eq(userDomains.id, id), eq(userDomains.userId, userId)))
    .limit(1);
  return row ?? null;
}

// GET — list records from CF (source of truth) + sync to local cache
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const domain = await getOwned(userId, id);
  if (!domain || !domain.cfZoneId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const cfRecords = await listDnsRecords(domain.cfZoneId);
  // Cache locally (best-effort) — clear then insert.
  const db = getDb();
  await db.delete(domainDnsRecords).where(eq(domainDnsRecords.domainId, domain.id));
  if (cfRecords.length) {
    await db.insert(domainDnsRecords).values(
      cfRecords.map((r) => ({
        domainId: domain.id,
        cfRecordId: r.id,
        type: r.type,
        name: r.name,
        content: r.content,
        ttl: r.ttl,
        priority: r.priority ?? null,
        proxied: Boolean(r.proxied),
      })),
    );
  }

  return NextResponse.json({ records: cfRecords });
}

// POST { type, name, content, ttl?, priority?, proxied? } — create a record
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const domain = await getOwned(userId, id);
  if (!domain || !domain.cfZoneId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    type?: string;
    name?: string;
    content?: string;
    ttl?: number;
    priority?: number;
    proxied?: boolean;
  };
  if (!body.type || !body.name || !body.content) {
    return NextResponse.json({ error: 'type, name, and content are required' }, { status: 400 });
  }

  try {
    const created = await createDnsRecord(domain.cfZoneId, {
      type: body.type,
      name: body.name,
      content: body.content,
      ttl: body.ttl ?? 1,
      priority: body.priority,
      proxied: Boolean(body.proxied),
    });
    const db = getDb();
    await db.insert(domainDnsRecords).values({
      domainId: domain.id,
      cfRecordId: created.id,
      type: created.type,
      name: created.name,
      content: created.content,
      ttl: created.ttl,
      priority: created.priority ?? null,
      proxied: Boolean(created.proxied),
    });
    return NextResponse.json({ record: created });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
