/**
 * Shared plumbing for "the agent opened a modal and is waiting on the user"
 * flows (OAuth provider credentials, env-var entry, Stripe Connect).
 *
 * Two jobs:
 *
 * 1. WAIT MARKERS — a short-TTL Redis key the agent-side poller refreshes on
 *    every poll. When the user finally submits the modal, the completion
 *    route checks the marker: if the agent is still actively waiting, the
 *    in-flight tool call will deliver the result and nothing else is needed;
 *    if not (the agent gave up and moved on), the workspace fires a
 *    system-note so the agent learns the credentials arrived.
 *
 * 2. HONEST STATUS SEMANTICS — canonical give-up wording. "The user hasn't
 *    finished yet" and "the user explicitly dismissed the modal" demand
 *    opposite agent behavior (check back later vs. don't nag), so give-up
 *    messages must never claim dismissal. Historically the pollers marked
 *    rows dismissed on timeout, which made the agent tell users "you
 *    dismissed the modal" while they were still pasting credentials.
 */
import { redis } from "@/lib/redis";

export type ModalWaitKind = "oauth-provider" | "env-var" | "stripe-connect";

/** How long a single marker refresh keeps the "agent is waiting" signal
 *  alive. Pollers refresh every few seconds, so 60s comfortably covers the
 *  gap between polls while expiring quickly once the agent stops. */
const WAIT_MARKER_TTL_SECONDS = 60;

/** How long the agent keeps waiting for the user to finish a modal, per kind.
 *  These are wall-clock ceilings enforced server-side from the request row's
 *  createdAt — the bridge just keeps polling until it gets a terminal
 *  response. OAuth console setup (create app, configure redirect URIs, copy
 *  credentials) routinely takes 10+ minutes; 20 minutes covers nearly
 *  everyone without letting an abandoned modal pin a turn open forever. */
export const MODAL_WAIT_CEILING_MS: Record<ModalWaitKind, number> = {
  "oauth-provider": 20 * 60 * 1000,
  "env-var": 15 * 60 * 1000,
  "stripe-connect": 20 * 60 * 1000,
};

/** Pending modal rows older than this are lazily dismissed by the status
 *  routes the workspace polls. Now that agent-side pollers no longer dismiss
 *  rows on timeout, this is the backstop that keeps a long-abandoned modal
 *  from haunting the workspace forever. Longer than every wait ceiling so it
 *  can never yank a modal the agent is still waiting on. */
export const MODAL_STALE_AFTER_MS = 60 * 60 * 1000;

function markerKey(kind: ModalWaitKind, requestId: string): string {
  return `agent-wait:${kind}:${requestId}`;
}

/** Refresh the "agent is actively waiting on this request" marker. Called by
 *  the agent-side pollers on each poll tick. Fire-and-forget safe. */
export async function markAgentWaiting(
  kind: ModalWaitKind,
  requestId: string,
): Promise<void> {
  try {
    await redis.setex(markerKey(kind, requestId), WAIT_MARKER_TTL_SECONDS, "1");
  } catch {
    // Marker is best-effort — worst case the workspace sends a redundant
    // system-note that the agent answers with "already wired up".
  }
}

/** Drop the marker immediately (agent gave up waiting). Ensures a submit
 *  seconds later correctly notifies instead of assuming an active waiter. */
export async function clearAgentWaiting(
  kind: ModalWaitKind,
  requestId: string,
): Promise<void> {
  try {
    await redis.del(markerKey(kind, requestId));
  } catch {
    /* best-effort */
  }
}

/** Is an agent-side poller actively waiting on this request right now? */
export async function isAgentWaiting(
  kind: ModalWaitKind,
  requestId: string,
): Promise<boolean> {
  try {
    const v = await redis.get(markerKey(kind, requestId));
    return v !== null && v !== undefined;
  } catch {
    return false;
  }
}

/** DELIVERY SEMANTICS: at-least-once, by design. A completion must reach the
 *  agent through in-band tool results OR a workspace system-note — losing one
 *  entirely (the pre-2026-07 failure mode) strands the whole setup flow,
 *  while a rare duplicate is harmless: the note tells the agent to re-call
 *  the tool, and the waitable tools are idempotent. The two helpers below
 *  suppress the SYSTEMATIC duplicate paths; sub-second races may still
 *  double-deliver and that is the accepted trade.
 */

const DELIVERED_TTL_SECONDS = 60 * 60;

function deliveredKey(kind: ModalWaitKind, requestId: string): string {
  return `agent-delivered:${kind}:${requestId}`;
}

/** Record that a terminal result for this request reached the agent IN-BAND
 *  (a poll return or a finalized stopWaiting reply), so late-completion
 *  notification paths (e.g. the Stripe connect-request poll) don't
 *  re-announce it after the wait marker expires. Fire-and-forget safe. */
export async function markResultDelivered(
  kind: ModalWaitKind,
  requestId: string,
): Promise<void> {
  try {
    await redis.setex(deliveredKey(kind, requestId), DELIVERED_TTL_SECONDS, "1");
  } catch {
    /* best-effort — worst case a redundant system-note fires */
  }
}

/** Did an in-band delivery already happen for this request? */
export async function wasResultDelivered(
  kind: ModalWaitKind,
  requestId: string,
): Promise<boolean> {
  try {
    const v = await redis.get(deliveredKey(kind, requestId));
    return v !== null && v !== undefined;
  } catch {
    return false;
  }
}

/** Claim the (single) right to serve a late-completion system-note for this
 *  request. NX so reloads, remounts, and concurrent workspace tabs can't
 *  each fire the same note. Returns true exactly once per request (per TTL).
 *  In no-Redis dev the stub always returns OK — notes may duplicate there,
 *  which is the documented degraded behavior. */
export async function claimCompletionNote(
  kind: ModalWaitKind,
  requestId: string,
): Promise<boolean> {
  try {
    const res = await redis.set(`agent-note-served:${kind}:${requestId}`, "1", {
      nx: true,
      ex: DELIVERED_TTL_SECONDS,
    });
    return res === "OK";
  } catch {
    // If Redis is down we'd rather risk a duplicate note than lose the only
    // delivery path.
    return true;
  }
}

/** Canonical give-up message when the wait ceiling passes with the modal
 *  still pending. The request row is left pending (modal stays open) and the
 *  wording forbids the "user dismissed it" misreport. */
export function stillPendingGiveUpMessage(subject: string): string {
  return (
    `The user has NOT finished the ${subject} modal yet — it is still open in their workspace, and nothing was dismissed or declined. ` +
    `Stop waiting and continue with other work. Do NOT say the user dismissed, declined, or cancelled it — they may still be completing it. ` +
    `When they submit, you'll receive a system note; you can also re-check by calling the same tool again later.`
  );
}
