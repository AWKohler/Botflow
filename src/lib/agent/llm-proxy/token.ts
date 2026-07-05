/**
 * Per-turn proxy tokens for ALL in-sandbox LLM inference traffic — the
 * generalization of the Phase-0 Anthropic spike (originally
 * claude-code/anthropic-proxy-token.ts on feat/project-sharing).
 *
 * Flow:
 *   1. The agent routes (/api/agent/claude-code and /api/agent/opencode) mint
 *      a token + store the binding in Redis, write the TOKEN — never a real
 *      credential — into the sandbox's credential surface (Claude Code's
 *      ~/.claude/.credentials.json / ANTHROPIC_API_KEY, or OpenCode's
 *      auth.json), and point the agent's base URL at
 *      /api/internal/llm-proxy/<provider>.
 *   2. The agent inside the sandbox sends the token as its auth material.
 *   3. The proxy resolves the binding, injects the real credential
 *      server-side (platform env key, the user's BYOK key, or a freshly
 *      refreshed OAuth access token), forwards upstream, and streams back —
 *      teeing the response for authoritative usage metering.
 *   4. The NEXT turn's spawn (or the stop route) revokes the token via the
 *      turn registry — NOT the streaming route's `finally`: bridges run
 *      detached and legitimately outlive the route (reattach contract). The
 *      sliding TTL catches abandoned tokens.
 *
 * No real credential of any kind enters the sandbox (sole documented
 * exception: Codex/ChatGPT-plan OAuth — see docs/features/llm-proxy.md).
 * With Redis unconfigured (local dev no-op stub) resolution always fails —
 * the proxy fails closed.
 */
import { randomBytes } from "node:crypto";
import { redis } from "@/lib/redis";
import type { ModelId } from "@/lib/agent/models";
import type { LlmProxyProvider } from "./providers";

const KEY_PREFIX = "llm-proxy:token:";
// Sliding window: touched on every proxied request, so a long detached turn
// keeps working indefinitely while abandoned tokens die 30 minutes after
// their last use.
const TTL_SECONDS = 60 * 30;

/** Distinctive prefix: greppable in logs, never mistakable for a real key. */
const TOKEN_PREFIX = "bfap_";

export type LlmProxyCredMode = "platform" | "byok" | "oauth";

export interface LlmProxyBinding {
  /** Acting user — whose credential/budget the proxy uses (billing identity
   *  under sharing derives server-side from this + the project, never from
   *  the sandbox). */
  userId: string;
  projectId: string;
  /** The turn that minted this token (log correlation + registry cleanup). */
  turnId: string;
  /** The only provider this token may call — a fireworks token can't hit the
   *  anthropic proxy. */
  provider: LlmProxyProvider;
  credMode: LlmProxyCredMode;
  /** OUR pricing ModelId for the turn's selected model (billing lookup). */
  modelId: ModelId;
  /**
   * Provider-native model ids the sandbox may request. Enforced HARD in
   * platform mode (every request is priced, so every model must be known);
   * ADVISORY (log-only) in byok/oauth mode — Claude Code legitimately calls
   * Haiku-class background models on the user's own credential.
   */
  modelAllowlist: string[];
}

export async function mintLlmProxyToken(binding: LlmProxyBinding): Promise<string> {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  await redis.setex(`${KEY_PREFIX}${token}`, TTL_SECONDS, JSON.stringify(binding));
  return token;
}

export async function resolveLlmProxyToken(
  token: string,
): Promise<LlmProxyBinding | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const raw = await redis.get<string | LlmProxyBinding>(`${KEY_PREFIX}${token}`);
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw) as LlmProxyBinding;
  } catch {
    return null;
  }
}

/** Slide the TTL window — called (fire-and-forget) on every proxied request. */
export async function touchLlmProxyToken(token: string): Promise<void> {
  await redis.expire(`${KEY_PREFIX}${token}`, TTL_SECONDS);
}

export async function revokeLlmProxyToken(token: string): Promise<void> {
  await redis.del(`${KEY_PREFIX}${token}`);
}

/**
 * Origin the sandbox should send proxied traffic to. Defaults to the origin
 * that served the turn request (same value the bridges already use for tool
 * callbacks via BOTFLOW_API_BASE). LLM_PROXY_ORIGIN overrides — also the
 * escape hatch for preview deployments if the protection-bypass header can't
 * ride a given agent's request path (tokens are origin-agnostic; Redis is
 * shared across deployments).
 */
export function llmProxyOrigin(requestOrigin: string): string {
  return process.env.LLM_PROXY_ORIGIN ?? requestOrigin;
}
