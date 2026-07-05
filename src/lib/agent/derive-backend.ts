/**
 * Single source of truth for "which agent backend should run THIS model for
 * THIS user on THIS project?"
 *
 * The whole point: the user picks a model; the system picks an agent. No
 * manual chip toggle, no per-project DB state to keep in sync. Both the
 * client (AgentPanel) and the server-side routes call this same function.
 *
 * The decision tree with the LLM proxy in place (flag ON, sandbox platform):
 *
 *   Anthropic model + ANY personal Anthropic credential (OAuth or BYOK)
 *     → Claude Code. OAuth per Anthropic's ToS; BYOK rides the same locked
 *       rail (no more preference toggle — one Anthropic agent).
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
 * Flag OFF (or non-sandbox platform): the legacy tree — Botflow via
 * /api/agent, Claude Code for Anthropic OAuth. The legacy engine also
 * remains the 412-fallback target while the proxy bakes.
 */
import {
  ANTHROPIC_OAUTH_ENABLED,
  CLAUDE_CODE_ENABLED,
  OPENCODE_BACKEND_ENABLED,
} from "@/lib/feature-flags";
import { isAnthropicModel, type ModelId } from "./models";
import { isSandboxPlatform } from "@/lib/project-platform";
import type { AgentBackend } from "./backend-resolution";
import { openCodeCredModeForModel, type OpenCodeCredFlags } from "./opencode/models";
import { MODEL_TIER_REQUIREMENT, tierMeetsRequirement } from "@/lib/tier-shared";

export type DerivationReason =
  | "non_anthropic_model"
  | "oauth_claude_code"
  | "byok_claude_code"
  | "oauth_no_path"
  | "byok_botflow"
  | "platform_key_botflow"
  | "no_credentials"
  | "codex_oauth_opencode"
  | "byok_opencode"
  | "platform_key_opencode"
  | "tier_too_low";

export interface DeriveBackendInput {
  model: ModelId;
  platform: string | null | undefined;
  creds: {
    hasClaudeOAuth: boolean;
    hasAnthropicKey: boolean;
  } & OpenCodeCredFlags;
  /** @deprecated Retired — Anthropic BYOK is locked to Claude Code like
   *  OAuth. Ignored; the field survives one release so stale callers
   *  compile. */
  preferredAnthropicBackend?: "botflow" | "claude-code" | null;
  /** From /api/usage/credits. Gates platform-mode models by tier. */
  tier?: "free" | "pro" | "max";
  /** From the USE_TOGETHER_KIMI server flag (client learns it via
   *  /api/user-settings). Decides which BYOK key applies to Kimi. */
  useTogetherKimi?: boolean;
}

export interface DeriveBackendOutput {
  /** The backend that should handle a turn with this model. Always returns
   *  *some* value (defaults to 'botflow') even when not runnable, so callers
   *  that only need the routing decision don't need to special-case. */
  backend: AgentBackend;
  /** Whether the model is actually runnable on this user+project. When false,
   *  the model picker should hide it (no path exists to run it). */
  runnable: boolean;
  /** Why the derivation picked what it did. Used by the chip popover and for
   *  debugging. Always set. */
  reason: DerivationReason;
}

