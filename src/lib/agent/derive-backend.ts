/**
 * Single source of truth for "which agent backend should run THIS model for
 * THIS user on THIS project?"
 *
 * The whole point: the user picks a model; the system picks an agent. No
 * manual chip toggle, no per-project DB state to keep in sync. Both the
 * client (AgentPanel) and the server-side routes call this same function.
 *
 * Only the two in-sandbox agents exist (the server-side Botflow agent is
 * retired — see docs/features/multi-agent-threads.md):
 *
 *   Anthropic model + ANY personal Anthropic credential (OAuth or BYOK)
 *     → Claude Code. OAuth per Anthropic's ToS; BYOK rides the same locked
 *       rail (one Anthropic agent). Provider traffic goes through the LLM
 *       proxy; the sandbox holds only a turn-scoped token.
 *
 *   Anthropic model + no personal creds + paid tier
 *     → OpenCode in PLATFORM mode (the server key is injected by the LLM
 *       proxy; it never enters the sandbox).
 *
 *   Any non-Anthropic model
 *     → OpenCode, unconditionally. Credential MODE (codex-oauth / byok /
 *       platform) is resolved separately; only the tier gate can make a
 *       platform-mode model non-runnable.
 *
 * Non-sandbox projects have no agent at all (runnable: false). In practice
 * they never reach the agent panel: legacy WebContainer projects are migrated
 * on open, and deprecated platforms normalize to sandboxed-web.
 */
import { ANTHROPIC_OAUTH_ENABLED } from "@/lib/feature-flags";
import { isAnthropicModel, type ModelId } from "./models";
import { isSandboxPlatform } from "@/lib/project-platform";
import type { AgentBackend } from "./backend-resolution";
import { openCodeCredModeForModel, type OpenCodeCredFlags } from "./opencode/models";
import { MODEL_TIER_REQUIREMENT, tierMeetsRequirement } from "@/lib/tier-shared";

export type DerivationReason =
  | "oauth_claude_code"
  | "byok_claude_code"
  | "no_credentials"
  | "codex_oauth_opencode"
  | "byok_opencode"
  | "platform_key_opencode"
  | "tier_too_low"
  | "unsupported_platform";

export interface DeriveBackendInput {
  model: ModelId;
  platform: string | null | undefined;
  creds: {
    hasClaudeOAuth: boolean;
    hasAnthropicKey: boolean;
  } & OpenCodeCredFlags;
  /** From /api/usage/credits. Gates platform-mode models by tier. */
  tier?: "free" | "pro" | "max";
  /** From the USE_TOGETHER_KIMI server flag (client learns it via
   *  /api/user-settings). Decides which BYOK key applies to Kimi. */
  useTogetherKimi?: boolean;
}

export interface DeriveBackendOutput {
  /** The backend that should handle a turn with this model. Always returns
   *  *some* value (OpenCode when nothing fits) even when not runnable, so
   *  callers that only need the routing decision don't need to special-case. */
  backend: AgentBackend;
  /** Whether the model is actually runnable on this user+project. When false,
   *  sending is blocked and the chip explains why. */
  runnable: boolean;
  /** Why the derivation picked what it did. Used by the chip popover and for
   *  debugging. Always set. */
  reason: DerivationReason;
}

