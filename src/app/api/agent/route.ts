import { streamText, tool, convertToModelMessages, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createFireworks } from "@ai-sdk/fireworks";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/project-access";
import { sharedTurnBlockReason } from "@/lib/sharing";
import { auth } from "@clerk/nextjs/server";

import { SYSTEM_PROMPT_MOBILE, SYSTEM_PROMPT_MULTIPLATFORM, buildSwiftSystemPrompt, buildSandboxedWebSystemPrompt, buildWebSystemPrompt } from "@/lib/agent/prompts";
import { isSandboxPlatform } from "@/lib/project-platform";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import { getPersistentTools } from "@/lib/agent/persistent-tools";
import { getGitTools, getSandboxedWebTools } from "@/lib/agent/sandboxed-web-tools";
import { MODEL_CONFIGS, resolveModelId, isModelDisabled, modelDisabledReason, isOpenAIModel, type ModelId } from "@/lib/agent/models";
import { agentLog, generateRequestId, setRequestId } from "@/lib/agent/logger";
import { classifyError, formatErrorResponse } from "@/lib/agent/errors";
import { USE_TOGETHER_KIMI } from "@/lib/feature-flags";

/** Together AI's OpenAI-compatible Kimi K2.7-Code model identifier. */
const TOGETHER_KIMI_MODEL = "moonshotai/Kimi-K2.7-Code";
/** Together AI's OpenAI-compatible base URL. */
const TOGETHER_BASE_URL = "https://api.together.xyz/v1";

/** Convert a stream error to the JSON string the client's parseError() expects. */
function getStreamErrorMessage(error: unknown): string {
  // Try to extract OpenAI responseBody detail (AI_APICallError)
  const e = error as Record<string, unknown>;
  const rawBody = typeof e.responseBody === "string" ? e.responseBody
    : typeof (e.lastError as Record<string, unknown> | undefined)?.responseBody === "string"
      ? (e.lastError as Record<string, unknown>).responseBody as string
      : undefined;
  if (rawBody) {
    try {
      const detail = (JSON.parse(rawBody) as Record<string, unknown>).detail as string | undefined;
      if (detail?.includes("not supported when using Codex")) {
        return JSON.stringify({
          error: "This model is not available with your ChatGPT account. Try a different model or add an OpenAI API key in Settings.",
          errorType: "auth",
        });
      }
    } catch { /* ignore */ }
  }
  const classified = classifyError(error);
  return JSON.stringify(formatErrorResponse(classified));
}
import { withRetry } from "@/lib/agent/retry";
import {
  estimateTokens,
  estimateMessagesTokens,
  needsCompaction,
  compactMessages,
} from "@/lib/agent/compaction";
import { getUserCredentials, setUserCredentials } from "@/lib/user-credentials";
import { refreshCodexOAuthToken } from "@/lib/codex-oauth";
import { getUserTier, MODEL_TIER_REQUIREMENT, tierMeetsRequirement } from "@/lib/tier";
import { recordTokenUsage } from "@/lib/usage";
import { redis } from "@/lib/redis";
import {
  calculateCredits,
  getWeeklyCredits,
  getMonthlyCredits,
  reserveWeeklyCredits,
  adjustWeeklyCredits,
  getWeeklyLimit,
  getMonthlyLimit,
} from "@/lib/credits";
import { limitReachedResponse } from "@/lib/plan-response";
import { enforce, identifierFor } from "@/lib/rate-limit";
import type { ProjectPlatform } from "@/lib/project-platform";

// Allow long-running streamed responses on Vercel
export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ============================================================================
// Tool definitions (shared across all providers)
// ============================================================================

