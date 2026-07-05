/**
 * Per-turn instructions for the OpenCode agent.
 *
 * Thin wrapper over the Claude Code append prompt — the project-context
 * content (stack, Convex rules, MCP tool guidance, git autonomy, style) is
 * agent-agnostic by design; only two things differ:
 *  1. OpenCode's native tools are lowercase (`grep`/`read`, not `Grep`/`Read`).
 *  2. OpenCode surfaces our platform tools under the `botflow_` MCP prefix,
 *     so the model needs the alias note to connect `convex_deploy` (as the
 *     context calls it) to `botflow_convex_deploy` (as its tool list shows).
 *
 * Deliberately implemented as targeted .replace() calls so
 * claude-code/system-prompt.ts stays byte-identical (its text is the single
 * source of truth). If the replaces ever stop matching they degrade to
 * harmless no-ops — the model tolerates PascalCase tool mentions.
 */
import {
  buildClaudeCodeAppendPrompt,
  type BuildAppendPromptInput,
} from "@/lib/agent/claude-code/system-prompt";

export type { BuildAppendPromptInput };

export function buildOpenCodeAppendPrompt(input: BuildAppendPromptInput): string {
  const base = buildClaudeCodeAppendPrompt(input)
    .replace("verify with `Grep`/`Read`", "verify with `grep`/`read`")
    .replace("and `Grep` `Sources/`", "and `grep` `Sources/`");

  return [
    "You are running as the OpenCode agent inside this project's sandbox.",
    "Platform tools are MCP tools carrying a `botflow_` prefix in your tool list (e.g. `botflow_convex_deploy`, `botflow_ask_question`). The project context below refers to them by their short names — `convex_deploy` means the `botflow_convex_deploy` tool.",
    "",
    base,
  ].join("\n");
}
