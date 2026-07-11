import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { requireProjectAccess } from '@/lib/project-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await requireProjectAccess(id, userId);

  if (!access) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const proj = access.project;

  // Resolve Convex URL and key — prefer user (BYOC) fields, fall back to platform fields
  const deploymentUrl = proj.userConvexUrl || proj.convexDeployUrl;
  const adminKey = proj.userConvexDeployKey || proj.convexDeployKey;
  const deploymentName = proj.convexDeploymentId;

  if (!deploymentUrl || !adminKey) {
    return NextResponse.json({ error: 'No Convex backend for this project' }, { status: 404 });
  }

  // This response carries the Convex admin/deploy key for the embedded Convex
  // dashboard (the owner's own key, in the owner's authenticated session, handed
  // to dashboard-embedded.convex.dev via an origin-scoped postMessage — the
  // official Convex embed pattern). Never let it be cached anywhere.
  return NextResponse.json(
    { deploymentUrl, deploymentName, adminKey },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' } },
  );
}
