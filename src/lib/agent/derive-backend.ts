/**
 * Single source of truth for "which agent backend should run THIS model for
 * THIS user on THIS project?"
 *
 * The whole point: the user picks a model; the system picks an agent. No
 * manual chip toggle, no per-project DB state to keep in sync. Both the
 * client (AgentPanel) and the server-side routes call this same function.
 *
 * The decision tree is honest about the constraints:
 *
 *   Non-Anthropic model
 *     → Botflow (Claude Code only runs Anthropic models).
 *
 *   Anthropic model + user has Claude OAuth
 *     → Claude Code (ToS forces this — subscription tokens MUST flow through
 *        the official Claude Code client; we can't use them as API keys).
 *     If platform isn't a sandbox AND user has no other Anthropic path:
 *       → NOT runnable. The UI should hide the model from the picker.
 *
 *   Anthropic model + user has API key (BYOK), no OAuth
 *     → Default Botflow. If user's `preferredAnthropicBackend === 'claude-code'`
 *       (set in Connections), route through Claude Code instead (when the
 *       platform allows it).
 *
 *   Anthropic model + no user creds, paid tier (Pro/Max)
 *     → Botflow with platform key. Claude Code can never use the platform key
 *       (we won't put our key in the user's sandbox env).
 *
 *   Anthropic model + no user creds, free tier
 *     → NOT runnable. Picker hides the model.
 */
import {
  ANTHROPIC_OAUTH_ENABLED,
  CLAUDE_CODE_ENABLED,
  OPENCODE_BACKEND_ENABLED,
} from "@/lib/feature-flags";
import { isAnthropicModel, MODEL_CONFIGS, type ModelId } from "./models";
import { isSandboxPlatform } from "@/lib/project-platform";
import type { AgentBackend } from "./backend-resolution";
import { hasOpenCodeCredsForModel, type OpenCodeCredFlags } from "./opencode/models";

export type DerivationReason =
  | "non_anthropic_model"
  | "oauth_claude_code"
  | "oauth_no_path"
  | "byok_botflow"
  | "byok_preference_claude_code"
  | "platform_key_botflow"
  | "no_credentials"
  | "codex_oauth_opencode"
  | "byok_opencode";

export interface DeriveBackendInput {
  model: ModelId;
  platform: string | null | undefined;
  creds: {
    hasClaudeOAuth: boolean;
    hasAnthropicKey: boolean;
  } & OpenCodeCredFlags;
  /** From `creds.preferredAnthropicBackend`. Honored only when the user
   *  genuinely has a choice (BYOK without OAuth). */
  preferredAnthropicBackend?: "botflow" | "claude-code" | null;
  /** From /api/usage/credits. Pro/Max can run Anthropic models via the
   *  platform key when the user has no personal creds. */
  tier?: "free" | "pro" | "max";
  /** From the USE_TOGETHER_KIMI server flag (client learns it via
   *  /api/user-settings). Decides which BYOK key makes Kimi opencode-eligible. */
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
  const { model, platform, creds, preferredAnthropicBackend, tier, useTogetherKimi } = input;
  const isAnthropic = isAnthropicModel(model);
  const isSandbox = Boolean(platform && isSandboxPlatform(platform));
  const isPaidTier = tier === "pro" || tier === "max";
  const oauthAvailable = CLAUDE_CODE_ENABLED && ANTHROPIC_OAUTH_ENABLED && creds.hasClaudeOAuth;
  const claudeCodePossible = CLAUDE_CODE_ENABLED && isSandbox;

  // Non-Anthropic models: OpenCode when the flag is on, the project is a
  // sandbox, and the user holds a PERSONAL credential for the model's provider
  // (Codex/ChatGPT-plan OAuth or a BYOK key) — the drop-in replacement for the
  // Botflow agent. Otherwise the Botflow engine serves the turn (platform keys
  // stay on our server; the sandbox env is unsafe for them).
  if (!isAnthropic) {
    if (
      OPENCODE_BACKEND_ENABLED &&
      isSandbox &&
      hasOpenCodeCredsForModel(model, creds, useTogetherKimi === true)
    ) {
      const reason: DerivationReason =
        MODEL_CONFIGS[model].provider === "openai" && creds.hasCodexOAuth
          ? "codex_oauth_opencode"
          : "byok_opencode";
      return { backend: "opencode", runnable: true, reason };
    }
    return { backend: "botflow", runnable: true, reason: "non_anthropic_model" };
  }

  // ── Anthropic model from here on ───────────────────────────────────────

  // OAuth wins by ToS — Anthropic subscription tokens must flow through the
  // official Claude Code client. We can never use them as bare API keys.
  if (oauthAvailable) {
    if (claudeCodePossible) {
      return { backend: "claude-code", runnable: true, reason: "oauth_claude_code" };
    }
    // OAuth-only on a non-sandbox project (WebContainer): Claude Code can't
    // run here. We can fall back to BYOK or platform key for Botflow if
    // those exist; otherwise the model is not runnable for this project.
    if (creds.hasAnthropicKey) {
      return { backend: "botflow", runnable: true, reason: "byok_botflow" };
    }
    if (isPaidTier) {
      return { backend: "botflow", runnable: true, reason: "platform_key_botflow" };
    }
    return { backend: "botflow", runnable: false, reason: "oauth_no_path" };
  }

  // BYOK with no OAuth: user can choose either backend on a sandbox project.
  if (creds.hasAnthropicKey) {
    if (
      preferredAnthropicBackend === "claude-code" &&
      claudeCodePossible
    ) {
      return {
        backend: "claude-code",
        runnable: true,
        reason: "byok_preference_claude_code",
      };
    }
    return { backend: "botflow", runnable: true, reason: "byok_botflow" };
  }

  // No personal Anthropic creds. Paid tiers can run via the platform key
  // through Botflow (we never expose the platform key to the sandbox).
  if (isPaidTier) {
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
          "Anthropic requires that subscription tokens flow through their official Claude Code client, never a third party. Your turns run inside a real `claude` process in this project's sandbox, billed to your Pro/Max plan.",
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
          "You've added your own key for this model's provider, so turns run inside the open-source OpenCode agent in this project's sandbox using that key. No platform credits are consumed.",
      };
    case "byok_preference_claude_code":
      return {
        title: "Running on Claude Code (your API key)",
        body:
          "You selected Claude Code as your preferred Anthropic backend in Settings. Your API key is used; the official Claude Code agent runs inside this project's sandbox.",
      };
    case "byok_botflow":
      // Under the OpenCode flag, "Botflow" is retired as a presented agent
      // identity — the same engine serves the turn, described neutrally.
      return OPENCODE_BACKEND_ENABLED
        ? {
            title: "Running with your Anthropic API key",
            body:
              "Claude models run through the built-in server-side engine using your API key. You can switch the default to Claude Code from Settings → Connections.",
          }
        : {
            title: "Running on Botflow with your Anthropic API key",
            body:
              "Botflow's agent runs Claude models using your API key. You can switch the default to Claude Code from Settings → Connections.",
          };
    case "platform_key_botflow":
      return OPENCODE_BACKEND_ENABLED
        ? {
            title: "Running on your plan's credits",
            body:
              "Your subscription covers Anthropic usage through the built-in server-side engine, so these turns consume platform credits.",
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
              "This model runs through the built-in server-side engine using your plan's included credits. Add your own API key for this provider (or connect ChatGPT) in Settings to run it with the OpenCode agent inside your project's sandbox instead.",
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
