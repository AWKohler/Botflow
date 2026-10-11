/**
 * /api/agent/opencode
 *
 * The OpenCode agent path — runs every model that Claude Code doesn't.
 * Drives an `opencode` subprocess inside the user's Vercel Sandbox. Provider
 * traffic goes through the LLM proxy (the sandbox holds a turn-scoped token;
 * BYOK keys and platform server keys never enter it); Codex/ChatGPT-plan OAuth
 * is the one credential written into the sandbox's OpenCode auth store.
 * Personal-credential Anthropic traffic is refused here (it derives to Claude
 * Code per Anthropic's ToS). When the turn can't run, the route returns 422
 * with a user-facing `error` — there is no fallback agent.
 *
 * Structure is a deliberate near-clone of /api/agent/claude-code — the two
 * in-sandbox routes share the turn-input helpers, host-tool selection, and
 * tool-token minting so their contracts can't drift.
 */
import { auth } from "@/lib/auth/server";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

import { requireProjectAccess } from "@/lib/project-access";
import { sharedTurnBlockReason } from "@/lib/sharing";
import { getUserCredentials, setUserCredentials } from "@/lib/user-credentials";
import { getFreshCodexAccessToken } from "@/lib/codex-oauth";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import { MODEL_CONFIGS } from "@/lib/agent/models";
import { isSandboxPlatform } from "@/lib/project-platform";
import { swiftProjectForbidden } from "@/lib/swift-access";
import { getUserTier } from "@/lib/tier";
import {
  getMonthlyCreditsKV,
  getMonthlyLimit,
  getWeeklyCredits,
  getWeeklyLimit,
} from "@/lib/credits";
import { limitReachedResponse } from "@/lib/plan-response";
import { recordTokenUsage } from "@/lib/usage";

