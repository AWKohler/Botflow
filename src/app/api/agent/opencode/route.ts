/**
 * /api/agent/opencode
 *
 * The OpenCode agent path — the drop-in replacement for the Botflow agent on
 * non-Anthropic models. Drives an `opencode` subprocess inside the user's
 * Vercel Sandbox using the USER'S OWN credentials (Codex/ChatGPT-plan OAuth
 * or BYOK provider keys), written into the sandbox's OpenCode auth store.
 * Platform server keys never enter the sandbox: users without personal creds
 * fall back to /api/agent via the same 412 contract the Claude Code route
 * uses, and Anthropic models are hard-rejected here (Claude plans flow
 * through Claude Code per Anthropic's ToS).
 *
 * Structure is a deliberate near-clone of /api/agent/claude-code — the two
 * in-sandbox routes share the turn-input helpers, host-tool selection, and
 * tool-token minting so their contracts can't drift.
 */
import { auth } from "@clerk/nextjs/server";
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
import { resolveModelId, MODEL_CONFIGS } from "@/lib/agent/models";
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
  OPENCODE_BACKEND_ENABLED,
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
  turnEventFile,
  BRIDGE_PID_FILE,
  BRIDGE_RUN_DIR,
} from "@/lib/agent/claude-code/bridge-control";
import {
  getTurnRecord,
  setTurnRecord,
  markTurnEnded,
  markTurnDead,
} from "@/lib/agent/claude-code/turn-registry";
import { selectHostTools } from "@/lib/agent/host-tools/definitions";
import {
  fallbackResponse as fallback,
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
}

export async function POST(req: Request) {
  if (!OPENCODE_BACKEND_ENABLED) {
    return fallback("flag_disabled");
  }

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

  const { messages, projectId, platform } = body;
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
    return fallback("non_sandbox_platform");
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

  // Sharing (Phase 3): one live agent per project across ALL collaborators —
  // never kill another user's bridge; tell this user to wait instead.
  const sharedBlock = await sharedTurnBlockReason(projectId, userId);
  if (sharedBlock) {
    return jsonError(409, sharedBlock);
  }

  const selectedModel = resolveModelId(project.model);

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
  if (derived.backend !== "opencode" || !derived.runnable) {
    return fallback(derived.reason);
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
    // Codex creds present but unusable (refresh failed) — fall back rather
    // than 500; the legacy engine can still serve via its own paths.
    return fallback("no_provider_credentials");
  }

  const proxyProvider = proxyProviderForOpenCodeId(modelRef.providerID);
  let llmProxyToken: string | null = null;
  if (!useCodex) {
    if (!proxyProvider) {
      return fallback("no_provider_credentials"); // unmappable — cannot happen for registry models
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
        // Platform key not configured on this deployment — 412 keeps the
        // legacy engine serving during the bake.
        return fallback("no_provider_credentials");
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
  await writeOpenCodeAppendPrompt(
    projectId,
    buildOpenCodeAppendPrompt({
      platform: platform as "sandboxed-web" | "swift",
      hasBackend: usesConvex,
      usesMuhkoo,
      hasConvexEnv: usesConvex && Boolean(project.userConvexUrl || project.convexDeployUrl),
    }),
  );

  // ── Bridge config ─────────────────────────────────────────────────────────
  const sessionId = await getOpenCodeSessionId(projectId);
  const customTools = selectHostTools({
    platform,
    usesConvex,
    usesMuhkoo,
    hasGithub: Boolean(project.githubRepoOwner && project.githubRepoName),
    stripeEnabled: STRIPE_CONNECT_ENABLED,
    revenuecatEnabled: REVENUECAT_ENABLED,
  });

  const toolToken = customTools.length
    ? await mintToolToken({ userId, projectId })
    : null;

  const paths = await resolveOpenCodePaths(projectId);
  const configPath = `/tmp/.botflow-opencode-config-${turnId}.json`;
  // Fixed path inside the shared run dir so the stop route can find it
  // without knowing the turn id; the prepare script clears any stale one.
  const abortPath = `${BRIDGE_RUN_DIR}/abort`;
  const eventFile = turnEventFile(turnId);

  const bridgeConfig = {
    prompt,
    ...(images.length ? { images } : {}),
    ...(sessionId ? { sessionId } : {}),
    model: modelRef,
    cwd: "/vercel/sandbox",
    appendPromptPath: paths.appendPromptPath,
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
    ...(toolToken
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

  // ── One bridge per project ────────────────────────────────────────────────
  // Same contract as the CC route: the bridge runs detached (it must survive
  // this route's maxDuration so the client can reattach), so a NEW turn kills
  // whatever bridge — Claude Code OR OpenCode, they share the pidfile — is
  // still running, revokes its tool token, sweeps stale artifacts, clears any
  // stale abort sentinel, and pre-creates the event file for tail -f.
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

  // ── Spawn the bridge ────────────────────────────────────────────────────
  const cmd = await sandbox.runCommand({
    cmd: "node",
    args: [paths.bridgePath],
    cwd: "/vercel/sandbox",
    env: {
      BOTFLOW_CONFIG_PATH: configPath,
      BOTFLOW_EVENT_FILE: eventFile,
      BOTFLOW_PID_FILE: BRIDGE_PID_FILE,
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
    userId,
    backend: "opencode",
    ...(spawningUserMessageId ? { userMessageId: spawningUserMessageId } : {}),
    eventFile,
    startedAt: Date.now(),
    ...(toolToken ? { toolToken } : {}),
    ...(llmProxyToken ? { llmProxyToken } : {}),
  }).catch(() => {});

  // Turn marker: proxied usage rows are per-REQUEST (countTurn:false at the
  // proxy), so the turn itself is counted once here — codex turns included,
  // for a consistent agentTurns meaning across backends.
  recordTokenUsage(userId, selectedModel, 0, 0, 0, 0, 0).catch(() => {});

  // ── Stream stdout NDJSON → AI SDK UIMessageStream ───────────────────────
  const stream = createUIMessageStream<UIMessage>({
    execute: async ({ writer }) => {
      const translator = createOpenCodeTranslator(writer);
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
              setOpenCodeSessionId(projectId, event.sessionId).catch(() => {});
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
            await setOpenCodeSessionId(projectId, lastSessionIdSeen);
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
