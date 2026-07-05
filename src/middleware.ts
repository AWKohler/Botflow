import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { enforce, identifierFor } from '@/lib/rate-limit';
import { classifyApiRequest } from '@/lib/rate-limit-classify';

const isProtectedRoute = createRouteMatcher([
  '/workspace(.*)',
  '/api/(.*)'
]);

// Server-to-server endpoints authenticate themselves (svix signature for
// Clerk webhooks, shared bearer for Vercel cron, per-binding tool bearer token
// for the Claude Code tool callback); they MUST bypass Clerk's user-auth gate
// or the verification step never runs. They also bypass the edge rate limiter:
// their signature/secret is the real gate, and IP-keying their provider bursts
// risks dropping legitimate traffic.
//
// /api/internal/* in particular egresses from a small set of shared Fly worker
// IPs and carries a custom bearer tool token (NOT a Clerk session), so at the
// edge auth() returns userId=null and every tenant's callbacks collapse onto
// one edge:ip:<worker-ip> counter — a single 90/min budget shared across all
// users (cross-tenant throttling). The handler self-authenticates the bearer
// and runs its OWN limiter keyed by the binding's userId, so the correct,
// per-tenant enforcement still happens; we only drop the broken edge IP layer.
const isPublicApi = createRouteMatcher([
  '/api/webhooks/(.*)',
  '/api/cron/(.*)',
  '/api/internal/(.*)',
]);

// Coarse tiered rate-limit backbone covering all /api routes. The route→bucket
// table lives in src/lib/rate-limit-classify.ts (pure + unit-tested); it is
// METHOD-AWARE — background polling GETs go to the 'poll'/'pollHeavy' buckets
// and generic project GETs to 'read', so polling can never exhaust 'write'
// (the bug that 429'd the projects page and model selection whenever a
// workspace tab was open).
//
// This composes safely with the precise in-handler limiters because the edge
// layer keys its identity under a distinct `edge:` namespace (see EDGE_PREFIX
// below). Even when the edge tier and the handler bucket are identical (e.g.
// both 'agent'), the two layers hit DIFFERENT Redis keys
// (rl:<bucket>:edge:user:<id> vs rl:<bucket>:user:<id>), so each layer holds
// its own independent counter at the full configured allowance instead of the
// two of them sharing — and halving — a single counter.
//
// NOTE: /api/internal/* (the Claude Code tool callback) is intentionally not
// classified — it bypasses the edge limiter via isPublicApi above and is
// enforced per-tenant inside the handler under the 'toolCallback' bucket.
const EDGE_PREFIX = 'edge';

export default clerkMiddleware(async (auth, req) => {
  // Webhooks/cron bypass both auth and rate limiting — unchanged contract.
  if (isPublicApi(req)) return;

  // Only the /api surface is rate-limited; protected pages (/workspace*) skip
  // straight to the auth gate below.
  if (req.nextUrl.pathname.startsWith('/api/')) {
    const { userId } = await auth();
    // Namespace the edge identity so the coarse middleware counter never shares
    // a Redis key with the precise in-handler counter for the same bucket+user.
    // Without this the two layers double-count one bucket (halving the limit).
    const id = `${EDGE_PREFIX}:${identifierFor(userId, req)}`;
    const bucket = classifyApiRequest(req.method, req.nextUrl.pathname);
    // Limiter runs before auth.protect() so unauth floods are rejected (429)
    // cheaply, IP-keyed, without spinning Clerk. Fails open if Redis is unset.
    const blocked = await enforce(id, bucket);
    if (blocked) return blocked;
  }

  if (isProtectedRoute(req)) auth.protect();
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)'
  ],
};
