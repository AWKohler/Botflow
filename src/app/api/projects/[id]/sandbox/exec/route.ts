import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import { swiftProjectForbidden } from "@/lib/swift-access";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST: run a command in the sandbox, stream output as SSE
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  // Highest-cost route: arbitrary command exec + long-lived SSE stream.
  const blocked = await enforce(identifierFor(userId, req), "expensive");
  if (blocked) return blocked;

  const { id } = await params;
  const access = await requireProjectAccess(id, userId);
  if (!access || (access.project.platform !== "swift" && access.project.platform !== "sandboxed-web")) {
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }
  const { project } = access;
  // Swift's runtime is beta-only; deny non-beta owners of legacy swift projects.
  if (await swiftProjectForbidden(project)) {
    return new Response(
      JSON.stringify({ error: "Swift projects are currently in private beta." }),
      { status: 403 },
    );
  }

  const body = await req.json() as { cmd: string; args?: string[]; cwd?: string };
  const { cmd, args = [], cwd = "/vercel/sandbox" } = body;

  if (!cmd) {
    return new Response(JSON.stringify({ error: "cmd required" }), { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const sandbox = await getOrCreatePersistentSandbox(project.id);

        const command = await sandbox.runCommand({
          cmd,
          args,
          cwd,
          detached: true,
        });

        for await (const log of command.logs()) {
          send(log.stream, log.data);
        }

        const finished = await command.wait();
        send("exit", String(finished.exitCode));
      } catch (error) {
        send("error", error instanceof Error ? error.message : "Command failed");
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
