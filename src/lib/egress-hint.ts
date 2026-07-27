/**
 * Explain free-tier egress blocks in command output.
 *
 * Free-tier projects run on the self-hosted sandbox-host, whose guests can
 * only reach an allowlist (npm, GitHub, Google Fonts, Stripe, Convex,
 * Anthropic, supported OAuth providers). A request to any other host is
 * refused at DNS (egressd won't resolve it) — so the guest just sees "could
 * not resolve host" / a reset, with no hint that this is a policy, not a bug.
 *
 * The network layer can't turn a DNS refusal into a human-readable sentence
 * (curl won't render a DNS answer as prose, and 443 is TLS-passthrough with no
 * cert to speak under). So we detect the block's fingerprint in command output
 * and surface the explanation to whoever ran it — the agent (as a tool-result
 * field) or the user (as a terminal notice).
 */

// Fingerprints of an allowlist block as they appear in stdout/stderr. Chosen
// to be specific to name-resolution / connection-refused failures so we don't
// mislabel ordinary command errors. Deliberately excludes bare timeouts and
// "failed to connect" — those also fire for a not-yet-up local dev server.
const EGRESS_BLOCK_PATTERNS: RegExp[] = [
  /could ?n[o']t resolve host/i,          // curl
  /unable to resolve host/i,               // wget / busybox
  /temporary failure in name resolution/i, // glibc getaddrinfo
  /name or service not known/i,            // glibc
  /nodename nor servname provided/i,       // BSD/macOS-style resolver
  /getaddrinfo\b.*\b(ENOTFOUND|EAI_AGAIN)/i, // node
  /\bENOTFOUND\b/,                          // node fetch/dns
  /\bEAI_AGAIN\b/,
  /curl:\s*\(6\)/i,                         // couldn't resolve host
  /curl:\s*\(35\)/i,                        // TLS connect error (denied SNI reset)
  /curl:\s*\(52\)/i,                        // empty reply from server
  /curl:\s*\(56\)/i,                        // recv failure: connection reset
  /empty reply from server/i,
  /connection reset by peer/i,
  /\bECONNRESET\b/,
];

/** The message shown to the agent/user when an egress block is detected. */
export const EGRESS_BLOCK_MESSAGE =
  "Network request blocked: this is a free-tier Botflow sandbox, which can only " +
  "reach an allowlist of services (npm, GitHub, Google Fonts, Stripe, Convex, " +
  "Anthropic, and supported OAuth providers). The general internet is not " +
  "reachable, so requests to other hosts fail to resolve or connect. This is an " +
  "intentional free-tier restriction, not a bug in the project — upgrading to a " +
  "paid plan removes it.";

/** Whether command output bears the signature of an egress allowlist block. */
export function looksLikeEgressBlock(output: string): boolean {
  if (!output) return false;
  return EGRESS_BLOCK_PATTERNS.some((re) => re.test(output));
}

/**
 * Static system-prompt note ("B") giving the agent standing knowledge of the
 * egress allowlist. It is intentionally CONDITIONAL — the sandboxed-web prompt
 * is shared by paid (Vercel, open internet) and free (sandbox-host, restricted)
 * projects, so this only bites when a real connection failure occurs. Being
 * static, it lives in the cached prompt prefix and never changes per user, so it
 * costs nothing on plan upgrades (unlike injecting the live tier into the
 * prompt). Complements the per-failure tool-result note ("A").
 */
export const NETWORK_EGRESS_NOTE = [
  "## Network access",
  "Some Botflow sandboxes run on a restricted network that can only reach an allowlist of services (npm, GitHub, Google Fonts, Stripe, Convex, Anthropic, and the supported OAuth providers); the open internet is blocked. Free-tier projects use this restricted network; paid projects have unrestricted access.",
  "If a command or the running app fails to resolve or connect to an external host — e.g. \"could not resolve host\", a connection reset, or an empty reply from an outside domain — that is almost certainly this network policy, not a bug in the code. Explain to the user that free-tier sandboxes can't reach the open internet (upgrading to a paid plan removes the limit) instead of retrying the request or trying to engineer around it.",
].join("\n");