function getTools({ hasBackend }: { hasBackend: boolean } = { hasBackend: true }) {
  const baseTools = {
    listFiles: tool({
      description:
        "List files and folders. Set recursive=true to walk subdirectories. " +
        "Use project-relative paths starting with / (e.g. '/' for root, '/src' for src folder).",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path starting with /, e.g. '/' or '/src'"),
        recursive: z.boolean().optional().default(false),
      }),
    }),
    writeFile: tool({
      description:
        "Write content to a file. This tool COMPLETELY REPLACES the file's contents with the new content you provide. " +
        "Creates the file if it doesn't exist, or COMPLETELY OVERWRITES it if it does (replacing all existing content). " +
        "Use this tool to: (1) create new files, (2) completely rewrite/replace a file's entire contents. " +
        "For small/partial edits to existing files, use applyDiff instead. " +
        "Use project-relative paths starting with / (e.g. '/src/App.tsx').",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Project-relative file path starting with /, e.g. '/src/components/Button.tsx'"),
        content: z
          .string()
          .describe("The content to write to the file"),
      }),
    }),
    readFile: tool({
      description: "Read a single file as UTF-8. Use project-relative paths starting with / (e.g. '/src/main.tsx').",
      inputSchema: z.object({
        path: z.string().describe("Project-relative file path starting with /, e.g. '/src/App.tsx'"),
      }),
    }),
    applyDiff: tool({
      description:
        "Apply SEARCH/REPLACE blocks to a file using fuzzy matching (85% similarity). " +
        "The system uses Levenshtein distance matching and handles whitespace/unicode normalization. " +
        "If a block fails, returns detailed error with best match found and similarity percentage. " +
        "Use project-relative paths starting with / (e.g. '/vite.config.ts').",
      inputSchema: z.object({
        path: z.string().describe("Project-relative file path starting with /, e.g. '/src/App.tsx'"),
        diff: z
          .string()
          .describe(
            "One or more SEARCH/REPLACE blocks. Format: <<<<<<< SEARCH\\n[content]\\n=======\\n[replacement]\\n>>>>>>> REPLACE",
          ),
      }),
    }),
    searchFiles: tool({
      description:
        "Recursive text search starting at path. query may be regex. " +
        "Use project-relative paths starting with / (e.g. '/src').",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path starting with /, e.g. '/' or '/src'"),
        query: z.string().describe("Search pattern (can be regex)"),
      }),
    }),
    executeCommand: tool({
      description: "Run a command in the WebContainer (e.g. pnpm, node).",
      inputSchema: z.object({
        command: z.string(),
        args: z.array(z.string()).default([]),
      }),
    }),
    getDevServerLog: tool({
      description:
        "Return the dev server log. Pass linesBack to control how many tail lines to return (from bottom).",
      inputSchema: z.object({
        linesBack: z
          .number()
          .int()
          .positive()
          .default(200)
          .describe("Number of lines from the end of the log"),
      }),
    }),
    getBrowserLog: tool({
      description:
        "Return the browser console log from the preview iframe. This includes console.log/warn/error calls, runtime errors, and HMR events. Pass linesBack to control how many tail lines to return (from bottom).",
      inputSchema: z.object({
        linesBack: z
          .number()
          .int()
          .positive()
          .default(200)
          .describe("Number of lines from the end of the log"),
      }),
    }),
    startDevServer: tool({
      description:
        "Start the dev server (idempotent). If already running, it will not start another instance and will inform you.",
      inputSchema: z.object({}),
    }),
    stopDevServer: tool({
      description:
        "Stop the dev server if running. If none, returns a message indicating so.",
      inputSchema: z.object({}),
    }),
    isDevServerRunning: tool({
      description:
        "Check whether the dev server is currently running. Cheap check. Use before reading logs or refreshing the preview if you're not sure of the current state.",
      inputSchema: z.object({}),
    }),
    refreshPreview: tool({
      description:
        "Refresh the open preview window (same as clicking refresh). Fails with a message if dev server is not running or refresh not possible.",
      inputSchema: z.object({}),
    }),
    convexDeploy: tool({
      description:
        "Deploy Convex backend changes to production. This zips the convex folder and supporting files (package.json, lock files, tsconfig.json) and sends them to the Convex deployment service. " +
        "The deployment runs npm install and convex deploy, streaming the output. " +
        "This is a synchronous operation that waits for deployment completion (may take several minutes). " +
        "Only use this after making changes to Convex functions, schemas, or cron jobs in the /convex folder.",
      inputSchema: z.object({}),
    }),
    endTurn: tool({
      description:
        "Call this tool when you have completed the user's request. You MUST call this when you are done with your task.",
      inputSchema: z.object({
        summary: z
          .string()
          .describe("A brief summary of what you accomplished"),
      }),
    }),
  } as const;
  // Only expose `convexDeploy` for projects that actually have a Convex backend.
  // No-backend projects have no /convex folder; advertising the tool would invite
  // the model to call it and confuse error messages.
  if (hasBackend) {
    return baseTools;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { convexDeploy: _omit, ...rest } = baseTools;
  return rest;
}

// Rough estimate of tools token overhead (computed once)
const TOOLS_TOKEN_ESTIMATE = 800;

// Per-turn output ceiling, applied ONLY to platform-paid traffic (server-key
// model + no personal credentials). Requests on Claude/Codex OAuth or any BYOK
// key are billed to the user's own provider and are left uncapped. Token usage
// is metered/billed accurately elsewhere, so this is a light runaway-guard, not
// a tight quota. Override via env without a redeploy if needed.
const PLATFORM_MAX_OUTPUT_TOKENS = Number(process.env.PLATFORM_MAX_OUTPUT_TOKENS) || 32_000;

// ============================================================================
// Anthropic prompt caching helpers
// ============================================================================