export function deriveAgentBackend(input: DeriveBackendInput): DeriveBackendOutput {
  const { model, platform, creds, tier, useTogetherKimi } = input;

  if (!platform || !isSandboxPlatform(platform)) {
    return { backend: "opencode", runnable: false, reason: "unsupported_platform" };
  }

  const isPaidTier = tier === "pro" || tier === "max";

  /** Platform-mode tier gate — advisory when tier is unknown (client before
   *  /api/usage/credits loads); the server routes always pass tier and are
   *  the authoritative enforcement point. */
  const tierAllowsPlatform = (): boolean => {
    if (tier === undefined) return true;
    const required = MODEL_TIER_REQUIREMENT[model] ?? "free";
    return tierMeetsRequirement(tier, required);
  };

  if (!isAnthropicModel(model)) {
    const credMode = openCodeCredModeForModel(model, creds, useTogetherKimi === true);
    if (credMode === "codex-oauth") {
      return { backend: "opencode", runnable: true, reason: "codex_oauth_opencode" };
    }
    if (credMode === "byok") {
      return { backend: "opencode", runnable: true, reason: "byok_opencode" };
    }
    // Platform mode — the proxy injects the server key; tier gates access.
    if (!tierAllowsPlatform()) {
      return { backend: "opencode", runnable: false, reason: "tier_too_low" };
    }
    return { backend: "opencode", runnable: true, reason: "platform_key_opencode" };
  }

  // ── Anthropic model from here on ───────────────────────────────────────

  // ANY personal Anthropic credential routes to Claude Code: OAuth by ToS
  // (subscription tokens must flow through the official client), BYOK by
  // design (one Anthropic agent; the key rides the LLM proxy server-side).
  if (ANTHROPIC_OAUTH_ENABLED && creds.hasClaudeOAuth) {
    return { backend: "claude-code", runnable: true, reason: "oauth_claude_code" };
  }
  if (creds.hasAnthropicKey) {
    return { backend: "claude-code", runnable: true, reason: "byok_claude_code" };
  }

  // No personal Anthropic creds: paid tiers run platform-mode on OpenCode
  // (the key never enters the sandbox).
  if (isPaidTier) {
    if (!tierAllowsPlatform()) {
      return { backend: "opencode", runnable: false, reason: "tier_too_low" };
    }
    return { backend: "opencode", runnable: true, reason: "platform_key_opencode" };
  }

  // Free tier with no Anthropic creds → can't run this model.
  return { backend: "opencode", runnable: false, reason: "no_credentials" };
}

/**
 * Human-readable copy for the badge popover. Keyed by `DerivationReason` so
 * the chip can show an explanation of "why am I on this agent?" without the
 * caller having to format strings.
 *
 * `chipTitle` is a compact noun phrase for the inline chip (which sits next to
 * a glyph and a "What's this?" link in a narrow sidebar); `title` is the fuller
 * heading shown in the popover once opened.
 */
export function describeDerivation(reason: DerivationReason): {
  chipTitle: string;
  title: string;
  body: string;
} {
  switch (reason) {
    case "oauth_claude_code":
      return {
        chipTitle: "Your Claude subscription",
        title: "Running on your Claude subscription",
        body:
          "Anthropic requires that subscription tokens flow through their official Claude Code client, never a third party. Your turns run inside a real `claude` process in this project's sandbox, billed to your Pro/Max plan. Provider access goes through Botflow's credential proxy — your tokens never enter the sandbox.",
      };
    case "byok_claude_code":
      return {
        chipTitle: "Your Claude API key",
        title: "Running on Claude Code with your API key",
        body:
          "Anthropic API keys run through the official Claude Code agent inside this project's sandbox. Your key stays on our servers — the sandbox holds only a per-turn proxy token. No platform credits are consumed.",
      };
    case "codex_oauth_opencode":
      return {
        chipTitle: "Your ChatGPT plan",
        title: "Running on OpenCode with your ChatGPT plan",
        body:
          "Your turns run inside the open-source OpenCode agent in this project's sandbox, authenticated with your ChatGPT (Codex) subscription. Usage bills to your OpenAI plan — no platform credits are consumed.",
      };
    case "byok_opencode":
      return {
        chipTitle: "Your API key",
        title: "Running on OpenCode with your API key",
        body:
          "You've added your own key for this model's provider, so turns run inside the open-source OpenCode agent in this project's sandbox. Your key stays on our servers — the sandbox holds only a per-turn proxy token. No platform credits are consumed.",
      };
    case "platform_key_opencode":
      return {
        chipTitle: "Your plan's credits",
        title: "Running on your plan's credits",
        body:
          "Turns run inside the open-source OpenCode agent in this project's sandbox. Provider access goes through Botflow's credential proxy — keys never enter the sandbox — and usage is metered against your plan's included credits.",
      };
    case "tier_too_low":
      return {
        chipTitle: "Higher plan needed",
        title: "This model needs a higher plan",
        body:
          "Running this model on platform credits requires an upgraded plan. Add your own API key for this model's provider in Settings to use it on any plan.",
      };
    case "unsupported_platform":
      return {
        chipTitle: "Not available here",
        title: "Agents need a sandbox project",
        body:
          "Agents run inside the project's sandbox, and this project doesn't have one. Open it again to migrate it, or create a new project.",
      };
    case "no_credentials":
      return {
        chipTitle: "Credentials required",
        title: "Anthropic credentials required",
        body:
          "Sign in with Claude (Pro/Max subscription) or add an Anthropic API key in Settings to use Claude models. Free tier users can use OpenAI, Fireworks, and Google models without setup.",
      };
  }
}
