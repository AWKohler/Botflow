import type { UIMessage } from "ai";
import type { Project } from "@/db/schema";
import type { Thread } from "../threads";

/** Everything a turn starter needs, already authenticated and authorized. */
export interface TurnStartContext {
  /** The user the turn runs as: their credentials, tier, and attribution. */
  userId: string;
  projectId: string;
  /** Normalized project platform (a sandbox platform). */
  platform: string;
  /** The thread's current-segment conversation, ending with the new user message. */
  messages: UIMessage[];
  project: Project;
  thread: Thread;
  /** Origin the sandbox calls back to (tool callbacks, LLM proxy, turn-finished). */
  origin: string;
}

export type TurnStartResult =
  | {
      ok: true;
      turnId: string;
      threadId: string;
      /** Build the live UIMessage stream response. Only the agent route calls
       *  this; a server-started turn leaves the detached bridge running. */
      toResponse: () => Response;
    }
  | { ok: false; response: Response };
