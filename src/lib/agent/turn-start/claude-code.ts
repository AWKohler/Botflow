/**
 * Claude Code turn starter. Drives an actual `claude` subprocess inside the
 * project's sandbox via @anthropic-ai/claude-agent-sdk. The sandbox holds only
 * a turn-scoped LLM-proxy token; the proxy injects the user's real Anthropic
 * OAuth token (or BYOK API key) server-side, so Anthropic only ever sees
 * traffic from a real Claude Code process.
 *
 * Used by /api/agent/claude-code (which streams the turn) and the thread
 * queue drain (which starts queued turns server-side). When the turn can't
 * run it returns the refusal response — there is no fallback agent.
 */
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

import {
  getUserCredentials,
} from "@/lib/user-credentials";
import {
  getFreshAnthropicAccessToken,
} from "@/lib/anthropic-oauth";
import {
  getOrCreatePersistentSandbox,
} from "@/lib/vercel-sandbox";
import {
  MODEL_CONFIGS,
  isAnthropicModel,
} from "@/lib/agent/models";

import {
  REVENUECAT_ENABLED,
  STRIPE_CONNECT_ENABLED,
} from "@/lib/feature-flags";
import {
  OAUTH_PROVIDER_IDS,
} from "@/lib/oauth-providers/registry";
import {
  deriveAgentBackend,
} from "@/lib/agent/derive-backend";
import {
  ensureClaudeInstalled,
  writeBridgeScript,
  resolveSandboxPaths,
} from "@/lib/agent/claude-code/setup";
import {
  buildClaudeCodeAppendPrompt,
} from "@/lib/agent/claude-code/system-prompt";
import {
  getClaudeCodeSessionId,
  setClaudeCodeSessionId,
} from "@/lib/agent/claude-code/session-store";
import {
  createTranslator,
  type BridgeEvent,
} from "@/lib/agent/claude-code/translator";
import {
  mintToolToken,
  revokeToolToken,
} from "@/lib/agent/claude-code/tool-token";
import {
  mintLlmProxyToken,
  revokeLlmProxyToken,
  llmProxyOrigin,
} from "@/lib/agent/llm-proxy/token";
import {
  recordTokenUsage,
} from "@/lib/usage";
import {
  buildPrepareTurnScript,
  parseCapacityRefusal,
  parseThreadBusy,
  threadPidFile,
  turnEventFile,
} from "@/lib/agent/claude-code/bridge-control";
import {
  getTurnRecord,
  setTurnRecord,
  markTurnEnded,
  markTurnDead,
} from "@/lib/agent/claude-code/turn-registry";
import {
  awarenessNote,
  ensureThreadSegment,
  noteTurnStarted,
  otherRunningThreadTitles,
  setTitleIfEmpty,
  threadModel,
} from "@/lib/agent/threads";
import {
  assistantMessageIdForTurn,
  saveUserMessage,
} from "@/lib/agent/turn-persistence";
import {
  agentUnavailableResponse,
  capacityResponse,
  jsonError,
  threadBusyResponse,
  extractCurrentUserText,
  extractCurrentUserMessageId,
  extractCurrentUserImageParts,
  fetchPromptImages,
  buildPriorConversationPreamble,
} from "@/lib/agent/turn-input";
import {
  selectHostTools,
} from "@/lib/agent/host-tools/definitions";
import type { TurnStartContext, TurnStartResult } from "./types";
import { acquireThreadSpawnLock, releaseThreadSpawnLock } from "./spawn-lock";

/**
 * Start one turn on this agent in a thread: derive and check credentials,
 * prepare the sandbox, admit against capacity, spawn the detached bridge and
 * register the turn. Called by the agent route (which streams the result) and
 * by the thread queue drain (which doesn't). Never throws for expected
 * refusals — they come back as `{ ok: false, response }`.
 */
