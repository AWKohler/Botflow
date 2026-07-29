/**
 * Request → rate-limit bucket classification. Single source of truth for the
 * edge middleware's tiering, extracted into a pure function so it can be
 * unit-tested with plain strings (no NextRequest / createRouteMatcher needed).
 *
 * WHY METHOD-AWARE: the original path-only table sent every `/api/projects/**`
 * request — including the workspace's background polling GETs — into the
 * 'write' bucket (60/min). One open workspace polls preview-state (2s), env
 * requests (2.5s), Convex OAuth status (2.5s), Stripe connect requests (2.5s)
 * and the file-tree signature (3s): ~120+ req/min, so a single ready workspace
 * exhausted 'write' by itself and 429'd real mutations (model select, project
 * list) for as long as any tab stayed open. Classification therefore must
 * consider the HTTP method, and known polling GETs get their own buckets so
 * background polling can NEVER starve interactive reads/writes.
 *
 * Rules are evaluated top-down, first match wins; `global` is the fallback.
 * A rule's bucket is either a single bucket (method-agnostic — endpoints whose
 * cost is the same or that only serve one method) or a `{ read, mutate }` pair:
 * GET/HEAD/OPTIONS take `read`, everything else takes `mutate`.
 */

import type { RateLimitBucket } from './rate-limit';

type MethodSplit = { read: RateLimitBucket; mutate: RateLimitBucket };
type Tier = RateLimitBucket | MethodSplit;

const RULES: Array<[RegExp, Tier]> = [
  [/^\/api\/agent\/claude-code/, 'claudeCode'],
  [/^\/api\/agent/, 'agent'],
  [/^\/api\/oauth\/(claude|codex)\/poll/, 'oauthPoll'],
  [/^\/api\/oauth\/.+\/(callback|exchange)/, 'oauthExchange'],
  [/^\/api\/stripe\/oauth\/callback/, 'oauthExchange'],
  [/^\/api\/oauth\/.+\/start/, 'oauthStart'],
  [/^\/api\/stripe\/oauth\/start/, 'oauthStart'],
  [/^\/api\/og\//, 'publicHeavy'],
  [/^\/api\/public\/projects\/.+\/source/, 'publicHeavy'],
  [/^\/api\/public\//, 'public'],
  [/^\/api\/uploadthing/, 'upload'],
  [/^\/api\/projects\/[^/]+\/(publish|migrate-to-sandbox)/, 'deploy'],
  [/^\/api\/projects\/[^/]+\/sandbox\/publish/, 'deploy'],
  [/^\/api\/projects\/[^/]+\/convex\/deploy/, 'deploy'],
  [/^\/api\/convex\/provision/, 'deploy'],
  // Swift flows: preview and device builds are used back-to-back (start a sim,
  // then "run on iPhone"), so they must NOT share a bucket — and certainly not
  // the 5-token 'deploy' one, where a single preview retry locked out the IPA
  // build. Capacity for the actual heavy work is enforced host-side.
  [/^\/api\/projects\/[^/]+\/swift-preview\/(build|start|rebuild)/, 'swiftPreview'],
  [/^\/api\/projects\/[^/]+\/swift-device\/build/, 'swiftDevice'],

  // ── Workspace polling endpoints ─────────────────────────────────────────
  // GETs here are hit on 2–4s loops by every open, ready workspace; they get
  // the dedicated poll buckets. Mutations on the same paths (POST env/request,
  // DELETE stripe/connect-request, …) are ordinary writes.
  [/^\/api\/projects\/[^/]+\/sandbox\/preview-state/, { read: 'poll', mutate: 'write' }],
  [/^\/api\/projects\/[^/]+\/env\/request/, { read: 'poll', mutate: 'write' }],
  [/^\/api\/projects\/[^/]+\/convex\/oauth-provider-status/, { read: 'poll', mutate: 'write' }],
  [/^\/api\/projects\/[^/]+\/stripe\/connect-request/, { read: 'poll', mutate: 'write' }],
  [/^\/api\/projects\/[^/]+\/swift-preview\/state/, { read: 'poll', mutate: 'write' }],
  // File listing/signature/content GETs run `find|cksum`/`cat` inside the
  // sandbox — heavier than a Redis read, so they get their own tighter bucket.
  [/^\/api\/projects\/[^/]+\/sandbox\/files/, { read: 'pollHeavy', mutate: 'write' }],

  [/^\/api\/projects\/[^/]+\/sandbox\/(exec|seed|session|devserver|search)/, 'expensive'],
  [/^\/api\/projects\/[^/]+\/github\/sandbox\//, 'expensive'],
  [/^\/api\/projects\/[^/]+\/git\/(push|pull)/, 'expensive'],
  [/^\/api\/projects\/[^/]+\/(custom-domain|managed-domain|persistent-sandbox)/, 'expensive'],
  [/^\/api\/projects\/[^/]+\/convex\/(setup-auth|setup-oauth-provider)/, 'expensive'],
  [/^\/api\/projects\/[^/]+\/snapshot/, 'upload'],
  [/^\/api\/(chat-images|chat)(\/|$)/, { read: 'read', mutate: 'write' }],
  [/^\/api\/domains/, { read: 'read', mutate: 'write' }],
  [/^\/api\/github\/repos/, { read: 'read', mutate: 'write' }],
  [/^\/api\/projects\/[^/]+\/(env|stripe|revenuecat|github|visual-edit|browser-log|agent-backend|chat)/, { read: 'read', mutate: 'write' }],
  // Generic project reads (list, detail) vs mutations (create, PATCH model,
  // DELETE). Keeping these split is the heart of the fix: a saturated write
  // bucket must never block loading the projects page, and saturated polling
  // must never block a model-select PATCH.
  [/^\/api\/projects/, { read: 'read', mutate: 'write' }],
  [/^\/api\/usage\//, 'read'],
  [/^\/api\/user/, 'read'],
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function classifyApiRequest(method: string, pathname: string): RateLimitBucket {
  const isRead = READ_METHODS.has(method.toUpperCase());
  for (const [re, tier] of RULES) {
    if (re.test(pathname)) {
      return typeof tier === 'string' ? tier : isRead ? tier.read : tier.mutate;
    }
  }
  return 'global';
}
