/**
 * Make a project safe to share BEFORE anyone else gets access to it.
 *
 * A project sandbox is readable by every member (terminal, files, agents).
 * The one personal credential that can live there is the owner's Codex
 * (ChatGPT-plan) sign-in, written by earlier OpenCode turns. Before the first
 * collaborator is added we stop any agent still holding such a credential
 * and delete OpenCode's auth store. Throws when the sandbox can't be reached,
 * so the invite route can refuse rather than share an unscrubbed sandbox.
 *
 * Once a project has collaborators no new turn writes a real credential
 * there (src/lib/agent/turn-start/opencode.ts), so this only has to run when
 * a project goes from private to shared.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatSessions, type Project } from "@/db/schema";
import { isSandboxPlatform } from "@/lib/project-platform";
import { getTurnRecords, isTurnLive } from "@/lib/agent/claude-code/turn-registry";
import { stopThreadAgent } from "@/lib/agent/stop-thread";
import { scrubOpenCodeAuth } from "@/lib/agent/opencode/setup";

export async function prepareProjectForSharing(
  project: Pick<Project, "id" | "platform">,
): Promise<void> {
  if (!isSandboxPlatform(project.platform)) return;

  const threads = await getDb()
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(eq(chatSessions.projectId, project.id));
  const records = await getTurnRecords(project.id, threads.map((t) => t.id));
  for (const [threadId, record] of records) {
    if (record.holdsSandboxCredential && isTurnLive(record)) {
      await stopThreadAgent(project.id, threadId);
    }
  }

  await scrubOpenCodeAuth(project.id);
}
