import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  sandboxBash,
  sandboxGlob,
  sandboxGrep,
  sandboxListFiles,
  sandboxReadFile,
  sandboxWriteFile,
} from "@/lib/vercel-sandbox";
import { applyDiff } from "@/lib/agent/diff";
import { getDb } from "@/db";
import { chatQuestions, projects } from "@/db/schema";
import { REVENUECAT_ENABLED } from "@/lib/feature-flags";

// Server-side tool execution for the persistent (Vercel Sandbox) platform.
// Each tool's execute() runs in the Next.js route handler and talks directly
// to the user's persistent sandbox. The browser never sees these calls.

const MAX_OUTPUT = 60_000; // truncate large outputs to keep context reasonable

function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.8));
  const tail = s.slice(-Math.floor(max * 0.2));
  return `${head}\n\n…(truncated ${s.length - max} chars)…\n\n${tail}`;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

// Wrap an async tool body so any thrown error is returned as a JSON string
// the model can read and recover from, rather than aborting the stream.
function safe<T>(fn: () => Promise<T>): Promise<string> {
  return fn().then(
    (result) =>
      typeof result === "string" ? result : JSON.stringify(result),
    (e) => JSON.stringify({ ok: false, error: errMsg(e) }),
  );
}

export function getPersistentTools(
  projectId: string,
  opts: {
    hasBackend?: boolean;
    appBaseUrl?: string;
    authHeaders?: Record<string, string>;
    /** Project platform — Swift projects get the simulator control tools. */
    platform?: string;
  } = {},
) {
  const baseTools = {
    bash: tool({
      description:
        "Run a shell command in the persistent sandbox (bash -lc). Working directory is the project root (/vercel/sandbox). " +
        "Returns stdout, stderr, and exit code. Use for git operations, quick file inspection (cat/wc/head), JSON/YAML queries with jq/yq, " +
        "or any task the dedicated tools (read/write/edit/grep/glob) don't already cover. " +
        "Always pass a short `description` so the user can see what's running.",
      inputSchema: z.object({
        command: z.string().describe("The shell command to execute (passed to `bash -lc`)."),
        description: z
          .string()
          .describe("5-10 word summary of what the command does, e.g. 'list staged git changes'."),
        cwd: z.string().optional().describe("Working directory inside the sandbox (default: /vercel/sandbox)."),
      }),
      async execute({ command, cwd }) {
        return safe(async () => {
          const res = await sandboxBash(projectId, command, cwd ? { cwd } : {});
          return {
            exitCode: res.exitCode,
            stdout: truncate(res.stdout),
            stderr: truncate(res.stderr),
          };
        });
      },
    }),

    glob: tool({
      description:
        "Find files by glob pattern (bash globstar). Examples: '*.swift', 'Sources/**/*.swift', '**/*.{json,yml}'. " +
        "Excludes node_modules and .git. Returns project-relative paths.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern, e.g. '**/*.swift'"),
        path: z
          .string()
          .optional()
          .describe("Project-relative directory to search inside (default: '/')"),
      }),
      async execute({ pattern, path }) {
        return safe(async () => {
          const matches = await sandboxGlob(projectId, pattern, { path });
          return { count: matches.length, files: matches };
        });
      },
    }),

    grep: tool({
      description:
        "Recursive content search (ripgrep). Pattern can be regex. Use to find symbols, references, or text across the project. " +
        "Excludes node_modules and .git. Returns up to 200 matches as { file, line, text }.",
      inputSchema: z.object({
        pattern: z.string().describe("Search pattern (regex)."),
        path: z.string().optional().describe("Project-relative path to search (default: '/')"),
        glob: z.string().optional().describe("Filter by file glob, e.g. '*.swift', '*.ts'"),
        caseInsensitive: z.boolean().optional().describe("Case-insensitive match (default: false)"),
      }),
      async execute({ pattern, path, glob, caseInsensitive }) {
        return safe(async () => {
          const results = await sandboxGrep(projectId, pattern, { path, glob, caseInsensitive });
          return { count: results.length, matches: results };
        });
      },
    }),

    read: tool({
      description:
        "Read a UTF-8 text file. Use project-relative paths starting with '/'. " +
        "For binary files (images, etc.) the response will indicate binary content.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path, e.g. '/Sources/Views/ContentView.swift'"),
      }),
      async execute({ path }) {
        return safe(async () => {
          const result = await sandboxReadFile(projectId, path);
          if (!result) return { ok: false, error: "File not found", path };
          if (result.binary) return { ok: true, binary: true, path };
          return { ok: true, path, content: truncate(result.content) };
        });
      },
    }),

    write: tool({
      description:
        "Write a file (creates or completely overwrites). Use for new files or full rewrites. " +
        "For surgical edits to existing files, prefer `edit` or `applyDiff`.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path, e.g. '/Sources/Views/NewView.swift'"),
        content: z.string().describe("Full file contents to write."),
      }),
      async execute({ path, content }) {
        return safe(async () => {
          await sandboxWriteFile(projectId, path, content);
          return { ok: true, path, bytes: content.length };
        });
      },
    }),

    edit: tool({
      description:
        "Exact-string replacement in an existing file. `oldString` MUST be unique in the file (include surrounding " +
        "context if the literal text appears more than once) — otherwise pass `replaceAll: true` for symbol renames. " +
        "Always `read` the file first to know the exact contents.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path of the file to edit."),
        oldString: z.string().describe("The exact text to replace (whitespace-sensitive)."),
        newString: z.string().describe("The replacement text."),
        replaceAll: z
          .boolean()
          .optional()
          .describe("Replace every occurrence (use for renames). Default: false."),
      }),
      async execute({ path, oldString, newString, replaceAll }) {
        return safe(async () => {
          const file = await sandboxReadFile(projectId, path);
          if (!file) return { ok: false, error: "File not found", path };
          if (file.binary) return { ok: false, error: "Cannot edit binary file", path };

          const original = file.content;
          if (!original.includes(oldString)) {
            return {
              ok: false,
              error: "oldString not found in file. Read the file again and retry with exact contents.",
              path,
            };
          }

          let updated: string;
          let count = 0;
          if (replaceAll) {
            const parts = original.split(oldString);
            count = parts.length - 1;
            updated = parts.join(newString);
          } else {
            const occurrences = original.split(oldString).length - 1;
            if (occurrences > 1) {
              return {
                ok: false,
                error: `oldString matched ${occurrences} times — make it unique by adding surrounding context, or pass replaceAll=true.`,
                path,
                occurrences,
              };
            }
            count = 1;
            updated = original.replace(oldString, newString);
          }

          await sandboxWriteFile(projectId, path, updated);
          return { ok: true, path, replacements: count };
        });
      },
    }),

    applyDiff: tool({
      description:
        "Apply one or more SEARCH/REPLACE blocks to a single file using fuzzy matching (85% similarity). " +
        "Use when several non-adjacent regions need editing in one shot. For a single edit, prefer `edit`. " +
        "Format: <<<<<<< SEARCH\\n[content]\\n=======\\n[replacement]\\n>>>>>>> REPLACE",
      inputSchema: z.object({
        path: z.string().describe("Project-relative path."),
        diff: z.string().describe("One or more SEARCH/REPLACE blocks."),
      }),
      async execute({ path, diff }) {
        return safe(async () => {
          const file = await sandboxReadFile(projectId, path);
          if (!file) return { ok: false, error: "File not found", path };
          if (file.binary) return { ok: false, error: "Cannot edit binary file", path };

          const result = applyDiff(file.content, diff);
          if (!result.success || !result.content) {
            return {
              ok: false,
              applied: result.appliedCount,
              failed: result.failedBlocks.length,
              error: result.error ?? "Diff failed",
              failedBlocks: result.failedBlocks.map(b => ({
                index: b.index,
                reason: b.reason,
                searchPreview: b.searchPreview,
                bestMatch: b.bestMatch,
              })),
            };
          }

          await sandboxWriteFile(projectId, path, result.content);
          return { ok: true, applied: result.appliedCount, path };
        });
      },
    }),

    listFiles: tool({
      description:
        "List entries in a directory. Set `recursive: true` to walk subtrees. " +
        "Excludes node_modules, .git, and .DS_Store. Prefer `glob` or `grep` for targeted lookups.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative directory, e.g. '/Sources'"),
        recursive: z.boolean().optional().describe("Walk subdirectories (default: false)"),
      }),
      async execute({ path, recursive }) {
        return safe(async () => {
          const entries = await sandboxListFiles(projectId, path, Boolean(recursive));
          return { count: entries.length, entries };
        });
      },
    }),

    askQuestion: tool({
      description:
        "Surface an in-chat multiple-choice question to the user. The user sees the question inline in the chat with buttons for each option and picks one (or several if multiSelect). Use this when you genuinely need a decision from the user and continuing without it would be guessing.\n\n" +
        "Pass an array of one or more questions; the user answers each in turn. Each question needs: `id` (your slug), `question` (the prompt text), `options` (label + 1-line description each). Optional: `header` (short tag), `multiSelect` (default false), `allowCustom` + `customPlaceholder` to let the user type a free-form answer.\n\n" +
        "The tool blocks for up to 5 minutes waiting for an answer. If the user dismisses or doesn't answer in time, the tool returns `{ answered: false }` — continue without that input.",
      inputSchema: z.object({
        questions: z
          .array(
            z.object({
              id: z.string(),
              header: z.string().optional(),
              question: z.string(),
              options: z.array(
                z.object({
                  id: z.string(),
                  label: z.string(),
                  description: z.string().optional(),
                }),
              ),
              multiSelect: z.boolean().optional(),
              allowCustom: z.boolean().optional(),
              customPlaceholder: z.string().optional(),
            }),
          )
          .min(1),
      }),
      async execute({ questions }, ctx) {
        return safe(async () => {
          const toolCallId = ctx?.toolCallId ?? `${projectId}-${Date.now()}`;
          const db = getDb();
          const [proj] = await db
            .select({ userId: projects.userId, currentSegmentId: projects.currentSegmentId })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1);
          if (!proj) {
            return { ok: false, answered: false, error: "Project not found." };
          }

          // Insert the question row. Use the toolCallId as the lookup key so
          // the UI can match the row to the assistant's tool part in the
          // message timeline.
          await db.insert(chatQuestions).values({
            projectId,
            userId: proj.userId,
            segmentId: proj.currentSegmentId,
            toolCallId,
            questions: questions as unknown as object,
            status: "pending",
          });

          // Poll until the user answers or 5 minutes elapse.
          const deadline = Date.now() + 5 * 60 * 1000;
          while (Date.now() < deadline) {
            await new Promise<void>((r) => setTimeout(r, 2000));
            const [row] = await db
              .select({ status: chatQuestions.status, answer: chatQuestions.answer })
              .from(chatQuestions)
              .where(
                and(
                  eq(chatQuestions.toolCallId, toolCallId),
                  eq(chatQuestions.projectId, projectId),
                ),
              )
              .limit(1);
            if (!row) break;
            if (row.status === "answered") {
              const ans = row.answer as
                | { selectedIds?: string[]; text?: string; selectedLabels?: string[] }
                | null;
              return {
                ok: true,
                answered: true,
                selectedIds: ans?.selectedIds ?? [],
                selectedLabels: ans?.selectedLabels ?? [],
                customText: ans?.text ?? null,
              };
            }
            if (row.status === "dismissed") {
              return {
                ok: true,
                answered: false,
                dismissed: true,
              };
            }
          }
          // Timed out — best-effort mark dismissed so future UI doesn't show stale.
          await db
            .update(chatQuestions)
            .set({ status: "dismissed", updatedAt: new Date() })
            .where(
              and(
                eq(chatQuestions.toolCallId, toolCallId),
                eq(chatQuestions.projectId, projectId),
              ),
            )
            .catch(() => undefined);
          return { ok: true, answered: false, timedOut: true };
        });
      },
    }),

    endTurn: tool({
      description:
        "Call this tool when you have completed the user's request. You MUST call this when you are done with your task.",
      inputSchema: z.object({
        summary: z.string().describe("A brief summary of what you accomplished."),
      }),
      async execute({ summary }) {
        return summary;
      },
    }),
  };

  // Simulator control — Swift only. The simulator session is owned by the
  // user's open workspace (it holds the WebSocket stream), so these tools
  // publish desired-state to Redis; the workspace polls and honors it. See
  // src/lib/swift-sim-control.ts.
  const simulatorTools: ToolSet =
    opts.platform === "swift"
      ? {
          startSimulator: tool({
            description:
              "Build the project and run it on the iOS simulator in the user's workspace. The simulator does NOT run while you work (no HMR — compiling is expensive), so call this ONCE at the END of your turn, after your changes are complete and you believe the project builds. " +
              "The user's open workspace picks the request up within a few seconds and starts streaming; if their workspace tab is closed the request simply expires. Do NOT call this mid-work or when the build is known-broken.",
            inputSchema: z.object({}),
            async execute() {
              return safe(async () => {
                const { requestSimulatorAction } = await import("@/lib/swift-sim-control");
                await requestSimulatorAction(projectId, "start");
                return {
                  ok: true,
                  message:
                    "Simulator start requested. The user's workspace will build the project and begin streaming within a few seconds (if their tab is open).",
                };
              });
            },
          }),
          stopSimulator: tool({
            description:
              "Stop the running iOS simulator stream in the user's workspace. Use when the user asks to stop it, or before making a large batch of changes that would make the running build stale.",
            inputSchema: z.object({}),
            async execute() {
              return safe(async () => {
                const { requestSimulatorAction } = await import("@/lib/swift-sim-control");
                await requestSimulatorAction(projectId, "stop");
                return { ok: true, message: "Simulator stop requested." };
              });
            },
          }),
          getSimulatorStatus: tool({
            description:
              "Check whether the iOS simulator is currently running/streaming in the user's workspace. Returns state ('stopped' | 'starting' | 'building' | 'installing' | 'live' | 'failed'), the device model, and any pending start/stop request. Cheap — call before startSimulator if unsure.",
            inputSchema: z.object({}),
            async execute() {
              return safe(async () => {
                const { getSimulatorStatus } = await import("@/lib/swift-sim-control");
                return getSimulatorStatus(projectId);
              });
            },
          }),
        }
      : {};

  // No-backend (or missing app URL) → file/exec tools only.
  if (!opts.hasBackend || !opts.appBaseUrl) {
    return { ...baseTools, ...simulatorTools };
  }

  // Backend-enabled Swift projects get the Convex deploy + logs tools. The
  // /convex deploy pipeline is platform-agnostic (zips /convex, pushes to the
  // worker), so the same plumbing the web agent uses works here.
  const appBaseUrl = opts.appBaseUrl;
  const authHeaders = opts.authHeaders;
  return {
    ...baseTools,
    ...simulatorTools,
    convexDeploy: tool({
      description:
        "Deploy Convex backend changes. Zips the /convex folder and supporting files (package.json, tsconfig.json) from the sandbox and sends them to the deploy worker. May take several minutes. " +
        "Only call this AFTER editing files in /convex (functions, schema) — changes are not live until deployed. The Swift app reads the deployed backend via the ConvexMobile SDK.",
      inputSchema: z.object({}),
      async execute() {
        const { deployConvexFromSandbox } = await import("@/lib/sandbox-convex-deploy");
        const result = await deployConvexFromSandbox({
          projectId,
          appBaseUrl,
          ...(authHeaders ? { authHeaders } : {}),
        });
        return result.ok
          ? {
              ok: true,
              message: "Convex deployment completed successfully.",
              output: result.output ?? "",
              generatedFilesCount: result.generatedFiles?.length ?? 0,
            }
          : {
              ok: false,
              message: result.error ?? "Convex deployment failed.",
              output: result.output ?? "",
            };
      },
    }),
    getConvexLogs: tool({
      description:
        "Read recent function-execution logs from this project's Convex deployment — query/mutation/action completions, console.log output, execution time, and thrown errors. " +
        "Use this to debug why a Convex function failed: when a subscribe/mutation call errors in the Swift app, call this to see the real server-side error (Convex hides thrown error details from the client). " +
        "Set onlyErrors=true to filter to just failed calls.",
      inputSchema: z.object({
        limit: z.number().int().positive().optional()
          .describe("Max entries to return (most recent). Default 50, max 200."),
        onlyErrors: z.boolean().optional()
          .describe("When true, only return calls that threw an error."),
      }),
      async execute(args) {
        const { getConvexLogs } = await import("@/lib/convex-admin");
        return getConvexLogs(projectId, {
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          ...(typeof args.onlyErrors === "boolean" ? { onlyErrors: args.onlyErrors } : {}),
        });
      },
    }),
    setupAuth: tool({
      description:
        "Add email + password sign-in (Convex Auth) to this Swift app. Call this ONCE when the user wants accounts / login / sign-up / per-user data.\n\n" +
        "How it works: the app already contains the client side (an in-app-browser sign-in flow — BotflowAuthProvider, Keychain, AuthStore, SignInView). This tool configures @convex-dev/auth on the deployment, sets the signing keys server-side (you never see them), turns on the in-app-browser sign-in PAGE, and flips the app into authenticated mode automatically. There is NO native login form to build and NO Swift auth code to write.\n\n" +
        "AFTER it returns ok:true:\n" +
        "1. Write every file in the returned `files` array (convex/auth.ts, auth.config.ts, http.ts, schema.ts, users.ts). If the project already had a convex/schema.ts, MERGE your tables into the returned one (keep ...authTables).\n" +
        "2. Install backend deps: `cd convex && pnpm add @convex-dev/auth @auth/core` (use bash).\n" +
        "3. Run convexDeploy — sign-in is not live until you do.\n" +
        "4. Protect per-user data with getAuthUserId in your queries/mutations (see the returned context). Do NOT edit Sources/Core/ConvexConfig.swift (platform-managed) and do NOT write a native login screen.\n\n" +
        "Read the `context` field in the result for the full reference. Calling again just rotates the signing keys.",
      inputSchema: z.object({}),
      async execute() {
        const url = `${appBaseUrl}/api/projects/${projectId}/convex/setup-auth`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authHeaders ?? {}),
          },
        });
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          return {
            ok: false,
            error: `setup-auth returned non-JSON (HTTP ${res.status}): ${text.slice(0, 500)}`,
          };
        }
      },
    }),
    ...(REVENUECAT_ENABLED
      ? {
          initializeRevenueCatPayments: tool({
            description:
              "Set up RevenueCat (iOS in-app purchases) for this Swift project. Call this when the user asks to add a paywall, subscriptions, premium features, a tip jar, consumables/credits, or any other in-app payment flow.\n\n" +
              "Botflow uses RevenueCat with a bring-your-own-account model: the user links their own RevenueCat account once and reuses it across their apps. Apple — not Botflow — collects the money and pays the user directly; Apple takes 15–30% and RevenueCat sits on top for entitlements + analytics.\n\n" +
              "FLOW (this tool is NON-BLOCKING — it returns immediately):\n" +
              "  1. status='already-connected' — the user linked RevenueCat on a previous project; this one is enabled now. Proceed to add the SDK + paywall.\n" +
              "  2. status='needs-connect' — the Payments tab is now open with a setup wizard. DO NOT wait. CONTINUE building (add the RevenueCat SDK + a paywall to the Swift app) and tell the user to finish connecting in the Payments tab. Entitlements won't be live until they complete setup.\n" +
              "  3. status='backend-blocked' — the project has no Convex backend (required). Relay the message.\n" +
              "  4. status='tier-blocked' — Pro/Max only; relay the message verbatim.\n\n" +
              "IMPORTANT: Real purchases require the user to finish Apple-side setup (paid Apple Developer account, Paid Apps agreement + banking/tax, products created and PASSED App Review, distribution via TestFlight/App Store). For local testing in the simulator, a StoreKit configuration file demonstrates the purchase flow without any of that. Always set this expectation with the user.",
            inputSchema: z.object({}),
            async execute() {
              const url = `${appBaseUrl}/api/projects/${projectId}/revenuecat/initialize`;
              const res = await fetch(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(authHeaders ?? {}),
                },
              });
              const text = await res.text();
              try {
                return JSON.parse(text);
              } catch {
                return {
                  ok: false,
                  error: `revenuecat/initialize returned non-JSON (HTTP ${res.status}): ${text.slice(0, 500)}`,
                };
              }
            },
          }),
        }
      : {}),
  };
}