/**
 * Builds the messages array for Anthropic calls with prompt caching.
 *
 * Two cache breakpoints are injected:
 *  1. The system prompt (first message) — cached on every call since it never changes.
 *  2. The penultimate message — caches the growing conversation history so only the
 *     final user message is charged at full input price on follow-up turns.
 *
 * Anthropic charges ~10x less for cache hits ($0.30/MTok) vs fresh input ($3/MTok for
 * Sonnet), so this dramatically reduces cost for multi-turn coding sessions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildAnthropicCachedMessages(systemPrompt: string, messages: ModelMessage[]): any[] {
  const sysMsg = {
    role: 'system',
    content: systemPrompt,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  };

  if (messages.length < 3) {
    return [sysMsg, ...messages];
  }

  // Add a 2nd cache breakpoint on the last text part of the penultimate message.
  // This causes Anthropic to cache everything up to that point, so only the new
  // user message is processed from scratch on each turn.
  const allButLast = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  const penultimate = allButLast[allButLast.length - 1];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content = (penultimate as any).content;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cachedPenultimate: any = penultimate;

  if (typeof content === 'string') {
    cachedPenultimate = {
      ...penultimate,
      content: [{ type: 'text', text: content, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }],
    };
  } else if (Array.isArray(content)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts = [...content] as any[];
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].type === 'text') {
        parts[i] = { ...parts[i], providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } };
        break;
      }
    }
    cachedPenultimate = { ...penultimate, content: parts };
  }

  return [sysMsg, ...allButLast.slice(0, -1), cachedPenultimate, last];
}

// ============================================================================
// Provider creation helpers
// ============================================================================

function prefixToolName(name: string): string {
  // mcp_ prefix with PascalCase first letter (e.g. listFiles → mcp_ListFiles)
  return `mcp_${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function createAnthropicOAuthProvider(oauthToken: string) {
  return createAnthropic({
    apiKey: "oauth-placeholder",
    fetch: async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      const requestHeaders = new Headers();
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((value, key) => requestHeaders.set(key, value));
        } else if (Array.isArray(init.headers)) {
          for (const [key, value] of init.headers) {
            if (value !== undefined) requestHeaders.set(key, String(value));
          }
        } else {
          for (const [key, value] of Object.entries(init.headers)) {
            if (value !== undefined) requestHeaders.set(key, String(value));
          }
        }
      }

      requestHeaders.set("authorization", `Bearer ${oauthToken}`);
      requestHeaders.delete("x-api-key");

      const existingBeta = requestHeaders.get("anthropic-beta") || "";
      const betaList = existingBeta.split(",").map(b => b.trim()).filter(Boolean);
      const requiredBetas = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"];
      const mergedBetas = [...new Set([...requiredBetas, ...betaList])].join(",");
      requestHeaders.set("anthropic-beta", mergedBetas);
      requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)");
      requestHeaders.set("x-anthropic-billing-header", "cc_version=2.1.2; cc_entrypoint=sdk-cli;");

      let body = init?.body;
      if (body && typeof body === "string") {
        try {
          const parsed = JSON.parse(body);
          if (parsed.tools && Array.isArray(parsed.tools)) {
            parsed.tools = parsed.tools.map((t: Record<string, unknown>) => ({
              ...t,
              name: t.name ? prefixToolName(t.name as string) : t.name,
            }));
          }
          if (parsed.messages && Array.isArray(parsed.messages)) {
            parsed.messages = parsed.messages.map((msg: Record<string, unknown>) => {
              if (msg.content && Array.isArray(msg.content)) {
                msg.content = msg.content.map((block: Record<string, unknown>) => {
                  if (block.type === "tool_use" && block.name) {
                    return { ...block, name: prefixToolName(block.name as string) };
                  }
                  return block;
                });
              }
              return msg;
            });
          }
          body = JSON.stringify(parsed);
        } catch {
          // ignore parse errors
        }
      }

      let finalInput: RequestInfo | URL = requestInput;
      try {
        const url = requestInput instanceof URL
          ? new URL(requestInput.toString())
          : new URL(typeof requestInput === "string" ? requestInput : (requestInput as Request).url);
        if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
          url.searchParams.set("beta", "true");
          finalInput = requestInput instanceof Request
            ? new Request(url.toString(), requestInput)
            : url;
        }
      } catch {
        // ignore URL parse errors
      }

      const response = await fetch(finalInput, {
        ...init,
        body,
        headers: requestHeaders,
      });

      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();

        const stream = new ReadableStream({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            let text = decoder.decode(value, { stream: true });
            // Strip mcp_ prefix and restore original camelCase first letter
            text = text.replace(/"name"\s*:\s*"mcp_([A-Z])([^"]+)"/g, (_, first, rest) => `"name": "${first.toLowerCase()}${rest}"`);
            text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
            controller.enqueue(encoder.encode(text));
          },
        });

        return new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      return response;
    },
  });
}

async function refreshAnthropicOAuthToken(
  creds: { claudeOAuthRefreshToken?: string | null },
  userId: string
): Promise<string | null> {
  if (!creds.claudeOAuthRefreshToken) return null;

  try {
    const refreshRes = await fetch('https://platform.claude.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        refresh_token: creds.claudeOAuthRefreshToken,
      }),
    });

    if (!refreshRes.ok) return null;

    const refreshed = await refreshRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const newExpiresAt = refreshed.expires_in
      ? Date.now() + refreshed.expires_in * 1000 - 5 * 60 * 1000
      : null;

    await setUserCredentials(userId, {
      claudeOAuthAccessToken: refreshed.access_token,
      claudeOAuthRefreshToken: refreshed.refresh_token ?? creds.claudeOAuthRefreshToken,
      claudeOAuthExpiresAt: newExpiresAt,
    });

    return refreshed.access_token;
  } catch {
    return null;
  }
}

// ============================================================================
// GPT-5.5: inject prompt_cache_retention: "24h" for extended caching.
// NB: this param is deprecated on GPT-5.6+ (which use prompt_cache_options.ttl,
// default 30m) — do NOT send it for 5.6 models or the request may be rejected.
// ============================================================================

async function injectOpenAICacheRetention(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (init?.body && typeof init.body === 'string') {
    try {
      const parsed = JSON.parse(init.body);
      parsed.prompt_cache_retention = '24h';
      return fetch(input, { ...init, body: JSON.stringify(parsed) });
    } catch {
      // ignore parse errors — fall through to normal fetch
    }
  }
  return fetch(input, init);
}

// ============================================================================
// Determine if this request is using a server-side key (paid tier) vs BYOK/OAuth
// ============================================================================

/** Server key models: models the app pays for on behalf of paid users */
const SERVER_KEY_MODELS = new Set<ModelId>([
  'fireworks-minimax-m3', // free tier
  'fireworks-glm-5p2',         // free tier
  'fireworks-kimi-k2p7',     // free tier
  'gpt-5.6-sol',             // pro+
  'gpt-5.6-terra',           // pro+
  'gpt-5.6-luna',            // pro+
  'gpt-5.5',                 // pro+
  'claude-sonnet-5',         // pro+
  'claude-opus-4-8',         // pro+
  'claude-fable-5',          // max-only
  'gemini-3.1-pro-preview',  // pro+
]);

function isServerKeyModel(model: ModelId): boolean {
  return SERVER_KEY_MODELS.has(model);
}

// ============================================================================
// Main POST handler
// ============================================================================

