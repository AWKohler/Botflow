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
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

import { requireProjectAccess } from "@/lib/project-access";
import { getUserCredentials } from "@/lib/user-credentials";
import { getFreshAnthropicAccessToken } from "@/lib/anthropic-oauth";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import { resolveModelId, MODEL_CONFIGS, isAnthropicModel } from "@/lib/agent/models";
import { isSandboxPlatform } from "@/lib/project-platform";
import { swiftProjectForbidden } from "@/lib/swift-access";

import { isClaudeCodeFlagEnabled } from "@/lib/agent/claude-code/feature-flag";
import { REVENUECAT_ENABLED, STRIPE_CONNECT_ENABLED } from "@/lib/feature-flags";
import { OAUTH_PROVIDER_IDS } from "@/lib/oauth-providers/registry";
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
import {
  mintLlmProxyToken,
  revokeLlmProxyToken,
  llmProxyOrigin,
} from "@/lib/agent/llm-proxy/token";
import { OPENCODE_BACKEND_ENABLED } from "@/lib/feature-flags";
import { recordTokenUsage } from "@/lib/usage";
import {
  buildPrepareTurnScript,
  turnEventFile,
  BRIDGE_PID_FILE,
} from "@/lib/agent/claude-code/bridge-control";
import {
  getTurnRecord,
  setTurnRecord,
  markTurnEnded,
  markTurnDead,
} from "@/lib/agent/claude-code/turn-registry";
import { enforce, identifierFor } from "@/lib/rate-limit";
import { sharedTurnBlockReason } from "@/lib/sharing";
import {
  fallbackResponse as fallback,
  jsonError,
  extractCurrentUserText,
  extractCurrentUserMessageId,
  extractCurrentUserImageParts,
  fetchPromptImages,
  buildPriorConversationPreamble,
} from "@/lib/agent/turn-input";
import { selectHostTools } from "@/lib/agent/host-tools/definitions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface RequestBody {
  messages: UIMessage[];
  projectId?: string;
  platform?: string;
}

