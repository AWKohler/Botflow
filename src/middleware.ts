import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { enforce, identifierFor, type RateLimitBucket } from '@/lib/rate-limit';

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

// Coarse tiered rate-limit backbone covering all /api routes. Evaluated
// top-down, first match wins; anything unmatched falls through to 'global'.
//
// This composes safely with the precise in-handler limiters because the edge
// layer keys its identity under a distinct `edge:` namespace (see EDGE_PREFIX
// below). Even when the edge tier and the handler bucket are identical (e.g.
// both 'agent'), the two layers hit DIFFERENT Redis keys
// (rl:<bucket>:edge:user:<id> vs rl:<bucket>:user:<id>), so each layer holds
// its own independent counter at the full configured allowance instead of the
// two of them sharing — and halving — a single counter.
const EDGE_PREFIX = 'edge';
// NOTE: /api/internal/* (the Claude Code tool callback) is intentionally absent
// here — it bypasses the edge limiter via isPublicApi above and is enforced
// per-tenant inside the handler under the 'toolCallback' bucket.
const pathTiers: Array<[ReturnType<typeof createRouteMatcher>, RateLimitBucket]> = [
  [createRouteMatcher(['/api/agent/claude-code(.*)']), 'claudeCode'],
  [createRouteMatcher(['/api/agent(.*)']), 'agent'],
  [createRouteMatcher(['/api/oauth/(claude|codex)/poll(.*)']), 'oauthPoll'],
  [createRouteMatcher(['/api/oauth/(.*)/(callback|exchange)(.*)']), 'oauthExchange'],
  [createRouteMatcher(['/api/stripe/oauth/callback(.*)']), 'oauthExchange'],
  [createRouteMatcher(['/api/oauth/(.*)/start(.*)']), 'oauthStart'],
  [createRouteMatcher(['/api/stripe/oauth/start(.*)']), 'oauthStart'],
  [createRouteMatcher(['/api/og/(.*)']), 'publicHeavy'],
  [createRouteMatcher(['/api/public/projects/(.*)/source(.*)']), 'publicHeavy'],
  [createRouteMatcher(['/api/public/(.*)']), 'public'],
  [createRouteMatcher(['/api/uploadthing(.*)']), 'upload'],
  [createRouteMatcher(['/api/projects/(.*)/(publish|migrate-to-sandbox)(.*)']), 'deploy'],
  [createRouteMatcher(['/api/projects/(.*)/sandbox/publish(.*)']), 'deploy'],
  [createRouteMatcher(['/api/projects/(.*)/convex/deploy(.*)']), 'deploy'],
  [createRouteMatcher(['/api/convex/provision(.*)']), 'deploy'],
  [createRouteMatcher(['/api/projects/(.*)/swift-(device|preview)/(build|start|rebuild)(.*)']), 'deploy'],
  [createRouteMatcher(['/api/projects/(.*)/sandbox/(exec|seed|session|devserver|search)(.*)']), 'expensive'],
  [createRouteMatcher(['/api/projects/(.*)/github/sandbox/(.*)']), 'expensive'],
  [createRouteMatcher(['/api/projects/(.*)/git/(push|pull)(.*)']), 'expensive'],
  [createRouteMatcher(['/api/projects/(.*)/(custom-domain|managed-domain|persistent-sandbox)(.*)']), 'expensive'],
  [createRouteMatcher(['/api/projects/(.*)/convex/(setup-auth|setup-oauth-provider)(.*)']), 'expensive'],
  [createRouteMatcher(['/api/projects/(.*)/(snapshot)(.*)']), 'upload'],
  [createRouteMatcher(['/api/(chat-images|chat)/(.*)']), 'write'],
  [createRouteMatcher(['/api/domains(.*)']), 'write'],
  [createRouteMatcher(['/api/github/repos(.*)']), 'write'],
  [createRouteMatcher(['/api/projects/(.*)/(env|stripe|revenuecat|github|visual-edit|browser-log|agent-backend|chat)(.*)']), 'write'],
  [createRouteMatcher(['/api/projects(.*)']), 'write'],
  [createRouteMatcher(['/api/usage/(.*)']), 'read'],
  [createRouteMatcher(['/api/user(.*)']), 'read'],
  [createRouteMatcher(['/api/(.*)']), 'global'],
];

function bucketFor(req: Parameters<typeof isPublicApi>[0]): RateLimitBucket {
  for (const [matches, bucket] of pathTiers) {
    if (matches(req)) return bucket;
  }
  return 'global';
}

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
    const bucket = bucketFor(req);
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
