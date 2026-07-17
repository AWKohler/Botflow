/**
 * Provider registry for the universal LLM proxy
 * (/api/internal/llm-proxy/[provider]/[...path]).
 *
 * Data-only and dependency-light so the meter/billing/tests can import it
 * without dragging server modules along. The route maps `byokCredField` onto
 * getUserCredentials() and handles the anthropic OAuth refresh itself.
 *
 * NOTE there is deliberately NO `codex` entry: opencode 1.17.13's
 * ChatGPT-plan plugin hardcodes its endpoint (the codexApiEndpoint option is
 * not wireable from config) and self-refreshes against auth.openai.com — a
 * proxy token in its auth slot would leak to OpenAI's token endpoint. Codex
 * OAuth is the one documented stay-in-sandbox exception; see
 * docs/features/llm-proxy.md. Adding the entry (upstream
 * https://chatgpt.com/backend-api/codex, bearer auth, openai-responses
 * dialect) is all it would take once upstream makes the endpoint wireable.
 */

export type LlmProxyProvider =
  | "anthropic"
  | "openai"
  | "fireworks"
  | "together"
  | "google"
  | "xai";

export type UsageDialect =
  | "anthropic"
  | "openai-chat"
  | "openai-responses"
  | "google";

export type LlmProxyAuthStyle = "bearer" | "x-api-key" | "x-goog-api-key";

export interface LlmProxyProviderSpec {
  /** Upstream origin+prefix the [...path] segments are appended to. No
   *  trailing slash. */
  upstreamBase: string;
  /** Applied to the joined [...path] (no leading slash). */
  pathAllowlist: RegExp;
  /** How the UPSTREAM expects credentials. (The sandbox may deliver our
   *  bfap_ token under a different header — the route accepts all three and
   *  strips them all before forwarding.) */
  authStyle: LlmProxyAuthStyle;
  /** process.env key holding the platform's server key. */
  platformKeyEnv: string;
  /** getUserCredentials() field holding the user's BYOK key. */
  byokCredField:
    | "anthropicApiKey"
    | "openaiApiKey"
    | "fireworksApiKey"
    | "togetherApiKey"
    | "googleApiKey"
    | "xaiApiKey";
  /** Only anthropic supports oauth credMode (Claude plans via Claude Code). */
  supportsOauth: boolean;
  /** Usage dialect by request path. */
  dialectForPath: (path: string) => UsageDialect;
  /** True when the provider caches passively without reliably reporting it —
   *  the clock heuristic applies (fireworks, together). */
  clockHeuristic: boolean;
  /** Suffix appended to the proxy base when configuring the SANDBOX agent —
   *  mirrors what each provider's client library expects to find under its
   *  base URL ("" for anthropic: the CC CLI appends /v1 itself). */
  sandboxBasePath: string;
  /** Extra headers injected on platform-mode upstream requests. */
  extraPlatformHeaders?: (binding: { userId: string }) => Record<string, string>;
}

export const LLM_PROXY_PROVIDERS: Record<LlmProxyProvider, LlmProxyProviderSpec> = {
  anthropic: {
    upstreamBase: "https://api.anthropic.com",
    // Broad on purpose: Claude Code hits /v1/messages, count_tokens, models.
    pathAllowlist: /^v1(\/.*)?$/,
    authStyle: "x-api-key", // byok/platform; oauth mode switches to bearer
    platformKeyEnv: "ANTHROPIC_API_KEY",
    byokCredField: "anthropicApiKey",
    supportsOauth: true,
    dialectForPath: () => "anthropic",
    clockHeuristic: false,
    sandboxBasePath: "",
  },
  openai: {
    upstreamBase: "https://api.openai.com",
    pathAllowlist: /^v1\/(responses|chat\/completions)$/,
    authStyle: "bearer",
    platformKeyEnv: "OPENAI_API_KEY",
    byokCredField: "openaiApiKey",
    supportsOauth: false,
    dialectForPath: (path) =>
      path === "v1/responses" ? "openai-responses" : "openai-chat",
    clockHeuristic: false,
    sandboxBasePath: "/v1",
  },
  fireworks: {
    upstreamBase: "https://api.fireworks.ai/inference",
    pathAllowlist: /^v1\/(chat\/completions|completions)$/,
    authStyle: "bearer",
    platformKeyEnv: "FIREWORKS_API_KEY",
    byokCredField: "fireworksApiKey",
    supportsOauth: false,
    dialectForPath: () => "openai-chat",
    clockHeuristic: true,
    sandboxBasePath: "/v1",
    // Prefix-cache locality: /api/agent has always pinned fireworks traffic
    // per user — keep it or platform-mode cache hit rates crater.
    extraPlatformHeaders: ({ userId }) => ({ "x-session-affinity": userId }),
  },
  together: {
    upstreamBase: "https://api.together.xyz",
    pathAllowlist: /^v1\/chat\/completions$/,
    authStyle: "bearer",
    platformKeyEnv: "TOGETHER_API_KEY",
    byokCredField: "togetherApiKey",
    supportsOauth: false,
    dialectForPath: () => "openai-chat",
    clockHeuristic: true,
    sandboxBasePath: "/v1",
  },
  google: {
    upstreamBase: "https://generativelanguage.googleapis.com",
    pathAllowlist:
      /^(v1beta|v1)\/models\/[^/:]+:(streamGenerateContent|generateContent|countTokens)$/,
    authStyle: "x-goog-api-key",
    platformKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    byokCredField: "googleApiKey",
    supportsOauth: false,
    dialectForPath: () => "google",
    clockHeuristic: false,
    sandboxBasePath: "/v1beta",
  },
  // xAI (Grok) — OpenAI-compatible chat completions. Reports cache reads
  // explicitly in prompt_tokens_details.cached_tokens (verified live), so no
  // clock heuristic. Passive read-only cache: no cache-write billing.
  xai: {
    upstreamBase: "https://api.x.ai",
    // xAI is OpenAI-compatible on BOTH endpoints — opencode routes reasoning
    // models (grok is one) through /v1/responses, others through
    // /v1/chat/completions. Both verified live on api.x.ai. Mirror the openai
    // spec exactly (allowlist + per-path dialect), or reasoning turns 404 with
    // "Unknown proxy path".
    pathAllowlist: /^v1\/(responses|chat\/completions)$/,
    authStyle: "bearer",
    platformKeyEnv: "XAI_API_KEY",
    byokCredField: "xaiApiKey",
    supportsOauth: false,
    dialectForPath: (path) =>
      path === "v1/responses" ? "openai-responses" : "openai-chat",
    clockHeuristic: false,
    sandboxBasePath: "/v1",
  },
};

export function isLlmProxyProvider(value: string): value is LlmProxyProvider {
  return Object.prototype.hasOwnProperty.call(LLM_PROXY_PROVIDERS, value);
}

/** Map opencode catalog provider ids → proxy providers. */
export function proxyProviderForOpenCodeId(providerID: string): LlmProxyProvider | null {
  switch (providerID) {
    case "anthropic": return "anthropic";
    case "openai": return "openai";
    case "fireworks-ai": return "fireworks";
    case "togetherai": return "together";
    case "google": return "google";
    case "xai": return "xai";
    default: return null;
  }
}
