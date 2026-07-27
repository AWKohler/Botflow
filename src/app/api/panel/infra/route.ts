import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAdmin } from '@/lib/panel/auth';
import { panelCached } from '@/lib/panel/cache';
import {
  getProjectAggregates,
  getConvexAggregates,
  getWebhookHealth,
  getOpsSignals,
} from '@/lib/panel/queries';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function computeInfra() {
  const [projects, convex, webhooks, ops] = await Promise.all([
    getProjectAggregates(),
    getConvexAggregates(),
    getWebhookHealth(),
    getOpsSignals(),
  ]);

  return {
    projects,
    convex,
    webhooks,
    ops,
    sandboxes: {
      byProvider: projects.bySandboxProvider,
      // Snapshot storage is 1 rolling auto-snapshot per Vercel sandbox with a
      // 90-day expiry (src/lib/vercel-sandbox.ts). Vercel exposes no billing
      // API and we don't meter snapshot sizes yet, so storage cost is not
      // computable — surfaced as null so the UI says so instead of guessing.
      snapshotStorageUsd: null as number | null,
      snapshotPolicy: '1 rolling auto-snapshot per sandbox, 90-day expiry',
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const adminId = await requirePanelAdmin();
  if (!adminId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const refresh = req.nextUrl.searchParams.get('refresh') === '1';
    const data = await panelCached('infra', 120, refresh, computeInfra);
    return NextResponse.json(data);
  } catch (error) {
    console.error('[panel/infra] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load infra' },
      { status: 500 },
    );
  }
}
