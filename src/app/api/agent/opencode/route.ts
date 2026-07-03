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
import { eq } from "drizzle-orm";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getUserCredentials, setUserCredentials } from "@/lib/user-credentials";
import { getFreshCodexAccessToken } from "@/lib/codex-oauth";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import { resolveModelId, MODEL_CONFIGS, isAnthropicModel } from "@/lib/agent/models";
import { isSandboxPlatform } from "@/lib/project-platform";
import { swiftRuntimeForbidden } from "@/lib/swift-access";

import {
  OPENCODE_BACKEND_ENABLED,
  STRIPE_CONNECT_ENABLED,
  USE_TOGETHER_KIMI,
} from "@/lib/feature-flags";
import { OAUTH_PROVIDER_IDS } from "@/lib/oauth-providers/registry";
import { deriveAgentBackend } from "@/lib/agent/derive-backend";
import { credFlagsFromUserCredentials } from "@/lib/agent/backend-resolution";
import { resolveOpenCodeModel } from "@/lib/agent/opencode/models";
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
import { selectHostTools } from "@/lib/agent/host-tools/definitions";
import {
  fallbackResponse as fallback,
  jsonError,
  extractCurrentUserText,
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

  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== userId) {
    return jsonError(404, "Project not found");
  }
  // Swift's runtime is beta-only — gate on the STORED platform (see the CC
  // route's rationale: this also protects the tool-token mint below).
  if (await swiftRuntimeForbidden(project.platform, userId)) {
    return jsonError(403, "Swift projects are currently in private beta.");
  }

  const selectedModel = resolveModelId(project.model);
  // Hard invariant: Anthropic never rides OpenCode. Claude-plan OAuth must
  // flow through the official Claude Code client (ToS), and Anthropic BYOK
  // keeps its existing botflow/claude-code routing.
  if (isAnthropicModel(selectedModel)) {
    return fallback("anthropic_model");
  }

  const creds = await getUserCredentials(userId);
  // Single source of truth: re-derive the backend server-side so the routing
  // decision is tamper-proof — a client can't force OpenCode without the
  // personal credentials that make it eligible.
  const derived = deriveAgentBackend({
    model: selectedModel,
    platform,
    creds: credFlagsFromUserCredentials(creds),
    preferredAnthropicBackend: creds.preferredAnthropicBackend,
    useTogetherKimi: USE_TOGETHER_KIMI,
  });
  if (derived.backend !== "opencode" || !derived.runnable) {
    return fallback(derived.reason);
  }

  const modelRef = resolveOpenCodeModel(selectedModel, { useTogetherKimi: USE_TOGETHER_KIMI });
  if (!modelRef) {
    return fallback("anthropic_model");
  }

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

  // ── Credentials for THIS model's provider only (minimal exposure) ────────
  const provider = MODEL_CONFIGS[selectedModel].provider;
  const useCodex = provider === "openai" && Boolean(creds.codexOAuthAccessToken);
  // Proactive refresh: the token is written into the sandbox at turn start
  // and must survive the whole turn.
  const codexToken = useCodex
    ? await getFreshCodexAccessToken(
        {
          codexOAuthAccessToken: creds.codexOAuthAccessToken,
          codexOAuthRefreshToken: creds.codexOAuthRefreshToken,
          codexOAuthExpiresAt: creds.codexOAuthExpiresAt,
        },
        userId,
      )
    : null;

  const writtenRefreshToken = useCodex ? (creds.codexOAuthRefreshToken ?? null) : null;
  const authInput = {
    codex:
      useCodex && codexToken
        ? {
            accessToken: codexToken,
            refreshToken: creds.codexOAuthRefreshToken,
            expiresAt: creds.codexOAuthExpiresAt,
          }
        : null,
    openaiApiKey: provider === "openai" && !useCodex ? creds.openaiApiKey : null,
    fireworksApiKey:
      provider === "fireworks" && modelRef.providerID === "fireworks-ai"
        ? creds.fireworksApiKey
        : null,
    togetherApiKey:
      provider === "fireworks" && modelRef.providerID === "togetherai"
        ? creds.togetherApiKey
        : null,
    googleApiKey: provider === "google" ? creds.googleApiKey : null,
  };
  const hasAnyCred =
    Boolean(authInput.codex) ||
    Boolean(authInput.openaiApiKey) ||
    Boolean(authInput.fireworksApiKey) ||
    Boolean(authInput.togetherApiKey) ||
    Boolean(authInput.googleApiKey);
  if (!hasAnyCred) {
    // The derivation says eligible but the concrete credential is missing —
    // creds changed mid-flight. Fall back rather than 500.
    return fallback("no_provider_credentials");
  }

  // ── Sandbox setup (idempotent, fast on warm boots) ───────────────────────
  const installResult = await ensureOpenCodeInstalled(projectId);
  if (!installResult.ok) {
    return jsonError(500, installResult.error);
  }

  await writeOpenCodeAuth(projectId, authInput);
  await writeOpenCodeScripts(projectId);

  const hasBackend = project.backendType !== "none";
  await writeOpenCodeAppendPrompt(
    projectId,
    buildOpenCodeAppendPrompt({
      platform: platform as "sandboxed-web" | "swift",
      hasBackend,
      hasConvexEnv: hasBackend && Boolean(project.userConvexUrl || project.convexDeployUrl),
    }),
  );

  // ── Bridge config ─────────────────────────────────────────────────────────
  const sessionId = await getOpenCodeSessionId(projectId);
  const customTools = selectHostTools({
    platform,
    hasBackend,
    hasGithub: Boolean(project.githubRepoOwner && project.githubRepoName),
    stripeEnabled: STRIPE_CONNECT_ENABLED,
  });

  const toolToken = customTools.length
    ? await mintToolToken({ userId, projectId })
    : null;

  const paths = await resolveOpenCodePaths(projectId);
  const turnId = Math.random().toString(36).slice(2, 10);
  const configPath = `/tmp/.botflow-opencode-config-${turnId}.json`;
  const abortPath = `/tmp/.botflow-opencode-abort-${turnId}`;

  const bridgeConfig = {
    prompt,
    ...(images.length ? { images } : {}),
    ...(sessionId ? { sessionId } : {}),
    model: modelRef,
    cwd: "/vercel/sandbox",
    appendPromptPath: paths.appendPromptPath,
    opencodeBin: paths.binPath,
    abortPath,
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
          },
        }
      : {}),
  };

  const sandbox = await getOrCreatePersistentSandbox(projectId);
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
    env: { BOTFLOW_CONFIG_PATH: configPath },
    detached: true,
  });

  // Client abort → touch the sentinel; the bridge calls session.abort and the
  // turn closes as a normal aborted end. (A small, deliberate improvement
  // over the CC path: opencode has a first-class abort API and these turns
  // burn the user's own metered credits.)
  const onAbort = () => {
    sandbox
      .runCommand({ cmd: "sh", args: ["-c", `touch ${abortPath}`] })
      .catch(() => {});
  };
  req.signal.addEventListener("abort", onAbort, { once: true });

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
        req.signal.removeEventListener("abort", onAbort);
        if (lastSessionIdSeen) {
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
        if (toolToken) {
          revokeToolToken(toolToken).catch(() => {});
        }
        sandbox
          .runCommand({ cmd: "sh", args: ["-c", `rm -f ${configPath} ${abortPath}`] })
          .catch(() => {});
      }
    },
    onError: (err) => (err instanceof Error ? err.message : String(err)),
  });

  return createUIMessageStreamResponse({ stream });
}
