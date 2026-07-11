/**
 * Mount-time tell for an unfinished agent turn.
 *
 * User messages persist to the DB immediately on send, but the assistant
 * message (with all its streamed tool calls) is persisted only in useChat's
 * onFinish — i.e. when the turn completes. So a persisted transcript that
 * ENDS on a user message means a turn started but never finished persisting:
 * either it is still running detached in the sandbox (reattach to it) or it
 * died mid-turn (surface the completion warning).
 *
 * Pure and React-free so it can be unit-tested directly.
 */
export function transcriptHasUnfinishedTail(
  messages: ReadonlyArray<{ role: string }>,
): boolean {
  if (messages.length === 0) return false;
  return messages[messages.length - 1].role === "user";
}