export async function POST(req: Request) {
  const requestId = generateRequestId();
  setRequestId(requestId);
  const startTime = Date.now();

  try {
    const { userId } = await auth();
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Per-user request-rate guard for this expensive LLM turn endpoint. Runs
    // before any model/credit work so a burst can't drive Anthropic/OpenAI/etc.
    // spend or long-lived streams; credit reservation below is a separate guard.
    const blocked = await enforce(identifierFor(userId, req), "agent");
    if (blocked) return blocked;

    const {
      messages,
      projectId,
      platform,
    }: { messages: unknown; projectId?: string; platform?: ProjectPlatform } =
      await req.json();

    // Determine selected model for project and ensure ownership
    let selectedModel: ModelId = "fireworks-kimi-k2p7";
    // Default to true so non-project agent requests still get the full toolset.
    let hasBackend = true;
    let convexUrl: string | undefined;
    let githubLink: {
      owner: string;
      name: string;
      branch: string;
      autonomy: "autonomous" | "manual" | "ask-each-time" | null;
    } | undefined;
    if (projectId) {
      const access = await requireProjectAccess(projectId, userId);
      if (!access) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      const proj = access.project;
      // Swift's runtime is beta-only. Gate on the STORED platform so a non-beta
      // owner of a legacy swift project can't drive the native agent's sandbox
      // tools against the swift sandbox.
      // Sharing (Phase 3): one live in-sandbox agent per project across ALL
      // collaborators (CC/OpenCode turns register; this route only checks).
      const sharedBlock = await sharedTurnBlockReason(projectId, userId);
      if (sharedBlock) {
        return new Response(JSON.stringify({ error: sharedBlock }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (await swiftRuntimeForbidden(proj.platform, userId)) {
        return new Response(
          JSON.stringify({ error: "Swift projects are currently in private beta." }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      selectedModel = resolveModelId(proj.model);
      hasBackend = proj.backendType !== "none";
      convexUrl = proj.userConvexUrl || proj.convexDeployUrl || undefined;
      if (proj.githubRepoOwner && proj.githubRepoName) {
        const autonomyValue = proj.gitAutonomy;
        const autonomy: "autonomous" | "manual" | "ask-each-time" | null =
          autonomyValue === "autonomous"
          || autonomyValue === "manual"
          || autonomyValue === "ask-each-time"
            ? autonomyValue
            : null;
        githubLink = {
          owner: proj.githubRepoOwner,
          name: proj.githubRepoName,
          branch: proj.githubDefaultBranch ?? "main",
          autonomy,
        };
      }
    }

    // ── Globally disabled model guard (applies to ALL auth paths) ────────────
    // A model can be administratively disabled in the central registry (e.g.
    // rescinded by the provider). This guard runs BEFORE any BYOK/OAuth/server-
    // key branching, so no user can bypass the grayed-out selector by calling
    // this endpoint directly with their own key.
    if (isModelDisabled(selectedModel)) {
      return new Response(
        JSON.stringify({
          error: modelDisabledReason(selectedModel),
          errorType: "model_disabled",
          model: selectedModel,
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    // Load credentials from Clerk (Redis-cached)
    const creds = await getUserCredentials(userId);

    const modelConfig = MODEL_CONFIGS[selectedModel];
    const systemPrompt =
      platform === "swift"
        ? buildSwiftSystemPrompt({ hasBackend })
        : platform === "sandboxed-web"
          ? buildSandboxedWebSystemPrompt({ hasBackend })
          : platform === "mobile"
            ? SYSTEM_PROMPT_MOBILE
            : platform === "multiplatform"
              ? SYSTEM_PROMPT_MULTIPLATFORM
              : buildWebSystemPrompt({ hasBackend });

    // Sandbox platforms: tools execute server-side against the user's Vercel
    // sandbox. Client never sees onToolCall — keeps platform creds off-browser.
    let tools: ReturnType<typeof getTools> | ReturnType<typeof getPersistentTools> | ReturnType<typeof getSandboxedWebTools> | (ReturnType<typeof getPersistentTools> & ReturnType<typeof getGitTools>);
    if (platform === "sandboxed-web" && projectId) {
      // Forward Cookie so the internal /api/projects/:id/convex/deploy call
      // sees the same Clerk session.
      const cookie = req.headers.get("cookie") ?? "";
      tools = getSandboxedWebTools({
        projectId,
        userId,
        hasBackend,
        convexUrl,
        appBaseUrl: new URL(req.url).origin,
        ...(cookie ? { authHeaders: { cookie } } : {}),
        ...(githubLink
          ? { github: { ...githubLink, userId } }
          : {}),
      });
    } else if (isSandboxPlatform(platform ?? "") && projectId) {
      // Swift (and other persistent-sandbox platforms): file/exec tools, plus
      // Convex deploy/logs when the project has a backend. Forward Cookie so the
      // internal /api/projects/:id/convex/deploy call sees the same Clerk session.
      const cookie = req.headers.get("cookie") ?? "";
      const persistentTools = getPersistentTools(projectId, {
        hasBackend,
        actingUserId: userId,
        appBaseUrl: new URL(req.url).origin,
        ...(platform ? { platform } : {}),
        ...(cookie ? { authHeaders: { cookie } } : {}),
      });
      // Same git tool surface as sandboxed-web — the sandbox has a real .git
      // once a repo is linked, and sandbox-git is platform-agnostic.
      tools = githubLink
        ? {
            ...persistentTools,
            ...getGitTools({
              projectId,
              ownerName: { owner: githubLink.owner, name: githubLink.name },
              branch: githubLink.branch,
              userId,
              autonomy: githubLink.autonomy,
            }),
          }
        : persistentTools;
    } else {
      tools = getTools({ hasBackend });
    }

    // ── Tier enforcement for server-key models ──────────────────────────────
    // Detect if this request uses personal BYOK/OAuth credentials (skip credit checks)
    const isUsingPersonalCredentials = ((): boolean => {
      if (isOpenAIModel(selectedModel)) {
        return Boolean(creds.codexOAuthAccessToken || creds.openaiApiKey);
      }
      if (selectedModel === 'fireworks-kimi-k2p7' && USE_TOGETHER_KIMI) {
        // Kimi traffic is redirected to Together AI — BYOK means a personal
        // Together key and no server-side TOGETHER_API_KEY.
        return Boolean(creds.togetherApiKey) && !process.env.TOGETHER_API_KEY;
      }
      if (selectedModel === 'fireworks-minimax-m3' || selectedModel === 'fireworks-glm-5p2' || selectedModel === 'fireworks-kimi-k2p7') {
        return Boolean(creds.fireworksApiKey) && !process.env.FIREWORKS_API_KEY;
      }
      if (selectedModel === 'gemini-3.1-pro-preview') {
        return Boolean(creds.googleApiKey) && !process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      }
      // Anthropic models — OAuth token only counts when the feature flag is on
      return Boolean(
        (process.env.NEXT_PUBLIC_ANTHROPIC_OAUTH_ENABLED === 'true' && creds.claudeOAuthAccessToken)
        || creds.anthropicApiKey
      );
    })();

    // ── Convert UIMessages to ModelMessages ─────────────────────────────────
    // Done before budget enforcement so the weekly reservation can size itself
    // off the real input-token estimate.
    let resolvedMessages = await convertToModelMessages(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages as any,
      { tools },
    );
    const systemTokens = estimateTokens(systemPrompt);
    const messagesTokens = estimateMessagesTokens(resolvedMessages);
    const totalEstimatedTokens = systemTokens + messagesTokens + TOOLS_TOKEN_ESTIMATE;

    // ── Atomic weekly-credit reservation bookkeeping ─────────────────────────
    // `weeklyReserved` holds this turn's reserved (worst-case) credits; it is
    // reconciled down to the real cost in onFinish, or released if the request
    // aborts first. The reconcile is idempotent so onFinish and the abort
    // handler can't double-apply.
    let weeklyReserved = 0;
    let creditReconciled = false;
    const reconcileWeeklyCredits = async (actualCredits: number): Promise<void> => {
      if (creditReconciled || weeklyReserved === 0) return;
      creditReconciled = true;
      const delta = actualCredits - weeklyReserved;
      if (delta !== 0) {
        await adjustWeeklyCredits(userId, delta).catch((err) => {
          console.error("[agent] weekly_credit_reconcile_failed", err);
        });
      }
    };
    // Release the reservation if the client disconnects before onFinish runs.
    req.signal.addEventListener("abort", () => { void reconcileWeeklyCredits(0); });

    // ── Tier + credit budget enforcement (platform-paid models only) ─────────
    // Weekly budget uses an ATOMIC reservation: reserve this turn's worst-case
    // cost (all input uncached + the 32k output ceiling) via a single INCRBY,
    // then reconcile to the real cost in onFinish. This closes the
    // check-then-spend race — concurrent requests can no longer all clear the
    // same pre-spend balance. Monthly is the slower aggregate guard; bursting it
    // requires first clearing the weekly reservation, so weekly is the binding
    // burst limiter.
    if (isServerKeyModel(selectedModel) && !isUsingPersonalCredentials) {
      const tier = await getUserTier(userId);
      const requiredTier = MODEL_TIER_REQUIREMENT[selectedModel] ?? 'free';

      // Check if user's tier supports this model on server keys
      if (!tierMeetsRequirement(tier, requiredTier)) {
        return limitReachedResponse({
          limitType: 'agent_turns_daily',
          current: 0,
          limit: 0,
          tier,
          model: selectedModel,
        });
      }

      // Monthly credit limit (eventually-consistent aggregate from Neon)
      const monthlyLimit = getMonthlyLimit(tier);
      const monthlyUsed = await getMonthlyCredits(userId);
      if (monthlyUsed >= monthlyLimit) {
        return limitReachedResponse({
          limitType: 'monthly_credits',
          current: monthlyUsed,
          limit: monthlyLimit,
          tier,
          model: selectedModel,
        });
      }

      // Weekly credit limit — atomic worst-case reservation
      const weeklyLimit = getWeeklyLimit(tier);
      weeklyReserved = calculateCredits({
        model: selectedModel,
        inputTokens: totalEstimatedTokens,
        outputTokens: PLATFORM_MAX_OUTPUT_TOKENS,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
      });
      const reserved = await reserveWeeklyCredits(userId, weeklyReserved, weeklyLimit);
      if (!reserved) {
        weeklyReserved = 0; // reservation was rolled back inside the helper
        const weeklyUsed = await getWeeklyCredits(userId);
        return limitReachedResponse({
          limitType: 'weekly_credits',
          current: weeklyUsed,
          limit: weeklyLimit,
          tier,
          model: selectedModel,
        });
      }
    }

    if (needsCompaction(systemTokens, messagesTokens, TOOLS_TOKEN_ESTIMATE, selectedModel)) {
      agentLog.info("context_compaction_triggered", {
        totalTokens: totalEstimatedTokens,
        maxTokens: modelConfig.maxContextTokens,
        model: selectedModel,
      });
      const { compacted } = compactMessages(resolvedMessages);
      resolvedMessages = compacted;
    }

    // Strip file/image parts for models that don't support vision
    if (!modelConfig.supportsImages) {
      for (const msg of resolvedMessages) {
        if (Array.isArray(msg.content)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (msg as any).content = (msg.content as Array<{ type: string }>).filter(part => part.type !== 'file');
        }
      }
    }

    agentLog.apiCall({
      model: selectedModel,
      tokenCount: totalEstimatedTokens,
      messageCount: resolvedMessages.length,
    });

    // ── Common response headers ──────────────────────────────────────────────
    const responseHeaders = {
      "x-request-id": requestId,
      "x-model": selectedModel,
      "x-token-estimate": String(totalEstimatedTokens),
      "x-max-tokens": String(modelConfig.maxContextTokens),
    };

    // ── Build the model provider and stream ──────────────────────────────────

    // Fetch last-call timestamp for Fireworks cache timing heuristic (fire-and-forget ok if fails)
    const lastCallKey = `last_call:${userId}:${projectId ?? 'anon'}`;
    const lastCallMs = await redis.get<number>(lastCallKey).catch(() => 0) ?? 0;
    const msSinceLastCall = startTime - lastCallMs;
    const CACHE_TTL_MS = 5 * 60 * 1000; // Fireworks cache max TTL

    const streamCall = async () => {

      // ── Per-turn output ceiling (platform-paid traffic only) ─────────────────
      // Cap output tokens only when the PLATFORM foots the bill — i.e. a
      // server-key model with no personal credentials. On Claude/Codex OAuth or
      // any BYOK key, isUsingPersonalCredentials is true (or the model isn't a
      // server-key model), so this resolves to undefined and the AI SDK applies
      // no cap. The value is request-level constant, so applying it uniformly to
      // every provider branch below is correct for whichever branch executes.
      const maxOutputTokens =
        isServerKeyModel(selectedModel) && !isUsingPersonalCredentials
          ? PLATFORM_MAX_OUTPUT_TOKENS
          : undefined;

      // ── onFinish: record actual token usage ──────────────────────────────────
      // AI SDK v6 usage shape:
      //   inputTokens: total input (includes cached)
      //   inputTokenDetails: { noCacheTokens, cacheReadTokens, cacheWriteTokens }
      //   outputTokens: total output
      //   providerMetadata: provider-specific extras
      const onFinish = async (event: {
        usage: {
          inputTokens?: number;
          outputTokens?: number;
          inputTokenDetails?: {
            noCacheTokens?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          };
          // Deprecated but still available as fallback
          cachedInputTokens?: number;
        };
        providerMetadata?: Record<string, Record<string, unknown>>;
        response?: { headers?: Record<string, string> };
      }) => {
        const tokensIn = event.usage.inputTokens ?? 0;
        const tokensOut = event.usage.outputTokens ?? 0;

        // ── Extract cached token counts ───────────────────────────────────────
        // AI SDK v6 puts cache details in inputTokenDetails for all providers.
        let cachedRead = event.usage.inputTokenDetails?.cacheReadTokens ?? 0;
        const cachedWrite = event.usage.inputTokenDetails?.cacheWriteTokens ?? 0;

        // Fallback: deprecated top-level field
        if (cachedRead === 0 && event.usage.cachedInputTokens) {
          cachedRead = event.usage.cachedInputTokens;
        }

        // Fireworks fallback: providerMetadata or response header
        if (cachedRead === 0 && (selectedModel === 'fireworks-minimax-m3' || selectedModel === 'fireworks-glm-5p2' || selectedModel === 'fireworks-kimi-k2p7')) {
          const metaCache = event.providerMetadata?.fireworks?.cachedPromptTokens as number | undefined;
          if (metaCache !== undefined && metaCache > 0) {
            cachedRead = metaCache;
          } else {
            const headerVal = event.response?.headers?.['fireworks-cached-prompt-tokens'];
            if (headerVal) {
              const parsed = parseInt(headerVal, 10);
              if (!isNaN(parsed) && parsed > 0) cachedRead = parsed;
            }
          }
          // Fireworks doesn't reliably report cache hits — if <5min since last call,
          // assume all input tokens were cached (best-effort heuristic).
          if (cachedRead === 0 && msSinceLastCall < CACHE_TTL_MS && tokensIn > 0) {
            cachedRead = tokensIn;
          }
        }

        // Update last-call timestamp for next request's timing heuristic
        redis.setex(lastCallKey, 86_400, startTime).catch(() => {});

        let actualCredits = 0;
        if (isServerKeyModel(selectedModel) && (tokensIn > 0 || tokensOut > 0)) {
          // Compute uncached input tokens.
          // In AI SDK v6, inputTokens is the TOTAL (includes cached).
          // noCacheTokens gives us the uncached portion directly; otherwise derive it.
          const uncachedInput = event.usage.inputTokenDetails?.noCacheTokens
            ?? Math.max(0, tokensIn - cachedRead - cachedWrite);

          // Personal credentials (OAuth/BYOK) don't consume platform credits
          actualCredits = isUsingPersonalCredentials ? 0 : calculateCredits({
            model: selectedModel,
            inputTokens: uncachedInput,
            outputTokens: tokensOut,
            cachedReadTokens: cachedRead,
            cacheWriteTokens: cachedWrite,
          });
          // Record usage to Neon (monthly aggregate + audit trail).
          await recordTokenUsage(userId, selectedModel, tokensIn, tokensOut, actualCredits, cachedRead, cachedWrite).catch(() => {});
        }
        // Reconcile the atomic weekly reservation down to the real cost (or
        // release it entirely if no usage was reported). Always runs for
        // platform-paid traffic so a reservation can't be left stranded; a
        // no-op when nothing was reserved (personal credentials).
        await reconcileWeeklyCredits(actualCredits);
        const durationMs = Date.now() - startTime;
        agentLog.apiComplete({ model: selectedModel, durationMs });
      };

      if (isOpenAIModel(selectedModel)) {
        // Path A: Codex OAuth (priority)
        if (creds.codexOAuthAccessToken) {
          let accessToken = creds.codexOAuthAccessToken;
          const expiresAt = creds.codexOAuthExpiresAt;
          const isExpired = expiresAt !== null && expiresAt !== undefined && Date.now() >= expiresAt;

          if (isExpired) {
            accessToken = await refreshCodexOAuthToken(creds, userId) ?? "";
          }

          if (accessToken) {
            const accountId = creds.codexOAuthAccountId;
            const openai = createOpenAI({
              apiKey: "codex-oauth-placeholder",
              fetch: async (requestInput: RequestInfo | URL, init?: RequestInit) => {
                const requestHeaders = new Headers();
                if (init?.headers) {
                  if (init.headers instanceof Headers) {
                    init.headers.forEach((value, key) => requestHeaders.set(key, value));
                  } else if (Array.isArray(init.headers)) {
                    for (const [key, value] of init.headers) {
                      if (value !== undefined) requestHeaders.set(key, String(value));
                    }
                  } else {
                    for (const [key, value] of Object.entries(init.headers)) {
                      if (value !== undefined) requestHeaders.set(key, String(value));
                    }
                  }
                }

                requestHeaders.set("authorization", `Bearer ${accessToken}`);
                if (accountId) {
                  requestHeaders.set("ChatGPT-Account-Id", accountId);
                }

                let finalInput: RequestInfo | URL = requestInput;
                try {
                  const url = requestInput instanceof URL
                    ? new URL(requestInput.toString())
                    : new URL(typeof requestInput === "string" ? requestInput : (requestInput as Request).url);
                  if (url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions")) {
                    finalInput = "https://chatgpt.com/backend-api/codex/responses";
                  }
                } catch {
                  // ignore URL parse errors
                }

                return fetch(finalInput, {
                  ...init,
                  headers: requestHeaders,
                });
              },
            });

            // Pass system prompt via providerOptions.instructions so the SDK
            // sets it natively in the request body. systemMessageMode:"remove"
            // prevents it from also being added as a developer message in input.
            const result = streamText({
              model: openai.responses(modelConfig.apiModelId),
              messages: resolvedMessages,
              tools,
              onFinish,
              maxOutputTokens,
              providerOptions: {
                openai: {
                  instructions: systemPrompt,
                  systemMessageMode: "remove",
                  store: false,
                },
              },
            });
            return result.toUIMessageStreamResponse({ headers: responseHeaders, onError: getStreamErrorMessage });
          }
        }

        // Path B: OpenAI BYOK API key
        if (creds.openaiApiKey) {
          const openai = createOpenAI(selectedModel === 'gpt-5.5'
            ? { apiKey: creds.openaiApiKey, fetch: injectOpenAICacheRetention }
            : { apiKey: creds.openaiApiKey });
          const result = streamText({
            model: openai.responses(modelConfig.apiModelId),
            messages: resolvedMessages,
            tools,
            onFinish,
            maxOutputTokens,
            providerOptions: {
              openai: {
                instructions: systemPrompt,
                systemMessageMode: "remove",
                store: false,
              },
            },
          });
          return result.toUIMessageStreamResponse({ headers: responseHeaders, onError: getStreamErrorMessage });
        }

        // Path C: Server-side OpenAI key for Pro/Max tiers
        const serverOpenAIKey = process.env.OPENAI_API_KEY;
        if (isServerKeyModel(selectedModel) && serverOpenAIKey) {
          const openai = createOpenAI(selectedModel === 'gpt-5.5'
            ? { apiKey: serverOpenAIKey, fetch: injectOpenAICacheRetention }
            : { apiKey: serverOpenAIKey });
          const result = streamText({
            model: openai.responses(modelConfig.apiModelId),
            messages: resolvedMessages,
            tools,
            onFinish,
            maxOutputTokens,
            providerOptions: {
              openai: {
                instructions: systemPrompt,
                systemMessageMode: "remove",
                store: false,
              },
            },
          });
          return result.toUIMessageStreamResponse({ headers: responseHeaders, onError: getStreamErrorMessage });
        }

        return new Response(
          JSON.stringify({ error: "Missing OpenAI credentials. Connect ChatGPT Codex or add an OpenAI API key in Settings.", errorType: "auth" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      if (selectedModel === "gemini-3.1-pro-preview") {
        // Priority: BYOK googleApiKey → server-side GOOGLE_GENERATIVE_AI_API_KEY (Pro+ only)
        const apiKey = creds.googleApiKey
          ?? (isServerKeyModel(selectedModel) ? (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? null) : null);

        if (!apiKey) {
          const usingServer = isServerKeyModel(selectedModel) && !creds.googleApiKey;
          const msg = usingServer
            ? `${modelConfig.displayName} is temporarily unavailable (missing server configuration). Please try a different model or add your own Google API key in Settings.`
            : "Missing Google API key. Please add it in Settings.";
          return new Response(
            JSON.stringify({ error: msg, errorType: usingServer ? "unavailable" : "auth" }),
            { status: usingServer ? 503 : 400, headers: { "Content-Type": "application/json" } },
          );
        }

        const google = createGoogleGenerativeAI({ apiKey });
        const result = streamText({
          model: google(modelConfig.apiModelId),
          system: systemPrompt,
          messages: resolvedMessages,
          tools,
          onFinish,
          maxOutputTokens,
        });
        return result.toUIMessageStreamResponse({ headers: responseHeaders, onError: getStreamErrorMessage });
      }

      // ── Kimi K2.7 via Together AI (feature-flagged redirect off Fireworks) ──
      // When USE_TOGETHER_KIMI is on, Kimi traffic goes to Together AI's
      // OpenAI-compatible endpoint instead of Fireworks. The model id stays
      // `fireworks-kimi-k2p7` everywhere else; only the provider changes here.
      if (selectedModel === "fireworks-kimi-k2p7" && USE_TOGETHER_KIMI) {
        // Priority: server-side TOGETHER_API_KEY (server-key model) → BYOK key
        const serverTogetherKey = process.env.TOGETHER_API_KEY;
        const apiKey = isServerKeyModel(selectedModel) && serverTogetherKey
          ? serverTogetherKey
          : creds.togetherApiKey;

        if (!apiKey) {
          const msg = isServerKeyModel(selectedModel)
            ? `${modelConfig.displayName} is temporarily unavailable (missing server configuration). Please try a different model or add your own Together AI API key in Settings.`
            : "Missing Together AI API key. Please add it in Settings.";
          return new Response(
            JSON.stringify({ error: msg, errorType: isServerKeyModel(selectedModel) ? "unavailable" : "auth" }),
            { status: isServerKeyModel(selectedModel) ? 503 : 400, headers: { "Content-Type": "application/json" } },
          );
        }

        agentLog.info("kimi_routed_to_together", {
          model: selectedModel,
          usingServerKey: Boolean(isServerKeyModel(selectedModel) && serverTogetherKey),
        });
        const together = createOpenAICompatible({
          name: "together",
          apiKey,
          baseURL: TOGETHER_BASE_URL,
        });
        const result = streamText({
          model: together(TOGETHER_KIMI_MODEL),
          system: systemPrompt,
          messages: resolvedMessages,
          tools,
          onFinish,
          maxOutputTokens,
        });
        return result.toUIMessageStreamResponse({ headers: responseHeaders, onError: getStreamErrorMessage });
      }

      if (selectedModel === "fireworks-minimax-m3" || selectedModel === "fireworks-glm-5p2" || selectedModel === "fireworks-kimi-k2p7") {
        // Check for server-side Fireworks key first (for server-key models)
        const serverFireworksKey = process.env.FIREWORKS_API_KEY;
        const apiKey = isServerKeyModel(selectedModel) && serverFireworksKey
          ? serverFireworksKey
          : creds.fireworksApiKey;

        if (!apiKey) {
          const msg = isServerKeyModel(selectedModel)
            ? `${modelConfig.displayName} is temporarily unavailable (missing server configuration). Please try a different model or add your own Fireworks API key in Settings.`
            : "Missing Fireworks API key. Please add it in Settings.";
          return new Response(
            JSON.stringify({ error: msg, errorType: isServerKeyModel(selectedModel) ? "unavailable" : "auth" }),
            { status: isServerKeyModel(selectedModel) ? 503 : 400, headers: { "Content-Type": "application/json" } },
          );
        }
        // Pass userId as session affinity so Fireworks routes to the same replica,
        // maximizing prompt cache hit rates (caching only works within one replica).
        const fireworks = createFireworks({ apiKey, headers: { 'x-session-affinity': userId } });
        const result = streamText({
          model: fireworks(modelConfig.apiModelId),
          system: systemPrompt,
          messages: resolvedMessages,
          tools,
          onFinish,
          maxOutputTokens,
        });
        return result.toUIMessageStreamResponse({ headers: responseHeaders, onError: getStreamErrorMessage });
      }

      // ── Anthropic models ──────────────────────────────────────────────────
      // Priority: OAuth token > server-side API key (for server-key models) > BYOK API key
      let anthropicToken: string | null = null;

      if (creds.claudeOAuthAccessToken) {
        const expiresAt = creds.claudeOAuthExpiresAt;
        const isExpired = expiresAt !== null && expiresAt !== undefined && Date.now() >= expiresAt;

        if (!isExpired) {
          anthropicToken = creds.claudeOAuthAccessToken;
        } else {
          anthropicToken = await refreshAnthropicOAuthToken(creds, userId);
        }
      }

      if (!anthropicToken) {
        // Check server-side Anthropic key for paid tier models
        const serverAnthropicKey = process.env.ANTHROPIC_API_KEY;
        if (isServerKeyModel(selectedModel) && serverAnthropicKey) {
          const anthropic = createAnthropic({ apiKey: serverAnthropicKey });
          const result = streamText({
            model: anthropic(modelConfig.apiModelId),
            messages: buildAnthropicCachedMessages(systemPrompt, resolvedMessages),
            tools,
            onFinish,
            maxOutputTokens,
          });
          return result.toUIMessageStreamResponse({ headers: responseHeaders, onError: getStreamErrorMessage });
        }

        // Fall back to BYOK key
        if (creds.anthropicApiKey) {
          const anthropic = createAnthropic({ apiKey: creds.anthropicApiKey });
          const result = streamText({
            model: anthropic(modelConfig.apiModelId),
            messages: buildAnthropicCachedMessages(systemPrompt, resolvedMessages),
            tools,
            onFinish,
            maxOutputTokens,
          });
          return result.toUIMessageStreamResponse({ headers: responseHeaders, onError: getStreamErrorMessage });
        }

        return new Response(
          JSON.stringify({
            error: "Missing Anthropic credentials. Add an API key or connect via Claude Code OAuth in Settings.",
            errorType: "auth",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Use OAuth token with custom fetch
      const anthropic = createAnthropicOAuthProvider(anthropicToken);
      const result = streamText({
        model: anthropic(modelConfig.apiModelId),
        messages: buildAnthropicCachedMessages(systemPrompt, resolvedMessages),
        tools,
        onFinish,
        maxOutputTokens,
      });
      return result.toUIMessageStreamResponse({ headers: responseHeaders, onError: getStreamErrorMessage });
    };

    // ── Execute with retry logic ─────────────────────────────────────────────
    const response = await withRetry(streamCall, {
      maxRetries: 2,
      signal: req.signal,
    });

    return response;
  } catch (err) {
    const durationMs = Date.now() - startTime;

    if (err instanceof DOMException && err.name === "AbortError") {
      agentLog.info("request_aborted", { durationMs });
      return new Response(null, { status: 499 });
    }

    const classified = classifyError(err);
    agentLog.error("agent_api_error", {
      errorType: classified.type,
      error: classified.message,
      durationMs,
    });

    if (classified.type === "context_overflow") {
      return new Response(
        JSON.stringify({
          ...formatErrorResponse(classified),
          error: "Context too large. Please try sending a shorter message or start a new conversation.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const statusMap: Record<string, number> = {
      rate_limit: 429,
      quota_exceeded: 429,
      auth: 401,
      context_overflow: 400,
      network: 502,
      provider_error: 502,
      unknown: 500,
    };

    return new Response(
      JSON.stringify(formatErrorResponse(classified)),
      {
        status: statusMap[classified.type] || 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
