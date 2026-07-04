/**
 * Model + credential mapping for the OpenCode agent backend.
 *
 * Client-safe (no server imports): both the browser-side derivation
 * (AgentPanel) and the server routes call these, and the two MUST agree —
 * the server re-derives the backend per turn to make routing tamper-proof.
 *
 * OpenCode identifies models as `providerID/modelID` pairs from the
 * models.dev catalog. We map our curated ModelIds onto that vocabulary.
 * Provider ids verified against opencode@1.17.13 during the integration
 * spike (see docs/features/opencode-agent.md).
 */
import { MODEL_CONFIGS, type ModelId } from "@/lib/agent/models";

/** Together AI's OpenAI-compatible Kimi K2.7-Code model identifier. Duplicated
 *  from /api/agent (route-local constant) — do not import route code here. */
export const TOGETHER_KIMI_MODEL = "moonshotai/Kimi-K2.7-Code";

export interface OpenCodeCredFlags {
  /** ChatGPT-plan (Codex) OAuth tokens on file. */
  hasCodexOAuth?: boolean;
  hasOpenAIKey?: boolean;
  hasFireworksKey?: boolean;
  hasGoogleKey?: boolean;
  hasTogetherKey?: boolean;
}

export interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

/**
 * Map a Botflow ModelId to OpenCode's { providerID, modelID }. Returns null
 * for models OpenCode never serves (all Anthropic models — Claude-plan OAuth
 * must flow through Claude Code per Anthropic's ToS, and Anthropic BYOK keeps
 * its existing botflow/claude-code routing).
 */
export function resolveOpenCodeModel(
  model: ModelId,
  opts: { useTogetherKimi: boolean },
): OpenCodeModelRef | null {
  const config = MODEL_CONFIGS[model];
  switch (config.provider) {
    case "anthropic":
      return null;
    case "openai":
      return { providerID: "openai", modelID: config.apiModelId };
    case "google":
      return { providerID: "google", modelID: config.apiModelId };
    case "fireworks":
      if (model === "fireworks-kimi-k2p7" && opts.useTogetherKimi) {
        return { providerID: "togetherai", modelID: TOGETHER_KIMI_MODEL };
      }
      return { providerID: "fireworks-ai", modelID: config.apiModelId };
  }
}

/**
 * The single eligibility predicate for the OpenCode backend: does this user
 * hold a PERSONAL credential that can run this model inside their sandbox?
 *
 * Deliberately ignores server-key presence (process.env.FIREWORKS_API_KEY
 * etc.): the client must derive the identical answer and can't see server
 * env — and personal-creds-only routing is the point of the feature. Platform
 * keys never enter the sandbox; those turns stay on /api/agent until the
 * provider proxy exists.
 */
export function hasOpenCodeCredsForModel(
  model: ModelId,
  creds: OpenCodeCredFlags | null | undefined,
  useTogetherKimi: boolean,
): boolean {
  if (!creds) return false;
  const config = MODEL_CONFIGS[model];
  switch (config.provider) {
    case "anthropic":
      return false;
    case "openai":
      return Boolean(creds.hasCodexOAuth || creds.hasOpenAIKey);
    case "google":
      return Boolean(creds.hasGoogleKey);
    case "fireworks":
      if (model === "fireworks-kimi-k2p7" && useTogetherKimi) {
        return Boolean(creds.hasTogetherKey);
      }
      return Boolean(creds.hasFireworksKey);
  }
}
