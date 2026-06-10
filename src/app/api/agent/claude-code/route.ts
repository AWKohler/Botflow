/**
 * /api/agent/claude-code
 *
 * The Claude Code agent path. Drives an actual `claude` subprocess inside the
 * user's Vercel Sandbox via @anthropic-ai/claude-agent-sdk. The user's
 * Anthropic OAuth tokens (or BYOK API key) are written into the sandbox at
 * ~/.claude/.credentials.json — Anthropic only ever sees traffic from a real
 * Claude Code process, never from us directly.
 *
 * The browser-side AgentPanel posts here when shouldUseClaudeCode() returns
 * true. When activation conditions fail (no creds, wrong platform, flag off),
 * we return 412 Precondition Failed with a `fallback: true` body so the client
 * can transparently retry against /api/agent.
 */
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getUserCredentials } from "@/lib/user-credentials";
import { getFreshAnthropicAccessToken } from "@/lib/anthropic-oauth";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import { resolveModelId, MODEL_CONFIGS, isAnthropicModel } from "@/lib/agent/models";
import { isSandboxPlatform } from "@/lib/project-platform";
import { swiftRuntimeForbidden } from "@/lib/swift-access";

import { isClaudeCodeFlagEnabled } from "@/lib/agent/claude-code/feature-flag";
import { STRIPE_CONNECT_ENABLED } from "@/lib/feature-flags";
import { deriveAgentBackend } from "@/lib/agent/derive-backend";
import {
  ensureClaudeInstalled,
  writeClaudeCredentials,
  writeBridgeScript,
  resolveSandboxPaths,
} from "@/lib/agent/claude-code/setup";
import { buildClaudeCodeAppendPrompt } from "@/lib/agent/claude-code/system-prompt";
import {
  getClaudeCodeSessionId,
  setClaudeCodeSessionId,
} from "@/lib/agent/claude-code/session-store";
import { createTranslator, type BridgeEvent } from "@/lib/agent/claude-code/translator";
import { mintToolToken, revokeToolToken } from "@/lib/agent/claude-code/tool-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface RequestBody {
  messages: UIMessage[];
  projectId?: string;
  platform?: string;
}

function fallback(reason: string): Response {
  // 412 + a structured body. The client AgentPanel inspects status === 412
  // and retries against /api/agent.
  return new Response(JSON.stringify({ fallback: true, reason }), {
    status: 412,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Pull the user's most recent text from a UIMessage array. */
function extractUserPrompt(messages: UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts ?? [];
    const texts: string[] = [];
    for (const p of parts) {
      if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
    }
    if (texts.length === 0) continue;
    return texts.join("\n");
  }
  return null;
}

/**
 * Build a text preamble summarizing prior conversation turns so a fresh
 * Claude Code session has the context it needs to pick up coherently mid-
 * conversation (e.g., after the user switched from Botflow to Claude Code).
 *
 * We include only user/assistant TEXT — no foreign tool_use blocks (claude
 * would have no way to interpret them) and no thinking/reasoning parts. The
 * model can reconstruct anything else by reading the current filesystem.
 *
 * Returns null when there's no prior content worth preambling (just the
 * current user message, or empty history).
 */
function buildPriorConversationPreamble(messages: UIMessage[]): string | null {
  // The LAST message is the user's current prompt — we exclude it.
  if (messages.length <= 1) return null;
  const prior = messages.slice(0, -1);
  const lines: string[] = [];
  for (const m of prior) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const parts = m.parts ?? [];
    const texts: string[] = [];
    for (const p of parts) {
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
        texts.push(p.text);
      }
    }
    if (texts.length === 0) continue;
    const role = m.role === "user" ? "User" : "Assistant";
    // Keep each prior turn's text capped so a long history doesn't blow
    // the preamble budget. Generous cap — 4k chars per turn.
    let combined = texts.join("\n").trim();
    if (combined.length > 4000) {
      combined = combined.slice(0, 4000) + "…[truncated]";
    }
    lines.push(`${role}: ${combined}`);
  }
  if (lines.length === 0) return null;
  return lines.join("\n\n");
}