export async function startClaudeCodeTurn(ctx: TurnStartContext): Promise<TurnStartResult> {
  const { userId, projectId, platform, messages, project, thread, origin } = ctx;
  const threadId = thread.id;

  const selectedModel = threadModel(thread, project);
  if (!isAnthropicModel(selectedModel)) {
    return { ok: false, response: agentUnavailableResponse("backend_mismatch") };
  }

  const creds = await getUserCredentials(userId);
  // Single source of truth: re-derive the backend server-side from the current
  // model + platform + creds. If the derivation doesn't pick Claude Code the
  // client's credential snapshot is stale — refuse rather than guess. This
  // makes the routing decision tamper-proof: a client can't request Claude
  // Code if their creds don't actually support it.
  const derived = deriveAgentBackend({
    model: selectedModel,
    platform,
    creds: {
      hasClaudeOAuth: Boolean(creds.claudeOAuthAccessToken),
      hasAnthropicKey: Boolean(creds.anthropicApiKey),
    },
    // No tier: it only gates platform-mode (OpenCode) models, never
    // Claude Code.
  });
  if (derived.backend !== "claude-code") {
    return { ok: false, response: agentUnavailableResponse("backend_mismatch") };
  }
  if (!derived.runnable) {
    return { ok: false, response: agentUnavailableResponse(derived.reason) };
  }

  const userPrompt = extractCurrentUserText(messages);
  // Pull any images attached to the current message and resolve them to base64
  // so the bridge can relay them to the model. Without this they're silently
  // dropped (text-only extraction ignores file parts) — the model never sees
  // them, which is exactly the "images aren't sent" bug on the Claude Code path.
  const imageParts = extractCurrentUserImageParts(messages);
  const images = imageParts.length ? await fetchPromptImages(imageParts) : [];
  if (!userPrompt && images.length === 0) {
    return { ok: false, response: jsonError(400, "No user text or image in last message") };
  }

  // Build a prior-conversation preamble so the model has context if this turn
  // is part of an ongoing conversation (e.g., the user just switched from
  // OpenCode). When there's no resume sessionId (which is the case after a
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
    return { ok: false, response: agentUnavailableResponse("no_anthropic_credentials") };
  }

  // Hoisted above the credential write: the proxy token binds to this turn.
  const turnId = Math.random().toString(36).slice(2, 10);

  // ── Credential surface ────────────────────────────────────────────────────
  // The sandbox gets a bfap_ proxy token instead of the real credential —
  // Claude Code sends it to /api/internal/llm-proxy/anthropic, which injects
  // the real OAuth token / API key server-side (and refreshes OAuth mid-turn
  // there). Sharing-readiness: co-tenants with sandbox shell access can never
  // read a usable Anthropic credential.
  const llmProxyToken = await mintLlmProxyToken({
    userId,
    projectId,
    turnId,
    provider: "anthropic",
    credMode: oauthToken ? "oauth" : "byok",
    modelId: selectedModel,
    // Advisory in personal modes — Claude Code legitimately calls
    // Haiku-class background models on the user's own credential.
    modelAllowlist: [MODEL_CONFIGS[selectedModel].apiModelId],
  });

  // ── Sandbox setup (idempotent, fast on warm boots) ───────────────────────
  const installResult = await ensureClaudeInstalled(projectId);
  if (!installResult.ok) {
    return { ok: false, response: jsonError(500, installResult.error) };
  }

  await writeBridgeScript(projectId);

  // ── Build the bridge config and drop it as a file in the sandbox ─────────
  const sessionId = await getClaudeCodeSessionId(threadId);
  const segmentId = await ensureThreadSegment(thread);
  // Convex-specific tools/prompt gate on this — MuhKoo has a backend but no
  // Convex deploy/logs/table tools (mirrors projectUsesConvex).
  const usesConvex =
    project.backendType === "platform" || project.backendType === "user";
  const usesMuhkoo = project.backendType === "muhkoo";

  // Other threads' live agents share this sandbox — say so, so this agent
  // re-reads before editing and stays on its own task.
  const otherAgents = awarenessNote(await otherRunningThreadTitles(projectId, threadId).catch(() => []));
  const appendSystemPrompt = [
    buildClaudeCodeAppendPrompt({
      platform: platform as "sandboxed-web" | "swift",
      hasBackend: usesConvex,
      usesMuhkoo,
      hasConvexEnv: usesConvex && Boolean(project.userConvexUrl || project.convexDeployUrl),
    }),
    otherAgents,
  ].filter(Boolean).join("\n\n");

  // Tools whose execution stays on our server (the bridge calls back via
  // /api/internal/claude-code-tool). Gating is shared with the OpenCode route
  // via selectHostTools so the two agents' tool surfaces can't drift.
  const customTools = selectHostTools({
    platform,
    usesConvex,
    usesMuhkoo,
    hasGithub: Boolean(project.githubRepoOwner && project.githubRepoName),
    stripeEnabled: STRIPE_CONNECT_ENABLED,
    revenuecatEnabled: REVENUECAT_ENABLED,
  });

  const bridgeConfig = {
    prompt,
    ...(images.length ? { images } : {}),
    ...(sessionId ? { sessionId } : {}),
    model: MODEL_CONFIGS[selectedModel].apiModelId,
    ...(MODEL_CONFIGS[selectedModel].effort ? { effort: MODEL_CONFIGS[selectedModel].effort } : {}),
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

  // ── One bridge per THREAD ─────────────────────────────────────────────────
  // The bridge runs detached, so a maxDuration-killed route leaves it alive
  // (by design — see the reattach route). A new turn in this thread must never
  // race the thread's previous one: kill that bridge (its SIGTERM handler
  // interrupts the claude subprocess), revoke its tokens, sweep stale turn
  // artifacts, admit against sandbox capacity, and pre-create the new event
  // file so tail -f attaches cleanly. Other threads' bridges keep running.
  if (!(await acquireThreadSpawnLock(threadId))) {
    revokeLlmProxyToken(llmProxyToken).catch(() => {});
    return { ok: false, response: threadBusyResponse() };
  }
  const prevTurn = await getTurnRecord(projectId, threadId).catch(() => null);
  const prepared = await sandbox.runCommand({
    cmd: "sh",
    // Pre-threads turns wrote the proxy token to a shared credentials file;
    // OAuth now rides CLAUDE_CODE_OAUTH_TOKEN per process, so drop the stale
    // file before it can shadow anything.
    args: ["-c", `rm -f "$HOME/.claude/.credentials.json"\n${buildPrepareTurnScript(threadId, eventFile)}`],
  });
  const preparedOut = await prepared.stdout();
  if (parseThreadBusy(preparedOut)) {
    await releaseThreadSpawnLock(threadId);
    revokeLlmProxyToken(llmProxyToken).catch(() => {});
    return { ok: false, response: threadBusyResponse() };
  }
  const refusal = parseCapacityRefusal(preparedOut);
  if (refusal) {
    await releaseThreadSpawnLock(threadId);
    revokeLlmProxyToken(llmProxyToken).catch(() => {});
    return { ok: false, response: capacityResponse(refusal.running) };
  }
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
  // tool endpoint — and report the turn's end for the server-side save —
  // without holding a user session.
  const toolToken = await mintToolToken({
    userId,
    projectId,
    threadId,
    turnId,
    backend: "claude-code",
    segmentId,
  });

  // ── Spawn the bridge ────────────────────────────────────────────────────
  const bridgeEnv: Record<string, string> = {
    BOTFLOW_CONFIG_PATH: configPath,
    BOTFLOW_EVENT_FILE: eventFile,
    BOTFLOW_PID_FILE: threadPidFile(threadId),
    BOTFLOW_API_BASE: origin,
    BOTFLOW_TOOL_TOKEN: toolToken,
    BOTFLOW_TURN_TOKEN: toolToken,
  };
  // On protected preview deployments the host-tool callback would otherwise
  // die on Vercel's Deployment Protection wall (401 before our route runs) —
  // every host tool (setup_auth, convex_deploy, ask_question, …) fails.
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    bridgeEnv.BOTFLOW_VERCEL_BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  bridgeEnv.ANTHROPIC_BASE_URL = `${llmProxyOrigin(origin)}/api/internal/llm-proxy/anthropic`;
  // The proxy token rides the process env in BOTH shapes — never a shared
  // file — so concurrent threads' agents can't read each other's turn token.
  // OAuth: the CLI sends it as a bearer with the OAuth beta header (the proxy
  // refreshes the REAL token server-side). BYOK: sent as the API key.
  if (oauthToken) {
    bridgeEnv.CLAUDE_CODE_OAUTH_TOKEN = llmProxyToken;
  } else {
    bridgeEnv.ANTHROPIC_API_KEY = llmProxyToken;
  }
  // Preview deployments answer cookie-less requests with the Deployment
  // Protection HTML page — same wall the MCP callbacks hit. The CLI
  // forwards ANTHROPIC_CUSTOM_HEADERS on every API request.
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    bridgeEnv.ANTHROPIC_CUSTOM_HEADERS = `x-vercel-protection-bypass: ${process.env.VERCEL_AUTOMATION_BYPASS_SECRET}`;
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
    threadId,
    userId,
    backend: "claude-code",
    ...(spawningUserMessageId ? { userMessageId: spawningUserMessageId } : {}),
    eventFile,
    startedAt: Date.now(),
    toolToken,
    llmProxyToken,
  }).catch(() => {});
  await releaseThreadSpawnLock(threadId);

  // Thread bookkeeping: status/ordering, a title from the first prompt, and
  // the prompt itself saved server-side (attributed to its author).
  await noteTurnStarted(threadId).catch(() => {});
  if (userPrompt) await setTitleIfEmpty(thread, userPrompt).catch(() => {});
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === "user") {
    await saveUserMessage(threadId, segmentId, lastMessage, userId).catch((err) =>
      console.error("[claude-code] failed to save the user message:", err),
    );
  }

  // Turn marker: proxied usage rows are per-REQUEST (countTurn:false at the
  // proxy), so the turn itself is counted once here — this also brings CC
  // turns into usage_records for the first time (zero tokens, zero credits).
  recordTokenUsage(userId, selectedModel, 0, 0, 0, 0, 0).catch(() => {});

  // The live stream is built only when a caller wants it (the agent route);
  // a server-started turn (queue drain) just leaves the detached bridge running.
  return {
    ok: true,
    turnId,
    threadId,
    toResponse: () => {
      // ── Stream stdout NDJSON → AI SDK UIMessageStream ───────────────────────
      const stream = createUIMessageStream<UIMessage>({
        execute: async ({ writer }) => {
          const translator = createTranslator(writer, { messageId: assistantMessageIdForTurn(turnId) });
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
                  setClaudeCodeSessionId(threadId, event.sessionId).catch(() => {});
                }
                translator.push(event);
                if (event.type === "end_turn") {
                  endedNormally = true;
                  markTurnEnded(projectId, threadId, turnId).catch(() => {});
                  break;
                }
                if (event.type === "error") {
                  // The bridge emits `error` only when it's exiting — mark the
                  // turn dead so the client falls back to a fresh continuation
                  // instead of trying to reattach to a corpse.
                  markTurnDead(projectId, threadId, turnId).catch(() => {});
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
                await setClaudeCodeSessionId(threadId, lastSessionIdSeen);
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
    },
  };
}
