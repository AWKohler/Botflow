/**
 * Model configurations — token limits, provider mappings, display names.
 */

export type ModelId =
  | "gpt-6-astra"
  | "gpt-6.1-sol"
  | "gpt-6-luna"
  | "claude-sonnet-5-5"
  | "claude-opus-5-5"
  | "claude-fable-5-1"
  | "gemini-3.1-pro-preview"
  | "grok-4.5"
  | "fireworks-minimax-m3"
  | "fireworks-kimi-k2p7"
  | "fireworks-kimi-k3";

export type Provider = "openai" | "anthropic" | "google" | "xai" | "fireworks";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelConfig {
  id: ModelId;
  provider: Provider;
  /** Provider-specific model identifier for API calls */
  apiModelId: string;
  /** Display name for the UI */
  displayName: string;
  /** Max context window in tokens */
  maxContextTokens: number;
  /** Context window when the turn runs on the USER'S OWN credentials
   *  (OAuth/BYOK) — some providers grant a larger window there than the
   *  platform-billed default (Anthropic's 1M-context on Claude plans/API keys
   *  vs our 200K platform window). Read via effectiveContextTokens();
   *  undefined = same as maxContextTokens. Display/meter concern only —
   *  billing reservations always use the platform value. */
  personalCredContextTokens?: number;
  /** Warn at this percentage of max context */
  warnThreshold: number;
  /** Critical at this percentage of max context */
  criticalThreshold: number;
  /** Whether this model supports image/file inputs */
  supportsImages: boolean;
  /**
   * Rough relative cost shown in the model selector ("x4"), vs MiniMax-M3 = 1.
   * Derived from credits.ts pricing over a representative agent-loop token
   * mix (see costMultiplierFromPricing there) — billing-invariants.test.ts
   * fails if this drifts from the pricing table, so update both together.
   */
  costMultiplier: number;
  /**
   * Reasoning effort pinned on every request (Anthropic `output_config.effort`).
   * Users get no effort control, so this is the one knob. Applied by all
   * three Claude rails: /api/agent providerOptions, the Claude Code bridge,
   * and the LLM proxy (which overrides whatever the in-sandbox client sent).
   * Undefined = provider default.
   */
  effort?: EffortLevel;
  /**
   * Anthropic models whose API rejects explicit thinking config
   * (`disabled` / `budget_tokens`) and forced tool_choice (`any` / `tool`)
   * with a 400 — Opus 5.5, Sonnet 5.5, Fable 5.1. The LLM proxy normalizes
   * those fields so older in-sandbox clients (pinned Claude Code / OpenCode)
   * keep working.
   */
  adaptiveThinkingOnly?: boolean;
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
  "gpt-6-astra": {
    id: "gpt-6-astra",
    provider: "openai",
    apiModelId: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    // 1,050,000 total context. OpenAI caps the INPUT half at 922K (output at
    // 128K); we carry the total here like every other entry — the context
    // meter measures the whole window, not the input sub-cap.
    maxContextTokens: 1_050_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 31,
  },
  "gpt-6.1-sol": {
    id: "gpt-6.1-sol",
    provider: "openai",
    apiModelId: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    maxContextTokens: 1_050_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 6,
  },
  "gpt-6-luna": {
    id: "gpt-6-luna",
    provider: "openai",
    apiModelId: "gpt-6-luna",
    displayName: "GPT-6 Luna",
    maxContextTokens: 1_050_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 0.3,
  },
  "claude-sonnet-5-5": {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    apiModelId: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    maxContextTokens: 200_000,
    personalCredContextTokens: 1_000_000, // 1M on Claude OAuth/BYOK
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 6,
    effort: "medium",
    adaptiveThinkingOnly: true,
  },
  "claude-opus-5-5": {
    id: "claude-opus-5-5",
    provider: "anthropic",
    apiModelId: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    maxContextTokens: 200_000,
    personalCredContextTokens: 1_000_000, // 1M on Claude OAuth/BYOK
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 11,
    effort: "medium",
    adaptiveThinkingOnly: true,
  },
  "claude-fable-5-1": {
    id: "claude-fable-5-1",
    provider: "anthropic",
    apiModelId: "claude-fable-5-1",
    displayName: "Claude Fable 5.1",
    maxContextTokens: 1_000_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 26,
    adaptiveThinkingOnly: true,
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
    costMultiplier: 6,
  },
  "grok-4.5": {
    id: "grok-4.5",
    provider: "xai",
    apiModelId: "grok-4.5",
    displayName: "Grok 4.5",
    maxContextTokens: 500_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 7,
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
    costMultiplier: 1,
  },
  // "fireworks-glm-5p1": {
  //   id: "fireworks-glm-5p1",
  //   provider: "fireworks",
  //   apiModelId: "accounts/fireworks/models/glm-5p1",
  //   displayName: "GLM-5.1",
  //   maxContextTokens: 202_800,
  //   warnThreshold: 0.7,
  //   criticalThreshold: 0.9,
  //   supportsImages: false,
  // },
  "fireworks-kimi-k2p7": {
    id: "fireworks-kimi-k2p7",
    provider: "fireworks",
    apiModelId: "accounts/fireworks/models/kimi-k2p7-code",
    displayName: "Kimi K2.7",
    maxContextTokens: 262_144,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 3,
  },
  "fireworks-kimi-k3": {
    id: "fireworks-kimi-k3",
    provider: "fireworks",
    apiModelId: "accounts/fireworks/models/kimi-k3",
    displayName: "Kimi K3",
    maxContextTokens: 1_000_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 9,
  },
};

