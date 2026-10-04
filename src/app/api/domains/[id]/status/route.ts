import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { getDb } from '@/db';
import { userDomains } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { activationCheck, getZone } from '@/lib/cloudflare-zones';

// GET /api/domains/[id]/status — poll CF for current activation status, sync to DB.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const [row] = await db
    .select()
    .from(userDomains)
    .where(and(eq(userDomains.id, id), eq(userDomains.userId, userId)))
    .limit(1);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!row.cfZoneId) return NextResponse.json({ domain: row });

  try {
    // Nudge CF to re-check NS records — this is cheap and idempotent.
    await activationCheck(row.cfZoneId);
    const zone = await getZone(row.cfZoneId);
    const newStatus = zone.status === 'active' ? 'active' : 'pending_ns';
    const nameservers = zone.name_servers ?? row.nameservers;
    if (newStatus !== row.status || JSON.stringify(nameservers) !== JSON.stringify(row.nameservers)) {
      await db
        .update(userDomains)
        .set({ status: newStatus, nameservers, updatedAt: new Date() })
        .where(eq(userDomains.id, row.id));
      return NextResponse.json({
        domain: { ...row, status: newStatus, nameservers },
        cfStatus: zone.status,
      });
    }
    return NextResponse.json({ domain: row, cfStatus: zone.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), domain: row },
      { status: 502 },
    );
  }
}