export async function POST(req: Request) {
  if (!isClaudeCodeFlagEnabled()) {
    return fallback("flag_disabled");
  }

  const { userId } = await auth();
  if (!userId) return jsonError(401, "Unauthorized");

  // Per-user request-rate guard. This is the most expensive path (spawns a
  // claude subprocess in a per-project sandbox, mints a tool-callback token,
  // streams for up to maxDuration). No credit reservation here, so this is the
  // primary burst guard against repeated sandbox spawns.
  const blocked = await enforce(identifierFor(userId, req), "claudeCode");
  if (blocked) return blocked;

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
  // Replay guard: every legitimate Claude Code turn is initiated by a new
  // user message, so the array must END with one. A trailing assistant
  // message means an automatic client resubmit (e.g. useChat's
  // sendAutomaticallyWhen); rejecting it here stops the agent from being
  // re-triggered without new user input, which would loop the agent (and burn
  // the user's subscription) indefinitely.
  if (messages[messages.length - 1]?.role !== "user") {
    return jsonError(409, "Last message must be a user message");
  }
  if (!projectId) {
    return jsonError(400, "projectId required");
  }
  if (!platform || !isSandboxPlatform(platform)) {
    return fallback("non_sandbox_platform");
  }

  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return jsonError(404, "Project not found");
  }
  const { project } = access;
  // Swift's runtime is beta-only. Gate on the STORED platform (not the request
  // param) so a non-beta owner of a legacy swift project can't drive the agent's
  // sandbox tools — and can't mint the tool token the internal tool route trusts.
  if (await swiftProjectForbidden(project)) {
    return jsonError(403, "Swift projects are currently in private beta.");
  }

  // Sharing (Phase 3): one live agent per project across ALL collaborators —
  // never kill another user's bridge; tell this user to wait instead.
  const sharedBlock = await sharedTurnBlockReason(projectId, userId);
  if (sharedBlock) {
    return jsonError(409, sharedBlock);
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
    // Tier is fetched lazily — only matters for the platform-key fallback
    // which never picks claude-code anyway.
  });
  if (derived.backend !== "claude-code") {
    return fallback(derived.reason);
  }
  if (!derived.runnable) {
    return fallback(derived.reason);
  }

  const userPrompt = extractCurrentUserText(messages);
  // Pull any images attached to the current message and resolve them to base64
  // so the bridge can relay them to the model. Without this they're silently
  // dropped (text-only extraction ignores file parts) — the model never sees
  // them, which is exactly the "images aren't sent" bug on the Claude Code path.
  const imageParts = extractCurrentUserImageParts(messages);
  const images = imageParts.length ? await fetchPromptImages(imageParts) : [];
  if (!userPrompt && images.length === 0) {
    return jsonError(400, "No user text or image in last message");
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

  // Hoisted above the credential write: the proxy token binds to this turn.
  const turnId = Math.random().toString(36).slice(2, 10);

  // ── Credential surface ────────────────────────────────────────────────────
  // Flag ON: the sandbox gets a bfap_ proxy token instead of the real
  // credential — Claude Code sends it to /api/internal/llm-proxy/anthropic,
  // which injects the real OAuth token / API key server-side (and refreshes
  // OAuth mid-turn there). Sharing-readiness: co-tenants with sandbox shell
  // access can never read a usable Anthropic credential. Flag OFF: legacy
  // real-credential path, byte-identical to before the proxy existed.
  const llmProxyToken = OPENCODE_BACKEND_ENABLED
    ? await mintLlmProxyToken({
        userId,
        projectId,
        turnId,
        provider: "anthropic",
        credMode: oauthToken ? "oauth" : "byok",
        modelId: selectedModel,
        // Advisory in personal modes — Claude Code legitimately calls
        // Haiku-class background models on the user's own credential.
        modelAllowlist: [MODEL_CONFIGS[selectedModel].apiModelId],
      })
    : null;

  // ── Sandbox setup (idempotent, fast on warm boots) ───────────────────────
  const installResult = await ensureClaudeInstalled(projectId);
  if (!installResult.ok) {
    return jsonError(500, installResult.error);
  }

  if (llmProxyToken) {
    await writeClaudeCredentials(
      projectId,
      oauthToken
        ? {
            // OAuth shape: the CLI treats the proxy token as its access
            // token. Far-future expiry so it never attempts its own refresh
            // (the proxy refreshes the REAL token server-side).
            accessToken: llmProxyToken,
            expiresAt: Date.now() + 60 * 60 * 1000,
          }
        : { apiKey: llmProxyToken },
    );
  } else {
    await writeClaudeCredentials(projectId, {
      accessToken: oauthToken,
      refreshToken: creds.claudeOAuthRefreshToken,
      expiresAt: creds.claudeOAuthExpiresAt,
      apiKey: creds.anthropicApiKey,
    });
  }

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
  // /api/internal/claude-code-tool). Gating is shared with the OpenCode route
  // via selectHostTools so the two agents' tool surfaces can't drift.
  const customTools = selectHostTools({
    platform,
    hasBackend,
    hasGithub: Boolean(project.githubRepoOwner && project.githubRepoName),
    stripeEnabled: STRIPE_CONNECT_ENABLED,
    revenuecatEnabled: REVENUECAT_ENABLED,
  });

  const bridgeConfig = {
    prompt,
    ...(images.length ? { images } : {}),
    ...(sessionId ? { sessionId } : {}),
    model: MODEL_CONFIGS[selectedModel].apiModelId,
    cwd: "/vercel/sandbox",
    appendSystemPrompt,
    ...(customTools.length ? { customTools } : {}),
    ...(customTools.includes("setup_oauth_provider")
      ? { oauthProviderIds: OAUTH_PROVIDER_IDS }
      : {}),
  };

  const configPath = `/tmp/.botflow-claude-config-${turnId}.json`;
  const eventFile = turnEventFile(turnId);

  const sandbox = await getOrCreatePersistentSandbox(projectId);

  // ── One bridge per project ────────────────────────────────────────────────
  // The bridge runs detached, so a maxDuration-killed route leaves it alive
  // (by design — see the reattach route). But a NEW turn must never race the
  // previous one in the same sandbox: kill the old bridge (its SIGTERM handler
  // interrupts the claude subprocess), revoke its tool token, sweep stale turn
  // artifacts, and pre-create the new event file so tail -f attaches cleanly.
  const prevTurn = await getTurnRecord(projectId).catch(() => null);
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", buildPrepareTurnScript(eventFile)],
  });
  if (prevTurn?.toolToken) {
    revokeToolToken(prevTurn.toolToken).catch(() => {});
  }
  if (prevTurn?.llmProxyToken) {
    revokeLlmProxyToken(prevTurn.llmProxyToken).catch(() => {});
  }

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
    BOTFLOW_EVENT_FILE: eventFile,
    BOTFLOW_PID_FILE: BRIDGE_PID_FILE,
  };
  if (toolToken) {
    bridgeEnv.BOTFLOW_API_BASE = new URL(req.url).origin;
    bridgeEnv.BOTFLOW_TOOL_TOKEN = toolToken;
    // On protected preview deployments the host-tool callback would otherwise
    // die on Vercel's Deployment Protection wall (401 before our route runs) —
    // every host tool (setup_auth, convex_deploy, ask_question, …) fails.
    if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
      bridgeEnv.BOTFLOW_VERCEL_BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    }
  }
  if (llmProxyToken) {
    bridgeEnv.ANTHROPIC_BASE_URL = `${llmProxyOrigin(new URL(req.url).origin)}/api/internal/llm-proxy/anthropic`;
    if (!oauthToken) {
      // BYOK shape rides the env var (takes precedence over the credentials
      // file); the value is the proxy token, never the real key.
      bridgeEnv.ANTHROPIC_API_KEY = llmProxyToken;
    }
    // Preview deployments answer cookie-less requests with the Deployment
    // Protection HTML page — same wall the MCP callbacks hit. The CLI
    // forwards ANTHROPIC_CUSTOM_HEADERS on every API request.
    if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
      bridgeEnv.ANTHROPIC_CUSTOM_HEADERS = `x-vercel-protection-bypass: ${process.env.VERCEL_AUTOMATION_BYPASS_SECRET}`;
    }
  } else if (oauthToken) {
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

  // Register the turn so later requests can find it: the reattach route tails
  // its event file after this route dies at maxDuration, and the next turn's
  // spawn (or the stop route) kills the bridge + revokes the token.
  const spawningUserMessageId = extractCurrentUserMessageId(messages);
  await setTurnRecord(projectId, {
    turnId,
    userId,
    backend: "claude-code",
    ...(spawningUserMessageId ? { userMessageId: spawningUserMessageId } : {}),
    eventFile,
    startedAt: Date.now(),
    ...(toolToken ? { toolToken } : {}),
    ...(llmProxyToken ? { llmProxyToken } : {}),
  }).catch(() => {});

  // Turn marker: proxied usage rows are per-REQUEST (countTurn:false at the
  // proxy), so the turn itself is counted once here — this also brings CC
  // turns into usage_records for the first time (zero tokens, zero credits).
  if (llmProxyToken) {
    recordTokenUsage(userId, selectedModel, 0, 0, 0, 0, 0).catch(() => {});
  }

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
              // Persist EAGERLY — the `finally` below never runs when the
              // platform hard-kills this route at maxDuration, and losing the
              // session pointer forces the continuation turn to start a fresh
              // session and rediscover all its context.
              setClaudeCodeSessionId(projectId, event.sessionId).catch(() => {});
            }
            translator.push(event);
            if (event.type === "end_turn") {
              endedNormally = true;
              markTurnEnded(projectId, turnId).catch(() => {});
              break;
            }
            if (event.type === "error") {
              // The bridge emits `error` only when it's exiting — mark the
              // turn dead so the client falls back to a fresh continuation
              // instead of trying to reattach to a corpse.
              markTurnDead(projectId, turnId).catch(() => {});
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
          // Backstop persist (the eager write above already ran on the happy
          // path; this covers exotic orderings). Non-fatal.
          try {
            await setClaudeCodeSessionId(projectId, lastSessionIdSeen);
          } catch {
            // Non-fatal.
          }
        }
        // Deliberately NO token revocation here: the bridge runs detached and
        // legitimately outlives this route (maxDuration kill, client
        // disconnect) — revoking on stream teardown would cut off a live
        // turn's tool access mid-flight. The token TTL slides on use and is
        // revoked explicitly by the next turn's spawn or the stop route.
        //
        // Config cleanup only on a NORMAL end — on an early teardown the
        // bridge may not have read it yet. Stale configs are swept by the
        // next turn's prepare script.
        if (endedNormally) {
          sandbox
            .runCommand({ cmd: "sh", args: ["-c", `rm -f ${configPath}`] })
            .catch(() => {});
        }
      }
    },
    onError: (err) => (err instanceof Error ? err.message : String(err)),
  });

  return createUIMessageStreamResponse({ stream });
}
