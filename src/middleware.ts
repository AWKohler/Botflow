import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from '@/lib/auth/config';
import { enforce, identifierFor } from '@/lib/rate-limit';
import { classifyApiRequest } from '@/lib/rate-limit-classify';

// Reachable WITHOUT a session (still rate-limited below). Each handler is its
// own gate: project secret (Stripe proxy calls from generated apps), provider
// signature (UploadThing, Sanity), or an intentionally public read that
// degrades for signed-out viewers (gallery, OG images, tier). Requiring a
// session here 401s generated apps' checkouts and every logged-out visitor.
// src/middleware.test.ts keeps this list in sync with the route handlers.
const SESSIONLESS_API = [
  /^\/api\/public\//,
  /^\/api\/og\//,
  /^\/api\/uploadthing$/,
  /^\/api\/revalidate\/sanity$/,
  /^\/api\/usage\/tier$/,
  /^\/api\/projects\/[^/]+\/stripe\/(checkout-session|dashboard-link|subscription-status)$/,
];

export default async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  // These routes verify their own signatures/bearers; auth endpoints enforce
  // origin checks and persistent authentication rate limits in Better Auth.
  if (/^\/api\/(webhooks|cron|internal|auth)(\/|$)/.test(path)) return NextResponse.next();
  if (req.method === 'GET' && /^\/api\/identity\/avatar\/[^/]+$/.test(path)) return NextResponse.next();
  const protectedRoute = /^\/(workspace|panel|account)(\/|$)/.test(path) || path.startsWith('/api/');
  if (!protectedRoute) return NextResponse.next();
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (path.startsWith('/api/')) {
    const blocked = await enforce(`identity-edge:${identifierFor(session?.user.id ?? null, req)}`, classifyApiRequest(req.method, path));
    if (blocked) return blocked;
    if (!session && !SESSIONLESS_API.some((re) => re.test(path))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  } else if (!session) {
    const url = new URL('/sign-in', req.url);
    url.searchParams.set('redirect_url', path + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)', '/(api|trpc)(.*)'],
};
