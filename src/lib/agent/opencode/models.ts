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
  hasXaiKey?: boolean;
  hasTogetherKey?: boolean;
}

export interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
  /** Explicit model declaration for the generated opencode config, used when
   *  the pinned binary's bundled catalog doesn't know the model (see
   *  CATALOG_GAP_DECLARATIONS). Absent → an empty override, and OpenCode takes
   *  capabilities and limits from its catalog. */
  declaration?: Record<string, unknown>;
}

/**
 * Declarations for models the PINNED OpenCode's bundled catalog lacks.
 *
 * The bridge declares every model, but with an empty override — so
 * `reasoning` (endpoint + request shape), `attachment` (images) and `limit`
 * (auto-compaction) come from the catalog. A model missing there runs with
 * all of them off/unknown. Values are copied from the last OpenCode catalog
 * that had the model. `node --import tsx scripts/check-opencode-catalog.ts`
 * lists gaps; add an entry here (or bump the pin) for each one it reports.
 */
const CATALOG_GAP_DECLARATIONS: Record<string, Record<string, unknown>> = {
  // Dropped from the catalog in opencode 1.19.0; values from 1.18.30's entry.
  "fireworks-ai/accounts/fireworks/models/kimi-k2p7-code": {
    name: "Kimi K2.7 Code",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    interleaved: { field: "reasoning_content" },
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 262000, output: 262000 },
  },
};

function withDeclaration(ref: { providerID: string; modelID: string }): OpenCodeModelRef {
  const declaration = CATALOG_GAP_DECLARATIONS[`${ref.providerID}/${ref.modelID}`];
  return declaration ? { ...ref, declaration } : ref;
}

/** True when the model's capabilities are declared explicitly (no catalog needed). */
export function hasCatalogGapDeclaration(ref: OpenCodeModelRef): boolean {
  return Boolean(ref.declaration);
}

/**
 * Map a Botflow ModelId to OpenCode's { providerID, modelID }. Every model
 * maps: Anthropic models ride OpenCode in PLATFORM mode (server key via the
 * LLM proxy) — personal-credential Anthropic traffic never reaches OpenCode
 * (OAuth per ToS and BYOK both route to Claude Code; see derive-backend).
 */
export function resolveOpenCodeModel(
  model: ModelId,
  opts: { useTogetherKimi: boolean },
): OpenCodeModelRef {
  const config = MODEL_CONFIGS[model];
  switch (config.provider) {
    case "anthropic":
      return withDeclaration({ providerID: "anthropic", modelID: config.apiModelId });
    case "openai":
      return withDeclaration({ providerID: "openai", modelID: config.apiModelId });
    case "google":
      return withDeclaration({ providerID: "google", modelID: config.apiModelId });
    case "xai":
      return withDeclaration({ providerID: "xai", modelID: config.apiModelId });
    case "fireworks":
      if (model === "fireworks-kimi-k2p7" && opts.useTogetherKimi) {
        return withDeclaration({ providerID: "togetherai", modelID: TOGETHER_KIMI_MODEL });
      }
      return withDeclaration({ providerID: "fireworks-ai", modelID: config.apiModelId });
  }
}

export type OpenCodeCredMode = "byok" | "codex-oauth" | null;

/**
 * Which CREDENTIAL MODE an OpenCode turn runs in — no longer an eligibility
 * gate (with the LLM proxy, eligibility is just flag + sandbox platform):
 *   "codex-oauth" — ChatGPT-plan OAuth (the documented stay-in-sandbox
 *                   exception; real tokens, no proxy).
 *   "byok"        — the user's own provider key, injected by the proxy.
 *   null          — platform mode: the platform's server key, injected by
 *                   the proxy, billed per request.
 * Anthropic always returns null here: personal-credential Anthropic traffic
 * routes to Claude Code, so an Anthropic model reaching OpenCode is by
 * definition platform-mode.
 *
 * Deliberately ignores server-key presence (the client must derive the
 * identical answer and can't see server env; the route 412-falls-back when
 * the platform key is genuinely missing).
 */
export function openCodeCredModeForModel(
  model: ModelId,
  creds: OpenCodeCredFlags | null | undefined,
  useTogetherKimi: boolean,
): OpenCodeCredMode {
  if (!creds) return null;
  const config = MODEL_CONFIGS[model];
  switch (config.provider) {
    case "anthropic":
      return null;
    case "openai":
      if (creds.hasCodexOAuth) return "codex-oauth";
      return creds.hasOpenAIKey ? "byok" : null;
    case "google":
      return creds.hasGoogleKey ? "byok" : null;
    case "xai":
      return creds.hasXaiKey ? "byok" : null;
    case "fireworks":
      if (model === "fireworks-kimi-k2p7" && useTogetherKimi) {
        return creds.hasTogetherKey ? "byok" : null;
      }
      return creds.hasFireworksKey ? "byok" : null;
  }
}
