/**
 * Model configurations — token limits, provider mappings, display names.
 */

export type ModelId =
  | "gpt-5.3-codex"
  | "gpt-5.4"
  | "gpt-5.5"
  | "claude-sonnet-4-6"
  | "claude-opus-4-8"
  | "claude-fable-5"
  | "gemini-3.1-pro-preview"
  | "fireworks-minimax-m3"
  | "fireworks-glm-5p1"
  | "fireworks-kimi-k2p6";

export type Provider = "openai" | "anthropic" | "google" | "fireworks";

export interface ModelConfig {
  id: ModelId;
  provider: Provider;
  /** Provider-specific model identifier for API calls */
  apiModelId: string;
  /** Display name for the UI */
  displayName: string;
  /** Max context window in tokens */
  maxContextTokens: number;
  /** Warn at this percentage of max context */
  warnThreshold: number;
  /** Critical at this percentage of max context */
  criticalThreshold: number;
  /** Whether this model supports image/file inputs */
  supportsImages: boolean;
  /**
   * When true, the model is shown in the UI but cannot be selected or used.
   * Enforced both in the selector (grayed/non-selectable) and server-side
   * (request dispatch rejects it for ALL auth paths, including BYOK/OAuth).
   */
  disabled?: boolean;
  /** Short reason surfaced to the user when a disabled model is encountered. */
  disabledReason?: string;
}

export const MODEL_CONFIGS: Record<ModelId, ModelConfig> = {
  "gpt-5.3-codex": {
    id: "gpt-5.3-codex",
    provider: "openai",
    apiModelId: "gpt-5.3-codex",
    displayName: "GPT-5.3",
    maxContextTokens: 400_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    provider: "openai",
    apiModelId: "gpt-5.4",
    displayName: "GPT-5.4",
    maxContextTokens: 1_000_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "gpt-5.5": {
    id: "gpt-5.5",
    provider: "openai",
    apiModelId: "gpt-5.5",
    displayName: "GPT-5.5",
    maxContextTokens: 1_000_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    apiModelId: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    maxContextTokens: 200_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    provider: "anthropic",
    apiModelId: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    maxContextTokens: 200_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "claude-fable-5": {
    id: "claude-fable-5",
    provider: "anthropic",
    apiModelId: "claude-fable-5",
    displayName: "Claude Fable 5 (Mythos)",
    maxContextTokens: 1_000_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    // Temporarily rescinded by Anthropic — visible in the UI but unusable for
    // every user (free/pro/max, BYOK, and OAuth) until re-enabled here.
    disabled: true,
    disabledReason: "Temporarily unavailable — rescinded by Anthropic.",
  },
  "gemini-3.1-pro-preview": {
    id: "gemini-3.1-pro-preview",
    provider: "google",
    apiModelId: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro",
    maxContextTokens: 1_000_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
  "fireworks-minimax-m3": {
    id: "fireworks-minimax-m3",
    provider: "fireworks",
    apiModelId: "accounts/fireworks/models/minimax-m3",
    displayName: "MiniMax-M3",
    maxContextTokens: 196_600,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: false,
  },
  // "fireworks-glm-5": {
  //   id: "fireworks-glm-5",
  //   provider: "fireworks",
  //   apiModelId: "accounts/fireworks/models/glm-5",
  //   displayName: "GLM-5",
  //   maxContextTokens: 202_800,
  //   warnThreshold: 0.7,
  //   criticalThreshold: 0.9,
  //   supportsImages: false,
  // },
  "fireworks-glm-5p1": {
    id: "fireworks-glm-5p1",
    provider: "fireworks",
    apiModelId: "accounts/fireworks/models/glm-5p1",
    displayName: "GLM-5.1",
    maxContextTokens: 202_800,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: false,
  },
  "fireworks-kimi-k2p6": {
    id: "fireworks-kimi-k2p6",
    provider: "fireworks",
    apiModelId: "accounts/fireworks/models/kimi-k2p6",
    displayName: "Kimi K2.6",
    maxContextTokens: 262_100,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
  },
};

/** Resolve stored model value — maps renames; unknown/removed models fall back to default */
export function resolveModelId(stored: string | null | undefined): ModelId {
  // Dot-notation renames (same model, new ID format)
  if (stored === "claude-sonnet-4.5" || stored === "claude-sonnet-4.6") return "claude-sonnet-4-6";
  if (stored === "claude-opus-4.5" || stored === "claude-opus-4.6" || stored === "claude-opus-4.7" || stored === "claude-opus-4-7" || stored === "claude-opus-4-1") return "claude-opus-4-8";
  if (stored === "gpt-4.1" || stored === "gpt-5.2") return "gpt-5.3-codex";
  if (stored === "fireworks-glm-5") return "fireworks-glm-5p1";
  if (stored === "fireworks-minimax-m2p7" || stored === "fireworks-minimax-m2p5") return "fireworks-minimax-m3";
  // Still-valid model: pass through
  if (stored && stored in MODEL_CONFIGS) return stored as ModelId;
  // Unknown or removed model: silently use default
  return "fireworks-kimi-k2p6";
}

/** Check if a model supports image/file inputs */
export function modelSupportsImages(model: ModelId): boolean {
  return MODEL_CONFIGS[model]?.supportsImages ?? false;
}

/** Fallback message when a model is disabled but no explicit reason is set. */
export const DEFAULT_DISABLED_MODEL_REASON = "This model is temporarily unavailable.";

/**
 * Whether a model is currently disabled (single source of truth: the `disabled`
 * flag on its config). Both the selector UI and the server-side request guard
 * derive from this so the two can never drift apart.
 */
export function isModelDisabled(model: string | null | undefined): boolean {
  if (!model || !(model in MODEL_CONFIGS)) return false;
  return MODEL_CONFIGS[model as ModelId].disabled === true;
}

/** Human-readable reason a model is disabled (empty string if it isn't). */
export function modelDisabledReason(model: string | null | undefined): string {
  if (!isModelDisabled(model)) return "";
  return MODEL_CONFIGS[model as ModelId].disabledReason ?? DEFAULT_DISABLED_MODEL_REASON;
}

/** Check if a model uses the Anthropic provider */
export function isAnthropicModel(model: ModelId): boolean {
  return MODEL_CONFIGS[model].provider === "anthropic";
}

/** Check if a model uses the OpenAI provider */
export function isOpenAIModel(model: ModelId): boolean {
  return MODEL_CONFIGS[model].provider === "openai";
}

/** Get the provider key name needed in user settings */
export function getProviderKeyName(model: ModelId): string {
  const map: Record<Provider, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    fireworks: "Fireworks",
  };
  return map[MODEL_CONFIGS[model].provider];
}
