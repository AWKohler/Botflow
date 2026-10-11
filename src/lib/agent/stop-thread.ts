/**
 * Stop a thread's detached in-sandbox agent: kill its bridge (Claude Code or
 * OpenCode — both handle SIGTERM), revoke the turn's tool and LLM-proxy
 * tokens, and mark the turn dead so recovery won't reattach to it. Other
 * threads' agents are untouched. Shared by the Stop button route and thread
 * deletion.
 */
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import { buildKillBridgeScript } from "./claude-code/bridge-control";
import { getTurnRecord, markTurnDead } from "./claude-code/turn-registry";
import { revokeToolToken } from "./claude-code/tool-token";
import { revokeLlmProxyToken } from "./llm-proxy/token";

export async function stopThreadAgent(projectId: string, threadId: string): Promise<void> {
  const record = await getTurnRecord(projectId, threadId);
  try {
    const sandbox = await getOrCreatePersistentSandbox(projectId);
    await sandbox.runCommand({ cmd: "sh", args: ["-c", buildKillBridgeScript(threadId)] });
  } catch {
    // Sandbox unreachable/expired — the bridge is gone with it.
  }
  if (record) {
    if (record.toolToken) revokeToolToken(record.toolToken).catch(() => {});
    if (record.llmProxyToken) revokeLlmProxyToken(record.llmProxyToken).catch(() => {});
    await markTurnDead(projectId, threadId, record.turnId).catch(() => {});
  }
}