export async function POST(req: Request) {
  if (!isClaudeCodeFlagEnabled()) {
    return fallback("flag_disabled");
  }

  const { userId } = await auth();
  if (!userId) return jsonError(401, "Unauthorized");

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const { messages, projectId, platform } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonError(400, "messages array required");
  }
  if (!projectId) {
    return jsonError(400, "projectId required");
  }
  if (!platform || !isSandboxPlatform(platform)) {
    return fallback("non_sandbox_platform");
  }

  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== userId) {
    return jsonError(404, "Project not found");
  }
  // Swift's runtime is beta-only. Gate on the STORED platform (not the request
  // param) so a non-beta owner of a legacy swift project can't drive the agent's
  // sandbox tools — and can't mint the tool token the internal tool route trusts.
  if (await swiftRuntimeForbidden(project.platform, userId)) {
    return jsonError(403, "Swift projects are currently in private beta.");
  }

  const selectedModel = resolveModelId(project.model);
  if (!isAnthropicModel(selectedModel)) {
    return fallback("non_anthropic_model");
  }

  const creds = await getUserCredentials(userId);
  // Single source of truth: re-derive the backend server-side from the current
  // model + platform + creds. If the derivation doesn't pick Claude Code,
  // fall back to /api/agent so the client retries against the correct route.
  // This makes the routing decision tamper-proof: a client can't request
  // Claude Code if their creds don't actually support it.
  const derived = deriveAgentBackend({
    model: selectedModel,
    platform,
    creds: {
      hasClaudeOAuth: Boolean(creds.claudeOAuthAccessToken),
      hasAnthropicKey: Boolean(creds.anthropicApiKey),
    },
    preferredAnthropicBackend: creds.preferredAnthropicBackend,
    // Tier is fetched lazily — only matters for the platform-key fallback
    // which never picks claude-code anyway.
  });
  if (derived.backend !== "claude-code") {
    return fallback(derived.reason);
  }
  if (!derived.runnable) {
    return fallback(derived.reason);
  }

  const userPrompt = extractUserPrompt(messages);
  if (!userPrompt) {
    return jsonError(400, "No user text in last message");
  }

  // Build a prior-conversation preamble so the model has context if this turn
  // is part of an ongoing conversation (e.g., the user just switched from
  // Botflow). When there's no resume sessionId (which is the case after a
  // backend switch, since we wipe the session pointer), this preamble is what
  // keeps continuity. When resuming a Claude Code session, the SDK already
  // has the full transcript, so the preamble is mostly redundant — but
  // harmless and cheap.
  const preamble = buildPriorConversationPreamble(messages);
  const prompt = preamble
    ? `[Prior conversation context — earlier turns from this session. The project filesystem reflects everything that happened.]\n\n${preamble}\n\n[End of context. The user's current message:]\n\n${userPrompt}`
    : userPrompt;

  // Refresh the OAuth token if near expiry, else use the existing one. If both
  // OAuth refresh and OAuth presence fail, fall back to the BYOK API key.
  const oauthToken = await getFreshAnthropicAccessToken(
    {
      claudeOAuthAccessToken: creds.claudeOAuthAccessToken,
      claudeOAuthRefreshToken: creds.claudeOAuthRefreshToken,
      claudeOAuthExpiresAt: creds.claudeOAuthExpiresAt,
    },
    userId,
  );

  if (!oauthToken && !creds.anthropicApiKey) {
    return fallback("no_anthropic_credentials");
  }

  // ── Sandbox setup (idempotent, fast on warm boots) ───────────────────────
  const installResult = await ensureClaudeInstalled(projectId);
  if (!installResult.ok) {
    return jsonError(500, installResult.error);
  }

  await writeClaudeCredentials(projectId, {
    accessToken: oauthToken,
    refreshToken: creds.claudeOAuthRefreshToken,
    expiresAt: creds.claudeOAuthExpiresAt,
    apiKey: creds.anthropicApiKey,
  });

  await writeBridgeScript(projectId);

  // ── Build the bridge config and drop it as a file in the sandbox ─────────
  const sessionId = await getClaudeCodeSessionId(projectId);
  const hasBackend = project.backendType !== "none";

  const appendSystemPrompt = buildClaudeCodeAppendPrompt({
    platform: platform as "sandboxed-web" | "swift",
    hasBackend,
    hasConvexEnv: hasBackend && Boolean(project.userConvexUrl || project.convexDeployUrl),
  });

  // Tools whose execution stays on our server (the bridge calls back via
  // /api/internal/claude-code-tool). Workspace control tools (dev server
  // lifecycle + browser/dev logs) are always available on sandboxed-web —
  // they don't depend on backend type. `convex_deploy` is gated on hasBackend
  // because its deploy key must never enter the sandbox env.
  const customTools: string[] = [];
  if (platform === "sandboxed-web") {
    customTools.push(
      "startDevServer",
      "stopDevServer",
      "isDevServerRunning",
      "getDevServerLog",
      "getBrowserLog",
      "refreshPreview",
      // In-chat question primitive — always available on sandboxed-web.
      "ask_question",
      // Env-var entry modal — agent picks the name, user types the value.
      "request_env_var",
    );
    if (hasBackend) {
      customTools.push(
        "convex_deploy",
        "get_convex_logs",
        "list_convex_tables",
        "read_convex_table",
        "write_convex_data",
      );
      if (STRIPE_CONNECT_ENABLED) {
        customTools.push(
          "initialize_stripe_payments",
          "get_stripe_products",
          "create_stripe_product",
        );
      }
    }
    // Git tools — only when a repo is linked. Gating must match the project
    // state at turn-start; the host route also re-checks at execution time.
    if (project.githubRepoOwner && project.githubRepoName) {
      customTools.push(
        "git_status",
        "git_diff",
        "git_commit",
        "git_push",
        "git_pull",
        "git_resolve_conflict",
        "set_git_autonomy",
        "open_pull_request",
      );
    }
  }

  const bridgeConfig = {
    prompt,
    ...(sessionId ? { sessionId } : {}),
    model: MODEL_CONFIGS[selectedModel].apiModelId,
    cwd: "/vercel/sandbox",
    appendSystemPrompt,
    ...(customTools.length ? { customTools } : {}),
  };

  const turnId = Math.random().toString(36).slice(2, 10);
  const configPath = `/tmp/.botflow-claude-config-${turnId}.json`;

  const sandbox = await getOrCreatePersistentSandbox(projectId);
  await sandbox.writeFiles([
    {
      path: configPath,
      content: Buffer.from(JSON.stringify(bridgeConfig), "utf-8"),
    },
  ]);

  // Mint a per-turn bearer token so the bridge can call back to our internal
  // tool endpoint without holding a Clerk session.
  const toolToken = customTools.length
    ? await mintToolToken({ userId, projectId })
    : null;

  // ── Spawn the bridge ────────────────────────────────────────────────────
  const bridgeEnv: Record<string, string> = {
    BOTFLOW_CONFIG_PATH: configPath,
  };
  if (toolToken) {
    bridgeEnv.BOTFLOW_API_BASE = new URL(req.url).origin;
    bridgeEnv.BOTFLOW_TOOL_TOKEN = toolToken;
  }
  if (oauthToken) {
    // When OAuth is available, claude reads it from ~/.claude/.credentials.json
    // (already written above). We deliberately do NOT set ANTHROPIC_API_KEY in
    // that case — having it set takes precedence over the credentials file.
  } else if (creds.anthropicApiKey) {
    bridgeEnv.ANTHROPIC_API_KEY = creds.anthropicApiKey;
  }

  const paths = await resolveSandboxPaths(projectId);
  const cmd = await sandbox.runCommand({
    cmd: "node",
    args: [paths.bridgePath],
    cwd: "/vercel/sandbox",
    env: bridgeEnv,
    detached: true,
  });

  // ── Stream stdout NDJSON → AI SDK UIMessageStream ───────────────────────
  const stream = createUIMessageStream<UIMessage>({
    execute: async ({ writer }) => {
      const translator = createTranslator(writer);
      let buffer = "";
      let lastSessionIdSeen: string | null = null;
      let endedNormally = false;

      try {
        for await (const log of cmd.logs()) {
          if (log.stream !== "stdout") continue;
          buffer += log.data;
          // Split on newline; keep the trailing partial line in buffer.
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            let event: BridgeEvent;
            try {
              event = JSON.parse(line) as BridgeEvent;
            } catch {
              // Treat unparseable lines as stderr-like noise; surface as an
              // error chunk and continue.
              writer.write({ type: "error", errorText: `Unparseable bridge output: ${line.slice(0, 200)}` } satisfies UIMessageChunk);
              continue;
            }
            if (event.type === "session_started") {
              lastSessionIdSeen = event.sessionId;
            }
            translator.push(event);
            if (event.type === "end_turn") {
              endedNormally = true;
              break;
            }
            if (event.type === "error") {
              break;
            }
          }
          if (endedNormally) break;
        }
      } catch (err) {
        translator.push({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        translator.end();
        if (lastSessionIdSeen) {
          // Persist the session id so the next turn resumes.
          try {
            await setClaudeCodeSessionId(projectId, lastSessionIdSeen);
          } catch {
            // Non-fatal.
          }
        }
        // Best-effort: revoke the tool-callback token + delete the config file.
        if (toolToken) {
          revokeToolToken(toolToken).catch(() => {});
        }
        sandbox
          .runCommand({ cmd: "sh", args: ["-c", `rm -f ${configPath}`] })
          .catch(() => {});
      }
    },
    onError: (err) => (err instanceof Error ? err.message : String(err)),
  });

  return createUIMessageStreamResponse({ stream });
}
