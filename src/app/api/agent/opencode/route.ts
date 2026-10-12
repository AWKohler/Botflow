/**
 * /api/agent/opencode
 *
 * The OpenCode agent path — runs every model that Claude Code doesn't. The
 * turn itself is started by startOpenCodeTurn
 * (src/lib/agent/turn-start/opencode.ts), which the thread queue drain also
 * uses.
 *
 * This route authenticates, validates the request, resolves the thread, and
 * streams the started turn. When the turn can't run it answers with the
 * starter's refusal (422 unavailable, 429 capacity, 409 thread busy, …).
 */
import { auth } from "@/lib/auth/server";
import type { UIMessage } from "ai";
import { requireProjectAccess } from "@/lib/project-access";
import { isSandboxPlatform } from "@/lib/project-platform";
import { swiftProjectForbidden } from "@/lib/swift-access";
import { enforce, identifierFor } from "@/lib/rate-limit";
import { resolveThread } from "@/lib/agent/threads";
import { agentUnavailableResponse, jsonError } from "@/lib/agent/turn-input";
import { startOpenCodeTurn } from "@/lib/agent/turn-start/opencode";

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

  // Per-user request-rate guard. This is the most expensive path (spawns an
  // agent subprocess in the project's sandbox and streams for up to
  // maxDuration), so it's the primary burst guard against repeated spawns.
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
  // Replay guard: every legitimate turn is initiated by a new user message,
  // so the array must END with one. A trailing assistant message means an
  // automatic client resubmit; rejecting it stops the agent from being
  // re-triggered without new user input (which would loop it and burn the
  // user's subscription or credits).
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
  // Swift's runtime is beta-only. Gate on the STORED platform (not the request
  // param) so a non-beta owner of a legacy swift project can't drive the agent's
  // sandbox tools — and can't mint the tool token the internal tool route trusts.
  if (await swiftProjectForbidden(project)) {
    return jsonError(403, "Swift projects are currently in private beta.");
  }

  const thread = await resolveThread(project, userId, requestedThreadId);
  if (!thread) {
    return jsonError(404, "Thread not found");
  }

  const started = await startOpenCodeTurn({
    userId,
    projectId,
    platform,
    messages,
    project,
    thread,
    origin: new URL(req.url).origin,
  });
  return started.ok ? started.toResponse() : started.response;
}
