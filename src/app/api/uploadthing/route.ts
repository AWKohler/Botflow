import { createRouteHandler } from 'uploadthing/next';
import { auth } from '@clerk/nextjs/server';
import type { NextRequest } from 'next/server';
import { ourFileRouter } from './core';
import { enforce, identifierFor } from '@/lib/rate-limit';

const handlers = createRouteHandler({
  router: ourFileRouter,
});

// Tightly capped: file-upload traffic is highly abusable for storage/bandwidth
// exhaustion. Auth is enforced inside ./core middleware, not here, so key by
// userId when resolvable and fall back to IP for unauth/presign callback traffic.
async function withRateLimit(req: NextRequest) {
  const { userId } = await auth().catch(() => ({ userId: null }));
  return enforce(identifierFor(userId, req), 'upload');
}

export async function GET(req: NextRequest) {
  const blocked = await withRateLimit(req);
  if (blocked) return blocked;
  return handlers.GET(req);
}

export async function POST(req: NextRequest) {
  const blocked = await withRateLimit(req);
  if (blocked) return blocked;
  return handlers.POST(req);
}