export function deriveAgentBackend(input: DeriveBackendInput): DeriveBackendOutput {
  const { model, platform, creds, tier, useTogetherKimi } = input;
  const isAnthropic = isAnthropicModel(model);
  const isSandbox = Boolean(platform && isSandboxPlatform(platform));
  const isPaidTier = tier === "pro" || tier === "max";
  const oauthAvailable = CLAUDE_CODE_ENABLED && ANTHROPIC_OAUTH_ENABLED && creds.hasClaudeOAuth;
  const claudeCodePossible = CLAUDE_CODE_ENABLED && isSandbox;
  const openCodePossible = OPENCODE_BACKEND_ENABLED && isSandbox;

  /** Platform-mode tier gate — advisory when tier is unknown (client before
   *  /api/usage/credits loads); the server routes always pass tier and are
   *  the authoritative enforcement point. */
  const tierAllowsPlatform = (): boolean => {
    if (tier === undefined) return true;
    const required = MODEL_TIER_REQUIREMENT[model] ?? "free";
    return tierMeetsRequirement(tier, required);
  };

  if (!isAnthropic) {
    if (openCodePossible) {
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
    return { backend: "botflow", runnable: true, reason: "non_anthropic_model" };
  }

  // ── Anthropic model from here on ───────────────────────────────────────

  // ANY personal Anthropic credential routes to Claude Code: OAuth by ToS
  // (subscription tokens must flow through the official client), BYOK by
  // design (one Anthropic agent; the key rides the LLM proxy server-side).
  if (oauthAvailable) {
    if (claudeCodePossible) {
      return { backend: "claude-code", runnable: true, reason: "oauth_claude_code" };
    }
    // OAuth-only on a non-sandbox project (WebContainer): Claude Code can't
    // run here. Fall back to BYOK or platform key through the legacy engine.
    if (creds.hasAnthropicKey) {
      return { backend: "botflow", runnable: true, reason: "byok_botflow" };
    }
    if (isPaidTier) {
      return { backend: "botflow", runnable: true, reason: "platform_key_botflow" };
    }
    return { backend: "botflow", runnable: false, reason: "oauth_no_path" };
  }

  if (creds.hasAnthropicKey) {
    // The BYOK→Claude-Code lock rides the OpenCode flag so the kill-switch
    // state (flag off) stays legacy-identical: BYOK then serves through the
    // legacy engine as before.
    if (OPENCODE_BACKEND_ENABLED && claudeCodePossible) {
      return { backend: "claude-code", runnable: true, reason: "byok_claude_code" };
    }
    return { backend: "botflow", runnable: true, reason: "byok_botflow" };
  }

  // No personal Anthropic creds: paid tiers run platform-mode. With the
  // proxy that means OpenCode (the key never enters the sandbox); without
  // it, the legacy engine.
  if (isPaidTier) {
    if (openCodePossible) {
      if (!tierAllowsPlatform()) {
        return { backend: "opencode", runnable: false, reason: "tier_too_low" };
      }
      return { backend: "opencode", runnable: true, reason: "platform_key_opencode" };
    }
    return { backend: "botflow", runnable: true, reason: "platform_key_botflow" };
  }

  // Free tier with no Anthropic creds → can't run this model.
  return { backend: "botflow", runnable: false, reason: "no_credentials" };
}

/**
 * Human-readable copy for the badge popover. Keyed by `DerivationReason` so
 * the chip can show an explanation of "why am I on this agent?" without the
 * caller having to format strings.
 */
export function describeDerivation(reason: DerivationReason): {
  title: string;
  body: string;
} {
  switch (reason) {
    case "oauth_claude_code":
      return {
        title: "Running on your Claude subscription",
        body:
          "Anthropic requires that subscription tokens flow through their official Claude Code client, never a third party. Your turns run inside a real `claude` process in this project's sandbox, billed to your Pro/Max plan. Provider access goes through Botflow's credential proxy — your tokens never enter the sandbox.",
      };
    case "byok_claude_code":
      return {
        title: "Running on Claude Code with your API key",
        body:
          "Anthropic API keys run through the official Claude Code agent inside this project's sandbox. Your key stays on our servers — the sandbox holds only a per-turn proxy token. No platform credits are consumed.",
      };
    case "codex_oauth_opencode":
      return {
        title: "Running on OpenCode with your ChatGPT plan",
        body:
          "Your turns run inside the open-source OpenCode agent in this project's sandbox, authenticated with your ChatGPT (Codex) subscription. Usage bills to your OpenAI plan — no platform credits are consumed.",
      };
    case "byok_opencode":
      return {
        title: "Running on OpenCode with your API key",
        body:
          "You've added your own key for this model's provider, so turns run inside the open-source OpenCode agent in this project's sandbox. Your key stays on our servers — the sandbox holds only a per-turn proxy token. No platform credits are consumed.",
      };
    case "platform_key_opencode":
      return {
        title: "Running on your plan's credits",
        body:
          "Turns run inside the open-source OpenCode agent in this project's sandbox. Provider access goes through Botflow's credential proxy — keys never enter the sandbox — and usage is metered against your plan's included credits.",
      };
    case "tier_too_low":
      return {
        title: "This model needs a higher plan",
        body:
          "Running this model on platform credits requires an upgraded plan. Add your own API key for this model's provider in Settings to use it on any plan.",
      };
    case "byok_botflow":
      return {
        title: "Running with your Anthropic API key",
        body:
          "Claude models on this project run through the built-in server-side engine using your API key. Sandbox projects run them through the official Claude Code agent instead.",
      };
    case "platform_key_botflow":
      return OPENCODE_BACKEND_ENABLED
        ? {
            title: "Running on your plan's credits",
            body:
              "Your subscription covers this model's usage through the built-in server-side engine, so these turns consume platform credits.",
          }
        : {
            title: "Running on Botflow with your Pro plan",
            body:
              "Your subscription covers Anthropic usage through Botflow's agent. Turns run on our servers using Botflow's tools.",
          };
    case "non_anthropic_model":
      return OPENCODE_BACKEND_ENABLED
        ? {
            title: "Running on your plan's credits",
            body:
              "This model runs through the built-in server-side engine using your plan's included credits.",
          }
        : {
            title: "Running on Botflow",
            body:
              "Non-Anthropic models always use Botflow's agent. Claude Code only runs Anthropic models.",
          };
    case "oauth_no_path":
      return {
        title: "Can't run Anthropic models on this project",
        body:
          "Your Claude subscription requires a sandbox project to run Claude Code, but this project is a WebContainer project. Create a new sandbox project to use Claude models with your subscription, or add an Anthropic API key in Settings.",
      };
    case "no_credentials":
      return {
        title: "Anthropic credentials required",
        body:
          "Sign in with Claude (Pro/Max subscription) or add an Anthropic API key in Settings to use Claude models. Free tier users can use OpenAI, Fireworks, and Google models without setup.",
      };
  }
}