import {
  REVENUECAT_ENABLED,
  STRIPE_CONNECT_ENABLED,
  USE_TOGETHER_KIMI,
} from "@/lib/feature-flags";
import { OAUTH_PROVIDER_IDS } from "@/lib/oauth-providers/registry";
import { deriveAgentBackend } from "@/lib/agent/derive-backend";
import { credFlagsFromUserCredentials } from "@/lib/agent/backend-resolution";
import { resolveOpenCodeModel, openCodeCredModeForModel } from "@/lib/agent/opencode/models";
import {
  mintLlmProxyToken,
  revokeLlmProxyToken,
  llmProxyOrigin,
} from "@/lib/agent/llm-proxy/token";
import {
  LLM_PROXY_PROVIDERS,
  proxyProviderForOpenCodeId,
} from "@/lib/agent/llm-proxy/providers";
import {
  ensureOpenCodeInstalled,
  writeOpenCodeAuth,
  readOpenCodeAuth,
  writeOpenCodeScripts,
  writeOpenCodeAppendPrompt,
  resolveOpenCodePaths,
} from "@/lib/agent/opencode/setup";
import { buildOpenCodeAppendPrompt } from "@/lib/agent/opencode/system-prompt";
import {
  getOpenCodeSessionId,
  setOpenCodeSessionId,
} from "@/lib/agent/opencode/session-store";
import {
  createOpenCodeTranslator,
  type OpenCodeBridgeEvent,
} from "@/lib/agent/opencode/translator";
import { mintToolToken, revokeToolToken } from "@/lib/agent/claude-code/tool-token";
import {
  buildPrepareTurnScript,
  parseCapacityRefusal,
  threadAbortFile,
  threadPidFile,
  turnEventFile,
} from "@/lib/agent/claude-code/bridge-control";
import {
  getTurnRecord,
  setTurnRecord,
  markTurnEnded,
  markTurnDead,
} from "@/lib/agent/claude-code/turn-registry";
import { selectHostTools } from "@/lib/agent/host-tools/definitions";
import {
  awarenessNote,
  ensureThreadSegment,
  noteTurnStarted,
  otherRunningThreadTitles,
  resolveThread,
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
  extractCurrentUserText,
  extractCurrentUserMessageId,
  extractCurrentUserImageParts,
  fetchPromptImages,
  buildPriorConversationPreamble,
} from "@/lib/agent/turn-input";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface RequestBody {
  messages: UIMessage[];
  projectId?: string;
  platform?: string;
  /** Thread to run in. Omitted by older clients → the most recent thread. */
  threadId?: string;
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return jsonError(401, "Unauthorized");

  // Per-user request-rate guard — same rationale as the CC route: this path
  // spawns a subprocess in a per-project sandbox and streams for up to
  // maxDuration, with no credit reservation.
  const blocked = await enforce(identifierFor(userId, req), "opencode");
  if (blocked) return blocked;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const { messages, projectId, platform, threadId: requestedThreadId } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonError(400, "messages array required");
  }
  // Replay guard: every legitimate turn is initiated by a new user message —
  // a trailing assistant message means an automatic client resubmit, which
  // would loop the agent and burn the user's own credits/plan.
  if (messages[messages.length - 1]?.role !== "user") {
    return jsonError(409, "Last message must be a user message");
  }
  if (!projectId) {
    return jsonError(400, "projectId required");
  }
  if (!platform || !isSandboxPlatform(platform)) {
    return agentUnavailableResponse("unsupported_platform");
  }

  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return jsonError(404, "Project not found");
  }
  const { project } = access;
  // Swift's runtime is beta-only — gate on the STORED platform (see the CC
  // route's rationale: this also protects the tool-token mint below).
  if (await swiftProjectForbidden(project)) {
    return jsonError(403, "Swift projects are currently in private beta.");
  }

  const thread = await resolveThread(project, userId, requestedThreadId);
  if (!thread) {
    return jsonError(404, "Thread not found");
  }
  const threadId = thread.id;

  // Sharing: never kill ANOTHER collaborator's live bridge in this thread —
  // tell this user to wait instead. Other threads run independently.
  const sharedBlock = await sharedTurnBlockReason(projectId, threadId, userId);
  if (sharedBlock) {
    return jsonError(409, sharedBlock);
  }

  const selectedModel = threadModel(thread, project);

  const creds = await getUserCredentials(userId);
  const credFlags = credFlagsFromUserCredentials(creds);
  const userTier = await getUserTier(userId);
  // Single source of truth: re-derive the backend server-side so the routing
  // decision is tamper-proof. With the LLM proxy, this is also what keeps
  // personal-credential Anthropic traffic OFF OpenCode (it derives to
  // claude-code) and enforces the platform-mode tier gate.
  const derived = deriveAgentBackend({
    model: selectedModel,
    platform,
    creds: credFlags,
    tier: userTier,
    useTogetherKimi: USE_TOGETHER_KIMI,
  });
  if (derived.backend !== "opencode") {
    return agentUnavailableResponse("backend_mismatch");
  }
  if (!derived.runnable) {
    return agentUnavailableResponse(derived.reason);
  }

  const modelRef = resolveOpenCodeModel(selectedModel, { useTogetherKimi: USE_TOGETHER_KIMI });

  const userPrompt = extractCurrentUserText(messages);
  // Resolve attached images server-side (self-contained payload; the sandbox
  // may not reach the upload CDN) — skipped entirely for text-only models.
  const supportsImages = MODEL_CONFIGS[selectedModel].supportsImages;
  const imageParts = supportsImages ? extractCurrentUserImageParts(messages) : [];
  const images = imageParts.length ? await fetchPromptImages(imageParts) : [];
  if (!userPrompt && images.length === 0) {
    return jsonError(400, "No user text or image in last message");
  }

  // Prior-conversation preamble — keeps continuity when there's no resumable
  // session (fresh sandbox, backend switch). Same format as the CC route.
  const preamble = buildPriorConversationPreamble(messages);
  const prompt = preamble
    ? `[Prior conversation context — earlier turns from this session. The project filesystem reflects everything that happened.]\n\n${preamble}\n\n[End of context. The user's current message:]\n\n${userPrompt}`
    : userPrompt;

  // ── Credential mode + surface ─────────────────────────────────────────────
  // codex-oauth: the ONE documented stay-in-sandbox exception (opencode's
  //   ChatGPT-plan plugin can't be redirected at 1.17.13) — real tokens,
  //   existing rotation machinery, no proxy.
  // byok/platform: the sandbox gets a bfap_ LLM-proxy token; the real key
  //   (the user's or the platform's) is injected server-side at
  //   /api/internal/llm-proxy/<provider>, which also meters + bills
  //   platform-mode requests.
  const turnId = Math.random().toString(36).slice(2, 10);
  const credMode = openCodeCredModeForModel(selectedModel, credFlags, USE_TOGETHER_KIMI);
  const useCodex = credMode === "codex-oauth";

  // Recover a mid-turn Codex token rotation that a killed route never
  // persisted: the finally-block rotation sync below can't run when the
  // platform hard-kills the route at maxDuration, so a rotation from the
  // PREVIOUS turn may exist only in the sandbox's auth.json. Adopt it before
  // deriving this turn's token — otherwise we'd refresh with (and re-write)
  // a dead pair and 401.
  let codexAuth = {
    codexOAuthAccessToken: creds.codexOAuthAccessToken,
    codexOAuthRefreshToken: creds.codexOAuthRefreshToken,
    codexOAuthExpiresAt: creds.codexOAuthExpiresAt,
  };
  if (useCodex) {
    try {
      const sandboxAuth = await readOpenCodeAuth(projectId);
      const openai = sandboxAuth?.openai as
        | { type?: string; access?: string; refresh?: string; expires?: number }
        | undefined;
      if (
        openai?.type === "oauth" &&
        openai.refresh &&
        openai.access &&
        openai.refresh !== creds.codexOAuthRefreshToken
      ) {
        codexAuth = {
          codexOAuthAccessToken: openai.access,
          codexOAuthRefreshToken: openai.refresh,
          codexOAuthExpiresAt: openai.expires ?? null,
        };
        await setUserCredentials(userId, {
          codexOAuthAccessToken: openai.access,
          codexOAuthRefreshToken: openai.refresh,
          codexOAuthExpiresAt: openai.expires ?? null,
        }).catch(() => {});
      }
    } catch {
      // No sandbox / no auth file yet — nothing to recover.
    }
  }

  // Proactive refresh: the token is written into the sandbox at turn start
  // and must survive the whole turn.
  const codexToken = useCodex
    ? await getFreshCodexAccessToken(codexAuth, userId)
    : null;
  const writtenRefreshToken = useCodex ? (codexAuth.codexOAuthRefreshToken ?? null) : null;
  if (useCodex && !codexToken) {
    // Codex creds present but unusable (refresh failed) — tell the user to
    // reconnect rather than 500.
    return agentUnavailableResponse("no_provider_credentials");
  }

  const proxyProvider = proxyProviderForOpenCodeId(modelRef.providerID);
  let llmProxyToken: string | null = null;
  if (!useCodex) {
    if (!proxyProvider) {
      return agentUnavailableResponse("no_provider_credentials"); // unmappable — cannot happen for registry models
    }
    if (credMode === null) {
      // Platform mode pre-flight — a cheap KV-only early exit at turn start
      // (never Neon on this hot path). The binding per-request gate is the
      // atomic spillover reservation at the proxy (reservePlatformCredits):
      // weekly paces, boundary-straddling requests spill into monthly
      // headroom, monthly is the hard ceiling. The tier gate already ran
      // inside the derivation above.
      const monthlyLimit = getMonthlyLimit(userTier);
      const monthlyUsed = await getMonthlyCreditsKV(userId);
      if (monthlyUsed >= monthlyLimit) {
        return limitReachedResponse({
          limitType: "monthly_credits",
          current: monthlyUsed,
          limit: monthlyLimit,
          tier: userTier,
        });
      }
      const weeklyLimit = getWeeklyLimit(userTier);
      const weeklyUsed = await getWeeklyCredits(userId);
      if (weeklyUsed >= weeklyLimit) {
        return limitReachedResponse({
          limitType: "weekly_credits",
          current: weeklyUsed,
          limit: weeklyLimit,
          tier: userTier,
        });
      }
      if (!process.env[LLM_PROXY_PROVIDERS[proxyProvider].platformKeyEnv]) {
        // Platform key not configured on this deployment.
        console.error(`[opencode] platform key ${LLM_PROXY_PROVIDERS[proxyProvider].platformKeyEnv} is not configured`);
        return agentUnavailableResponse("no_provider_credentials");
      }
    }
    llmProxyToken = await mintLlmProxyToken({
      userId,
      projectId,
      turnId,
      provider: proxyProvider,
      credMode: credMode === "byok" ? "byok" : "platform",
      modelId: selectedModel,
      modelAllowlist: [modelRef.modelID],
    });
  }

  // ── Sandbox setup (idempotent, fast on warm boots) ───────────────────────
  const installResult = await ensureOpenCodeInstalled(projectId);
  if (!installResult.ok) {
    return jsonError(500, installResult.error);
  }

  await writeOpenCodeAuth(projectId, {
    codex:
      useCodex && codexToken
        ? {
            accessToken: codexToken,
            refreshToken: codexAuth.codexOAuthRefreshToken,
            expiresAt: codexAuth.codexOAuthExpiresAt,
          }
        : null,
    proxy: llmProxyToken
      ? { providerID: modelRef.providerID, token: llmProxyToken }
      : null,
  });
  await writeOpenCodeScripts(projectId);

  // Convex-specific tools/prompt gate on this — MuhKoo has a backend but no
  // Convex deploy/logs/table tools (mirrors projectUsesConvex).
  const usesConvex =
    project.backendType === "platform" || project.backendType === "user";
  const usesMuhkoo = project.backendType === "muhkoo";
  // Other threads' live agents share this sandbox — say so, so this agent
  // re-reads before editing and stays on its own task. Per-thread file: the
  // note differs between concurrently running threads.
  const otherAgents = awarenessNote(await otherRunningThreadTitles(projectId, threadId).catch(() => []));
  const appendPromptPath = await writeOpenCodeAppendPrompt(
    projectId,
    [
      buildOpenCodeAppendPrompt({
        platform: platform as "sandboxed-web" | "swift",
        hasBackend: usesConvex,
        usesMuhkoo,
        hasConvexEnv: usesConvex && Boolean(project.userConvexUrl || project.convexDeployUrl),
      }),
      otherAgents,
    ].filter(Boolean).join("\n\n"),
    threadId,
  );

  // ── Bridge config ─────────────────────────────────────────────────────────
  const sessionId = await getOpenCodeSessionId(threadId);
  const segmentId = await ensureThreadSegment(thread);
  const customTools = selectHostTools({
    platform,
    usesConvex,
    usesMuhkoo,
    hasGithub: Boolean(project.githubRepoOwner && project.githubRepoName),
    stripeEnabled: STRIPE_CONNECT_ENABLED,
    revenuecatEnabled: REVENUECAT_ENABLED,
  });

  // Always minted: it also authenticates the end-of-turn notify (server-side
  // save). The MCP host-tool server is only configured when there are tools.
  const toolToken = await mintToolToken({
    userId,
    projectId,
    threadId,
    turnId,
    backend: "opencode",
    segmentId,
  });

  const paths = await resolveOpenCodePaths(projectId);
  const configPath = `/tmp/.botflow-opencode-config-${turnId}.json`;
  // Per-thread path so the stop route can find it without knowing the turn
  // id; the prepare script clears any stale one.
  const abortPath = threadAbortFile(threadId);
  const eventFile = turnEventFile(turnId);

  const bridgeConfig = {
    prompt,
    ...(images.length ? { images } : {}),
    ...(sessionId ? { sessionId } : {}),
    model: modelRef,
    cwd: "/vercel/sandbox",
    appendPromptPath,
    opencodeBin: paths.binPath,
    abortPath,
    // Proxied modes point the provider at /api/internal/llm-proxy with the
    // bfap_ token as the api key; codex-oauth mode omits this (auth.json
    // carries the real ChatGPT tokens — the documented exception).
    ...(llmProxyToken && proxyProvider
      ? {
          provider: {
            id: modelRef.providerID,
            baseURL: `${llmProxyOrigin(new URL(req.url).origin)}/api/internal/llm-proxy/${proxyProvider}${LLM_PROXY_PROVIDERS[proxyProvider].sandboxBasePath}`,
            apiKey: llmProxyToken,
            ...(process.env.VERCEL_ENV === "preview" &&
            process.env.VERCEL_AUTOMATION_BYPASS_SECRET
              ? {
                  headers: {
                    "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(customTools.length
      ? {
          mcp: {
            scriptPath: paths.mcpScriptPath,
            apiBase: new URL(req.url).origin,
            toolToken,
            tools: customTools,
            oauthProviderIds: customTools.includes("setup_oauth_provider")
              ? OAUTH_PROVIDER_IDS
              : [],
            // Preview deployments sit behind Vercel Deployment Protection,
            // which answers the sandbox's cookie-less tool callbacks with an
            // HTML auth page. Vercel injects this secret when "Protection
            // Bypass for Automation" is enabled; forward it ONLY on previews
            // (prod has no wall, and the secret must not enter prod
            // sandboxes — it's project-scoped).
            ...(process.env.VERCEL_ENV === "preview" &&
            process.env.VERCEL_AUTOMATION_BYPASS_SECRET
              ? { vercelBypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
              : {}),
          },
        }
      : {}),
  };

  const sandbox = await getOrCreatePersistentSandbox(projectId);

  // ── One bridge per THREAD ─────────────────────────────────────────────────
  // Same contract as the CC route: the bridge runs detached (it must survive
  // this route's maxDuration so the client can reattach), so a new turn kills
  // this thread's previous bridge — Claude Code OR OpenCode, they share the
  // thread's pidfile — revokes its tokens, sweeps stale artifacts, clears the
  // thread's abort sentinel, admits against sandbox capacity, and pre-creates
  // the event file for tail -f. Other threads' bridges keep running.
  const prevTurn = await getTurnRecord(projectId, threadId).catch(() => null);
  const prepared = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", buildPrepareTurnScript(threadId, eventFile)],
  });
  const refusal = parseCapacityRefusal(await prepared.stdout());
  if (refusal) {
    revokeToolToken(toolToken).catch(() => {});
    if (llmProxyToken) revokeLlmProxyToken(llmProxyToken).catch(() => {});
    return capacityResponse(refusal.running);
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

  // ── Spawn the bridge ────────────────────────────────────────────────────
  const cmd = await sandbox.runCommand({
    cmd: "node",
    args: [paths.bridgePath],
    cwd: "/vercel/sandbox",
    env: {
      BOTFLOW_CONFIG_PATH: configPath,
      BOTFLOW_EVENT_FILE: eventFile,
      BOTFLOW_PID_FILE: threadPidFile(threadId),
      BOTFLOW_API_BASE: new URL(req.url).origin,
      BOTFLOW_TURN_TOKEN: toolToken,
      ...(process.env.VERCEL_ENV === "preview" && process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        ? { BOTFLOW_VERCEL_BYPASS: process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
        : {}),
    },
    detached: true,
  });

  // Register the turn so later requests can find it: the reattach route tails
  // its event file after this route dies at maxDuration, and the next turn's
  // spawn (or the stop route) kills the bridge + revokes the token.
  //
  // NOTE deliberately NO req.signal abort here (an earlier iteration touched
  // the abort sentinel on client abort): a dropped connection is usually a
  // network blip / tab reload / this route's own teardown — killing the turn
  // for it would defeat reattach. Explicit stops go through the stop route,
  // whose SIGTERM the bridge answers by aborting the opencode session.
  const spawningUserMessageId = extractCurrentUserMessageId(messages);
  await setTurnRecord(projectId, {
    turnId,
    threadId,
    userId,
    backend: "opencode",
    ...(spawningUserMessageId ? { userMessageId: spawningUserMessageId } : {}),
    eventFile,
    startedAt: Date.now(),
    toolToken,
    ...(llmProxyToken ? { llmProxyToken } : {}),
  }).catch(() => {});

  // Thread bookkeeping: status/ordering, a title from the first prompt, and
  // the prompt itself saved server-side (attributed to its author).
  await noteTurnStarted(threadId).catch(() => {});
  if (userPrompt) await setTitleIfEmpty(thread, userPrompt).catch(() => {});
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === "user") {
    await saveUserMessage(threadId, segmentId, lastMessage, userId).catch((err) =>
      console.error("[opencode] failed to save the user message:", err),
    );
  }

  // Turn marker: proxied usage rows are per-REQUEST (countTurn:false at the
  // proxy), so the turn itself is counted once here — codex turns included,
  // for a consistent agentTurns meaning across backends.
  recordTokenUsage(userId, selectedModel, 0, 0, 0, 0, 0).catch(() => {});

  // ── Stream stdout NDJSON → AI SDK UIMessageStream ───────────────────────
  const stream = createUIMessageStream<UIMessage>({
    execute: async ({ writer }) => {
      const translator = createOpenCodeTranslator(writer, { messageId: assistantMessageIdForTurn(turnId) });
      let buffer = "";
      let lastSessionIdSeen: string | null = null;
      let endedNormally = false;

      try {
        for await (const log of cmd.logs()) {
          if (log.stream !== "stdout") continue;
          buffer += log.data;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            let event: OpenCodeBridgeEvent;
            try {
              event = JSON.parse(line) as OpenCodeBridgeEvent;
            } catch {
              writer.write({
                type: "error",
                errorText: `Unparseable bridge output: ${line.slice(0, 200)}`,
              } satisfies UIMessageChunk);
              continue;
            }
            if (event.type === "session_started") {
              lastSessionIdSeen = event.sessionId;
              // Persist EAGERLY — the `finally` below never runs when the
              // platform hard-kills this route at maxDuration, and losing the
              // session pointer forces the continuation turn to start a fresh
              // session and rediscover all its context.
              setOpenCodeSessionId(threadId, event.sessionId).catch(() => {});
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
            await setOpenCodeSessionId(threadId, lastSessionIdSeen);
          } catch {
            // Non-fatal.
          }
        }
        // Codex refresh-token rotation: if opencode refreshed mid-turn, the
        // sandbox auth.json holds the new pair and our stored refresh token
        // is dead. Persist the rotation so the next turn's server-side
        // refresh doesn't 401.
        if (useCodex && writtenRefreshToken) {
          readOpenCodeAuth(projectId)
            .then((auth) => {
              const openai = auth?.openai as
                | { type?: string; access?: string; refresh?: string; expires?: number }
                | undefined;
              if (
                openai?.type === "oauth" &&
                openai.refresh &&
                openai.access &&
                openai.refresh !== writtenRefreshToken
              ) {
                return setUserCredentials(userId, {
                  codexOAuthAccessToken: openai.access,
                  codexOAuthRefreshToken: openai.refresh,
                  codexOAuthExpiresAt: openai.expires ?? null,
                });
              }
            })
            .catch(() => {});
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
            .runCommand({ cmd: "sh", args: ["-c", `rm -f ${configPath} ${abortPath}`] })
            .catch(() => {});
        }
      }
    },
    onError: (err) => (err instanceof Error ? err.message : String(err)),
  });

  return createUIMessageStreamResponse({ stream });
}
