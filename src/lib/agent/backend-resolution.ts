/**
 * Agent backend types + credential-flag mapping.
 *
 * Only the two in-sandbox agents exist: Claude Code (Anthropic models with a
 * personal Anthropic credential) and OpenCode (everything else). The routing
 * decision itself lives in deriveAgentBackend() (./derive-backend.ts).
 */
import { type OpenCodeCredFlags } from "@/lib/agent/opencode/models";

export type AgentBackend = "claude-code" | "opencode";

export interface BackendCreds extends OpenCodeCredFlags {
  /** Whether the user has a working Claude OAuth access token. */
  hasClaudeOAuth: boolean;
  /** Whether the user has a BYOK Anthropic API key on file. */
  hasAnthropicKey: boolean;
}

/**
 * Map a raw credentials record (server: getUserCredentials; client: the
 * /api/user-settings boolean flags) onto BackendCreds. Structural input type
 * so this stays importable from client code.
 */
export function credFlagsFromUserCredentials(creds: {
  claudeOAuthAccessToken?: string | null;
  anthropicApiKey?: string | null;
  codexOAuthAccessToken?: string | null;
  openaiApiKey?: string | null;
  fireworksApiKey?: string | null;
  googleApiKey?: string | null;
  xaiApiKey?: string | null;
  togetherApiKey?: string | null;
}): BackendCreds {
  return {
    hasClaudeOAuth: Boolean(creds.claudeOAuthAccessToken),
    hasAnthropicKey: Boolean(creds.anthropicApiKey),
    hasCodexOAuth: Boolean(creds.codexOAuthAccessToken),
    hasOpenAIKey: Boolean(creds.openaiApiKey),
    hasFireworksKey: Boolean(creds.fireworksApiKey),
    hasGoogleKey: Boolean(creds.googleApiKey),
    hasXaiKey: Boolean(creds.xaiApiKey),
    hasTogetherKey: Boolean(creds.togetherApiKey),
  };
}