/** The model new projects and unknown/removed stored values fall back to. */
export const DEFAULT_MODEL_ID: ModelId = "gpt-6-luna";

/**
 * Retired / renamed model ids → their current successor. Stored project rows,
 * ?model= links, and old clients still carry these. Single source of truth
 * for every route that accepts a model id (via resolveModelId /
 * isAcceptedModelInput) — add a row here when a model is replaced.
 */
const LEGACY_MODEL_ALIASES: Record<string, ModelId> = {
  // OpenAI → GPT-6 family. There is no GPT-6 Terra; Terra's $2-input slot is
  // now 6.1 Sol (cheaper output than Terra). GPT-6 Sol is superseded by 6.1
  // Sol at identical prices with cheaper cache reads.
  "gpt-6-sol": "gpt-6.1-sol",
  "gpt-5.6-sol": "gpt-6.1-sol",
  "gpt-5.6-terra": "gpt-6.1-sol",
  "gpt-5.6-luna": "gpt-6-luna",
  "gpt-5.5": "gpt-6.1-sol",
  "gpt-5.4": "gpt-6.1-sol",
  "gpt-5.3-codex": "gpt-6-luna",
  "gpt-5.2": "gpt-6-luna",
  "gpt-4.1": "gpt-6-luna",
  // Anthropic → 5.5 / 5.1 generation
  "claude-sonnet-5": "claude-sonnet-5-5",
  "claude-sonnet-4.5": "claude-sonnet-5-5",
  "claude-sonnet-4.6": "claude-sonnet-5-5",
  "claude-sonnet-4-6": "claude-sonnet-5-5",
  "claude-haiku-4.5": "claude-sonnet-5-5",
  "claude-opus-5": "claude-opus-5-5",
  "claude-opus-4-8": "claude-opus-5-5",
  "claude-opus-4-7": "claude-opus-5-5",
  "claude-opus-4.7": "claude-opus-5-5",
  "claude-opus-4.6": "claude-opus-5-5",
  "claude-opus-4.5": "claude-opus-5-5",
  "claude-opus-4-1": "claude-opus-5-5",
  "claude-fable-5": "claude-fable-5-1",
  // GLM retired — Grok 4.5 replaces it in the lineup, but existing GLM-pinned
  // projects fall back to Kimi (both free tier) so free users aren't paywalled
  // onto pro Grok. [[grok-glm-replacement]]
  "fireworks-glm-5": "fireworks-kimi-k2p7",
  "fireworks-glm-5p1": "fireworks-kimi-k2p7",
  "fireworks-glm-5p2": "fireworks-kimi-k2p7",
  "fireworks-kimi-k2p6": "fireworks-kimi-k2p7",
  "fireworks-minimax-m2p7": "fireworks-minimax-m3",
  "fireworks-minimax-m2p5": "fireworks-minimax-m3",
  "kimi-k2.5": "fireworks-minimax-m3",
  "kimi-k2-thinking-turbo": "fireworks-minimax-m3",
};

/** Resolve stored model value — maps renames; unknown/removed models fall back to default */
export function resolveModelId(stored: string | null | undefined): ModelId {
  if (stored && stored in MODEL_CONFIGS) return stored as ModelId;
  if (stored && stored in LEGACY_MODEL_ALIASES) return LEGACY_MODEL_ALIASES[stored];
  // Unknown or removed model: silently use the default model
  return DEFAULT_MODEL_ID;
}

/** Whether a client-supplied model id is acceptable input (a current model or
 *  a known legacy alias). Routes that must reject garbage use this; it does
 *  not resolve — pair with resolveModelId. */
export function isAcceptedModelInput(model: string): boolean {
  return model in MODEL_CONFIGS || model in LEGACY_MODEL_ALIASES;
}

/** Check if a model supports image/file inputs */
export function modelSupportsImages(model: ModelId): boolean {
  return MODEL_CONFIGS[model]?.supportsImages ?? false;
}

/**
 * The context window in effect for a turn: the provider's larger
 * personal-credential window when the turn runs on the user's own
 * OAuth/BYOK creds, else the platform default. Drives the UI context meter
 * (and any other display) — billing reservations deliberately keep using
 * maxContextTokens.
 */
export function effectiveContextTokens(model: ModelId, personalCreds: boolean): number {
  const config = MODEL_CONFIGS[model];
  if (!config) return 128_000;
  return personalCreds
    ? (config.personalCredContextTokens ?? config.maxContextTokens)
    : config.maxContextTokens;
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
    xai: "xAI",
    fireworks: "Fireworks",
  };
  return map[MODEL_CONFIGS[model].provider];
}
