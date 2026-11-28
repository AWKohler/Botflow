/**
 * Model configurations — token limits, provider mappings, display names.
 */

export type ModelId =
  | "gpt-6.2-astra"
  | "gpt-6.2-sol"
  | "gpt-6-luna"
  | "claude-sonnet-5-5"
  | "claude-opus-5-5"
  | "claude-fable-5-2"
  | "gemini-4-neon"
  | "grok-4.7"
  | "fireworks-deepseek-v4p1-flash"
  | "fireworks-kimi-k3p1-pro";

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
   * Rough relative cost shown in the model selector ("x4"), vs MiniMax-M3 = 1
   * (retired from the lineup, but still the credit base unit in credits.ts).
   * Derived from credits.ts pricing over a representative agent-loop token
   * mix (see costMultiplierFromPricing there) — billing-invariants.test.ts
   * fails if this drifts from the pricing table, so update both together.
   */
  costMultiplier: number;
  /**
   * Reasoning effort pinned on every request (Anthropic `output_config.effort`).
   * Users get no effort control, so this is the one knob. Applied by both
   * Claude rails: the Claude Code bridge and the LLM proxy (which overrides
   * whatever the in-sandbox client sent).
   * Undefined = provider default.
   */
  effort?: EffortLevel;
  /**
   * Anthropic models whose API rejects explicit thinking config
   * (`disabled` / `budget_tokens`) and forced tool_choice (`any` / `tool`)
   * with a 400 — Opus 5.5, Sonnet 5.5, Fable 5.2. The LLM proxy normalizes
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
  "gpt-6.2-astra": {
    id: "gpt-6.2-astra",
    provider: "openai",
    apiModelId: "gpt-6.2-astra",
    displayName: "GPT-6.2 Astra",
    // 1,050,000 total context (128K max output). We carry the total here like
    // every other entry — the context meter measures the whole window.
    maxContextTokens: 1_050_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 22,
  },
  "gpt-6.2-sol": {
    id: "gpt-6.2-sol",
    provider: "openai",
    apiModelId: "gpt-6.2-sol",
    displayName: "GPT-6.2 Sol",
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
  "claude-fable-5-2": {
    id: "claude-fable-5-2",
    provider: "anthropic",
    apiModelId: "claude-fable-5-2",
    displayName: "Claude Fable 5.2",
    maxContextTokens: 1_000_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 21,
    adaptiveThinkingOnly: true,
  },
  "gemini-4-neon": {
    id: "gemini-4-neon",
    provider: "google",
    apiModelId: "gemini-4-neon",
    displayName: "Gemini 4 Neon",
    // 1M shared window, 64K max output. Flat pricing across the window.
    maxContextTokens: 1_000_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 8,
  },
  "grok-4.7": {
    id: "grok-4.7",
    provider: "xai",
    apiModelId: "grok-4.7",
    displayName: "Grok 4.7",
    maxContextTokens: 500_000,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 7,
  },
  "fireworks-deepseek-v4p1-flash": {
    id: "fireworks-deepseek-v4p1-flash",
    provider: "fireworks",
    // The 1017 update: same price as the original V4.1 Flash, better on
    // coding/agentic work and shorter outputs. The Botflow id stays
    // version-free so a later Flash update is a one-line apiModelId bump.
    apiModelId: "accounts/fireworks/models/deepseek-v4p1-flash-1017",
    displayName: "DeepSeek V4.1 Flash",
    maxContextTokens: 1_048_576,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 0.7,
  },
  "fireworks-kimi-k3p1-pro": {
    id: "fireworks-kimi-k3p1-pro",
    provider: "fireworks",
    apiModelId: "accounts/fireworks/models/kimi-k3p1-pro",
    displayName: "Kimi K3.1 Pro",
    maxContextTokens: 1_048_576,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    supportsImages: true,
    costMultiplier: 6,
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
  // OpenAI → GPT-6.2 Astra / Sol, 6 Luna. 6.2 Sol is 6.1 Sol's successor at
  // identical prices; 6.2 Astra replaces 6 Astra at lower prices.
  "gpt-6-astra": "gpt-6.2-astra",
  "gpt-6.1-sol": "gpt-6.2-sol",
  "gpt-6-sol": "gpt-6.2-sol",
  "gpt-5.6-sol": "gpt-6.2-sol",
  "gpt-5.6-terra": "gpt-6.2-sol",
  "gpt-5.6-luna": "gpt-6-luna",
  "gpt-5.5": "gpt-6.2-sol",
  "gpt-5.4": "gpt-6.2-sol",
  "gpt-5.3-codex": "gpt-6-luna",
  "gpt-5.2": "gpt-6-luna",
  "gpt-4.1": "gpt-6-luna",
  // Anthropic → 5.5 / Fable 5.2
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
  "claude-fable-5-1": "claude-fable-5-2",
  "claude-fable-5": "claude-fable-5-2",
  // Google → Gemini 4 Neon
  "gemini-3.1-pro-preview": "gemini-4-neon",
  "grok-4.5": "grok-4.7",
  // Fireworks. Kimi K2.7 left serverless on Fireworks (2026-09-25) and on
  // Together; its free-tier slot goes to DeepSeek V4.1 Flash. GLM was retired
  // earlier (Grok replaced it in the lineup) — GLM-pinned projects follow the
  // free-tier slot so free users aren't paywalled onto pro Grok.
  // [[grok-glm-replacement]]
  "fireworks-kimi-k2p7": "fireworks-deepseek-v4p1-flash",
  "fireworks-kimi-k2p6": "fireworks-deepseek-v4p1-flash",
  "fireworks-glm-5": "fireworks-deepseek-v4p1-flash",
  "fireworks-glm-5p1": "fireworks-deepseek-v4p1-flash",
  "fireworks-glm-5p2": "fireworks-deepseek-v4p1-flash",
  "fireworks-kimi-k3": "fireworks-kimi-k3p1-pro",
  // MiniMax left the lineup (Luna and DeepSeek Flash are cheaper, read
  // images and have 1M windows); MiniMax-pinned projects move to the default.
  "fireworks-minimax-m3": "gpt-6-luna",
  "fireworks-minimax-m2p7": "gpt-6-luna",
  "fireworks-minimax-m2p5": "gpt-6-luna",
  "fireworks-minimax-m2p1": "gpt-6-luna",
  "kimi-k2.5": "gpt-6-luna",
  "kimi-k2-thinking-turbo": "gpt-6-luna",
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
