/**
 * Per-turn proxy tokens for Anthropic inference traffic. Mirrors
 * tool-token.ts, applied to the credential seam instead of tool callbacks
 * (see docs/features/anthropic-proxy-token-protection-plan.md).
 *
 * Flow:
 *   1. /api/agent/claude-code (flag-gated) mints a token + stores the binding
 *      in Redis, writes the TOKEN — not the real credential — into the
 *      sandbox's ~/.claude/.credentials.json (or ANTHROPIC_API_KEY), and sets
 *      ANTHROPIC_BASE_URL to our proxy route.
 *   2. The Claude Code CLI/SDK inside the sandbox sends the token to
 *      /api/internal/anthropic-proxy/[...path] as its auth material.
 *   3. The proxy resolves the binding, injects the user's real credential
 *      server-side, forwards to api.anthropic.com, and streams back.
 *   4. The turn's `finally` revokes the token; the TTL catches abandoned ones.
 *
 * The real OAuth access/refresh token or BYOK key never enters the sandbox.
 * With Redis unconfigured (local dev no-op stub) resolution always fails —
 * the proxy fails closed.
 */
import { randomBytes } from "node:crypto";
import { redis } from "@/lib/redis";

const KEY_PREFIX = "claude-code:anthropic-proxy-token:";
// Matches tool-token TTL: generous enough to cover a long turn; revoked
// eagerly at turn end. §11.3 of the plan revisits this before Phase 2.
const TTL_SECONDS = 60 * 30;

/** Distinctive prefix: greppable in logs, never mistakable for a real key. */
const TOKEN_PREFIX = "bfap_";

export type AnthropicProxyCredentialMode = "oauth" | "byok";

export interface AnthropicProxyBinding {
  /** Acting user — whose credential the proxy injects (billing identity under
   *  sharing is derived server-side from this + the project, never from the
   *  sandbox). */
  userId: string;
  projectId: string;
  mode: AnthropicProxyCredentialMode;
}

export async function mintAnthropicProxyToken(
  binding: AnthropicProxyBinding,
): Promise<string> {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  await redis.setex(`${KEY_PREFIX}${token}`, TTL_SECONDS, JSON.stringify(binding));
  return token;
}

export async function resolveAnthropicProxyToken(
  token: string,
): Promise<AnthropicProxyBinding | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const raw = await redis.get<string | AnthropicProxyBinding>(`${KEY_PREFIX}${token}`);
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw) as AnthropicProxyBinding;
  } catch {
    return null;
  }
}

export async function revokeAnthropicProxyToken(token: string): Promise<void> {
  await redis.del(`${KEY_PREFIX}${token}`);
}

/**
 * Phase 0 spike gating: the proxy path activates only when the env flag is
 * set AND the project is explicitly allowlisted. Flag off (the default)
 * leaves the spawn path byte-identical to today.
 */
export function shouldProxyAnthropic(projectId: string): boolean {
  const enabled =
    process.env.ANTHROPIC_PROXY_ENABLED === "true" ||
    process.env.ANTHROPIC_PROXY_ENABLED === "1";
  if (!enabled) return false;
  const allowlist = (process.env.ANTHROPIC_PROXY_PROJECT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowlist.includes(projectId);
}

/**
 * Origin the sandbox should send proxied traffic to. Defaults to the origin
 * that served the turn request (same value the bridge already uses for tool
 * callbacks via BOTFLOW_API_BASE); overridable for spike measurements from
 * a different region/deployment.
 */
export function anthropicProxyOrigin(requestOrigin: string): string {
  return process.env.ANTHROPIC_PROXY_ORIGIN ?? requestOrigin;
}
