/**
 * Single source of truth for the platform ("host") tool surface exposed to
 * in-sandbox agents. These tools execute on OUR server — the sandbox-side
 * agent calls back to /api/internal/claude-code-tool with a short-lived
 * bearer token; sensitive credentials (Convex deploy keys, Stripe secrets,
 * GitHub tokens) never enter the sandbox.
 *
 * Consumed by:
 *  - the OpenCode MCP stdio script (src/lib/agent/opencode/mcp-script.ts),
 *    which embeds these definitions and advertises them over MCP;
 *  - both in-sandbox routes via `selectHostTools` (the per-turn gating that
 *    must never drift from what /api/internal/claude-code-tool executes).
 *
 * TODO(opencode-phase-2): the Claude Code bridge
 * (src/lib/agent/claude-code/bridge-script.ts) still carries its own copies of
 * these descriptions as zod-based `tool()` registrations. They were copied
 * verbatim from there in one commit; regenerating the CC bridge from this
 * module would force a sandbox-wide bridge rewrite and CC regression risk in a
 * phase whose deliverable is OpenCode, so consolidation is deferred. If you
 * edit a description here, mirror it there (and vice versa).
 *
 * Input schemas are plain JSON Schema (draft-07 subset: object/properties/
 * required/enum/type) — the shared wire format MCP expects.
 */

export interface HostToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  inputSchema: Record<string, unknown>;
  /** Mirrors the CC bridge's `annotations.destructiveHint`. */
  destructiveHint?: boolean;
}

/**
 * The literal token in setup_oauth_provider's description + enum that the
 * sandbox-side MCP script replaces with the actual provider-id list it
 * receives via BOTFLOW_OAUTH_PROVIDER_IDS. Kept as a token (rather than a
 * builder function) so the definitions can be serialized into the static,
 * versioned script source.
 */
export const OAUTH_PROVIDERS_TOKEN = "{OAUTH_PROVIDERS}";

const EMPTY_INPUT: Record<string, unknown> = { type: "object", properties: {} };

export const HOST_TOOL_DEFINITIONS: Record<string, HostToolDefinition> = {
  convex_deploy: {
    name: "convex_deploy",
    description:
      "Deploy the project's /convex folder to its Convex deployment. " +
      "Call this AFTER editing files under /convex/ — changes are not live until deployed. " +
      "Takes no arguments; the project's deploy key is resolved server-side.",
    inputSchema: EMPTY_INPUT,
    destructiveHint: true,
  },
  get_convex_logs: {
    name: "get_convex_logs",
    description:
      "Read recent function-execution logs from this project's Convex deployment — query/mutation/action completions, their console.log output, execution time, and thrown errors. " +
      "Use this to debug WHY a Convex function failed: Convex hides thrown error details from the browser client, but they appear here. " +
      "Set onlyErrors=true to filter to just failed calls. Returns the most recent entries (default 50, max 200).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1 },
        onlyErrors: { type: "boolean" },
      },
    },
  },
  setup_auth: {
    name: "setup_auth",
    description:
      "Provision Convex Auth (email + password sign-in) on this project. Call this ONCE when the user wants accounts / login / sign-up / per-user data. " +
      "It generates RSA signing keys server-side and sets them on the Convex deployment (you never see them), then returns JSON with 'files' (boilerplate to write verbatim), 'packagesToInstall', and 'context' (the full reference — READ IT; it is platform-specific). " +
      "After it returns: write every file in 'files' (merge your existing schema tables into the returned schema.ts, keeping ...authTables), install the packages in /convex's package scope, then run convex_deploy — auth is not live until deployed. " +
      "Calling again just rotates the signing keys.",
    inputSchema: EMPTY_INPUT,
    destructiveHint: true,
  },
  setup_oauth_provider: {
    name: "setup_oauth_provider",
    description:
      "Add a social sign-in provider (" + OAUTH_PROVIDERS_TOKEN + ") to Convex Auth on this project. " +
      "Opens a modal in the user's workspace where they register an app with the provider and paste their credentials (Apple uploads a .p8). " +
      "ONLY call this when the user EXPLICITLY asks for social sign-in; otherwise default to password sign-in via setup_auth. " +
      "PREREQUISITE: setup_auth must have run first. " +
      "It BLOCKS until the user finishes — provider console setup takes real time, so expect to wait up to 20 minutes; that is normal, not an error. " +
      "On success it returns the exact convex/auth.ts import + providers-array line and the sign-in button to add — then run convex_deploy. " +
      "Outcomes: 'dismissed' means the user explicitly closed the modal — do NOT retry, and do not treat it as failure to configure later. " +
      "A 'still pending' result means the user simply hasn't finished YET — the modal stays open, you'll get a system note when they submit; " +
      "NEVER report a still-pending modal as dismissed or declined.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          // The MCP script replaces this sentinel with the real enum from
          // BOTFLOW_OAUTH_PROVIDER_IDS at startup.
          enum: [OAUTH_PROVIDERS_TOKEN],
          description: "Provider id (required, no default): " + OAUTH_PROVIDERS_TOKEN + ".",
        },
      },
      required: ["provider"],
    },
  },
  list_convex_tables: {
    name: "list_convex_tables",
    description:
      "List the user tables in this project's Convex deployment. " +
      "Use it to discover what data the app stores before reading or editing. Convex has no SQL — inspect data with read_convex_table. " +
      "Returns { ok, tables }.",
    inputSchema: EMPTY_INPUT,
  },
  read_convex_table: {
    name: "read_convex_table",
    description:
      "Read a page of documents from one Convex table (newest first by default). " +
      "Use it to inspect real data, verify a mutation worked, or gather the _id values you need before editing. " +
      "Returns { ok, documents, continueCursor, isDone }; pass continueCursor back as cursor to page further. Each document includes its _id.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        limit: { type: "integer", minimum: 1 },
        order: { type: "string", enum: ["asc", "desc"] },
        cursor: { type: "string" },
      },
      required: ["table"],
    },
  },
  write_convex_data: {
    name: "write_convex_data",
    description:
      "Directly edit data in this project's Convex database — insert, patch, replace, or delete documents — without writing or deploying a Convex function. The streamlined path for one-off data fixes, seeding, or corrections. " +
      "CONFIRMATION REQUIRED: always call first WITHOUT confirmed to get a preview (status='needs-confirmation', no write happens). Show the user what will change, ask approval with the AskUserQuestion/ask tool, then call again with the SAME args plus confirmed:true. " +
      "Operations: insert (table + documents, no _id); patch (table + ids + fields, merges fields, no keys starting with _); replace (id + document, full overwrite); delete (table + ids, permanent). Get _id values from read_convex_table first.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["insert", "patch", "replace", "delete"] },
        table: { type: "string" },
        documents: { type: "array", items: { type: "object" } },
        ids: { type: "array", items: { type: "string" } },
        fields: { type: "object" },
        id: { type: "string" },
        document: { type: "object" },
        confirmed: { type: "boolean" },
      },
      required: ["operation"],
    },
    destructiveHint: true,
  },
  initialize_stripe_payments: {
    name: "initialize_stripe_payments",
    description:
      "Set up Stripe payments for this project. Call when the user asks to add checkout, subscriptions, billing, a paywall, or any payment flow. " +
      "Stripe Standard Connect — the user links their own Stripe account once and reuses it across every Botflow project. " +
      "If they've already linked it: returns status='already-connected' immediately. " +
      "Otherwise: opens a modal in the workspace and BLOCKS (up to 20 minutes) while the user clicks Connect with Stripe and authorizes. " +
      "Returns status='connected' on success; 'dismissed' means the user explicitly cancelled (do NOT retry — continue and tell the user they can connect later); " +
      "'still-pending' means the user hasn't finished YET — the modal stays open, so NEVER describe it as dismissed or declined; " +
      "'tier-blocked' (Free; relay message); 'backend-blocked' (no Convex backend).",
    inputSchema: EMPTY_INPUT,
  },
  get_stripe_products: {
    name: "get_stripe_products",
    description:
      "List the Stripe Products and Prices on the user's connected account for this project's current test/live mode. " +
      "Call this BEFORE writing checkout code so you reference a product by its lookupKey — never invent or hardcode a price_ id. " +
      "Returns { ok, mode, products: [{ productId, name, prices: [{ priceId, lookupKey, unitAmount, currency, recurring }] }] }. " +
      "Use the lookupKey (not priceId) in checkout — it resolves to the right price in whichever mode is active. " +
      "If the account has no products, create one with create_stripe_product. " +
      "Returns status='not-connected' if Stripe isn't linked (run initialize_stripe_payments first) or status='tier-blocked' for Free users.",
    inputSchema: EMPTY_INPUT,
  },
  create_stripe_product: {
    name: "create_stripe_product",
    description:
      "Create a Stripe Product + Price on the user's connected account and get back a stable lookupKey. " +
      "Use when the app needs a product/price that doesn't exist yet (check first with get_stripe_products). " +
      "unitAmount is in cents: 1500 = 15.00 USD. Omit interval for a one-time price; set it ('month'/'year'/etc.) for a subscription. " +
      "Returns { ok, productId, priceId, lookupKey, ... } — store the lookupKey in the app and pass it to createCheckoutSession, " +
      "NEVER the raw price_ id. The lookupKey is mode-agnostic and is mirrored across test/live on switch, so checkout never breaks.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        unitAmount: { type: "integer", minimum: 1 },
        currency: { type: "string" },
        description: { type: "string" },
        interval: { type: "string", enum: ["day", "week", "month", "year"] },
        intervalCount: { type: "integer", minimum: 1 },
      },
      required: ["name", "unitAmount"],
    },
  },

  // ── Workspace control: dev server lifecycle + browser/dev logs ────────
  startDevServer: {
    name: "startDevServer",
    description:
      "Start the project's Vite dev server inside the sandbox. Idempotent — restarts cleanly if already running. Returns the public preview URL once reachable.",
    inputSchema: EMPTY_INPUT,
  },
  stopDevServer: {
    name: "stopDevServer",
    description: "Stop the running dev server (kills the vite process). Idempotent.",
    inputSchema: EMPTY_INPUT,
  },
  isDevServerRunning: {
    name: "isDevServerRunning",
    description:
      "Check whether the dev server is currently running. Cheap (~50ms). Use before reading logs or refreshing the preview if you're not sure.",
    inputSchema: EMPTY_INPUT,
  },
  getDevServerLog: {
    name: "getDevServerLog",
    description:
      "Tail the dev server stdout/stderr (vite output: HMR events, build errors, warnings).",
    inputSchema: {
      type: "object",
      properties: { linesBack: { type: "integer", minimum: 1 } },
    },
  },
  getBrowserLog: {
    name: "getBrowserLog",
    description:
      "Read the BROWSER console log from the running preview iframe — console.log/warn/error, runtime JS errors, React errors, Vite HMR events. Indispensable for diagnosing why a feature isn't working in the user's preview.",
    inputSchema: {
      type: "object",
      properties: { linesBack: { type: "integer", minimum: 1 } },
    },
  },
  refreshPreview: {
    name: "refreshPreview",
    description:
      "Force the preview iframe in the user's workspace to hard-reload. Useful after changes that Vite HMR cannot pick up.",
    inputSchema: EMPTY_INPUT,
  },

  // ── Simulator control (Swift) ──────────────────────────────────────────
  start_simulator: {
    name: "start_simulator",
    description:
      "Build the project and run it on the iOS simulator in the user's workspace. The simulator does NOT run while you work (no HMR — compiling is expensive), so call this ONCE at the END of your turn, after your changes are complete. " +
      "This tool BLOCKS until the build finishes (several minutes for large projects) and returns the build outcome: on failure you get the compiler errors/warnings — fix them and call start_simulator again; on success you get any warnings and the app launches on the simulator. " +
      "If the user's workspace tab is closed, it returns status='workspace-closed' within ~30 seconds. Do NOT call this mid-work or when the build is known-broken.",
    inputSchema: EMPTY_INPUT,
  },
  stop_simulator: {
    name: "stop_simulator",
    description:
      "Stop the running iOS simulator stream in the user's workspace. Use when the user asks to stop it, or before making a large batch of changes that would make the running build stale.",
    inputSchema: EMPTY_INPUT,
  },
  get_simulator_status: {
    name: "get_simulator_status",
    description:
      "Check whether the iOS simulator is currently running/streaming in the user's workspace. Returns state ('stopped' | 'starting' | 'building' | 'installing' | 'live' | 'failed'), the device model, any pending start/stop request, and lastBuild (the most recent build's outcome + diagnostics — useful if start_simulator timed out while the build was still running). Cheap — call before start_simulator if unsure.",
    inputSchema: EMPTY_INPUT,
  },

  // ── User interaction primitives ────────────────────────────────────────
  ask_question: {
    name: "ask_question",
    description:
      "Ask the user a multiple-choice question inline in the chat. Use when you genuinely need a decision and continuing without it would be guessing. Each question needs: id (slug), question (prompt), options (each with id, label, optional description). Optional: header, multiSelect (default false), allowCustom + customPlaceholder for free-form input. Blocks up to 5 minutes; returns { answered: false } on dismiss/timeout — proceed without that input.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              header: { type: "string" },
              question: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["id", "label"],
                },
              },
              multiSelect: { type: "boolean" },
              allowCustom: { type: "boolean" },
              customPlaceholder: { type: "string" },
            },
            required: ["id", "question", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
  request_env_var: {
    name: "request_env_var",
    description:
      "Ask the user to enter the value of an environment variable. Opens a modal in the user's workspace showing the variable NAME you chose; the user types only the VALUE. The value is stored server-side and NEVER shown to you — assume it is set and write code that reads it. " +
      "Targets: 'client' = frontend Vite .env (only VITE_-prefixed vars reach browser code); 'server' = the Convex deployment env (process.env in Convex functions; requires a backend). " +
      "Use for third-party API keys, webhook secrets, etc. Set isSecret=true for sensitive values. Include a short message explaining what the value is and where to find it — it's rendered in the modal. " +
      "BLOCKS until the user saves or dismisses (up to 15 minutes — finding an API key can take a while; waiting is normal). " +
      "'dismissed' means the user explicitly closed the modal: do NOT retry automatically; continue without it. " +
      "'still pending' means they haven't finished YET — the modal stays open and you'll get a system note when they save; never call that dismissed.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["client", "server"] },
        key: { type: "string" },
        message: { type: "string" },
        isSecret: { type: "boolean" },
      },
      required: ["target", "key"],
    },
  },
  generate_image: {
    name: "generate_image",
    description:
      "Generate an image with AI (Krea 2 Medium) from a text prompt and save it into the project at the given path. " +
      "Blocks until generation finishes (typically 10-30s); on success the file exists in the project immediately. " +
      "Use for hero images, backgrounds, illustrations, placeholder photos, textures, etc. " +
      "Put web assets under public/ (e.g. public/images/hero.png) and reference them by URL path ('/images/hero.png'), or under src/assets/ for bundled imports. Use a .png or .jpg extension. " +
      "Each call costs the user credits, so don't regenerate an image that already looks right and don't call this speculatively. " +
      "Pro/Max feature: for Free users this returns a tier-blocked error — relay it to the user and do NOT retry; fall back to CSS/gradients or existing assets.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the image to generate. Be concrete about subject, style, lighting, and mood.",
        },
        output_path: {
          type: "string",
          description: "Project-relative file path to save the image to, e.g. public/images/hero.png. Parent directories are created automatically.",
        },
        aspect_ratio: {
          type: "string",
          enum: ["1:1", "4:3", "3:2", "16:9", "2.35:1", "4:5", "2:3", "9:16"],
          description: "Aspect ratio of the generated image. Defaults to '1:1'.",
        },
      },
      required: ["prompt", "output_path"],
    },
  },

  // ── Git tools (only offered when the project has a linked GitHub repo) ──
  git_status: {
    name: "git_status",
    description:
      "Show the working-tree status: current branch, ahead/behind counts, and lists of added/modified/deleted/untracked/conflicted files.",
    inputSchema: EMPTY_INPUT,
  },
  git_diff: {
    name: "git_diff",
    description:
      "Show the unified diff of working-tree changes. Optionally limit to a single path or show only staged changes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        staged: { type: "boolean" },
      },
    },
  },
  git_commit: {
    name: "git_commit",
    description:
      "Stage all working-tree changes and create a local commit. Does NOT push to GitHub — call git_push for that. Skipped silently if there's nothing to commit.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  git_push: {
    name: "git_push",
    description:
      'Push the current branch to GitHub. Returns code="non-fast-forward" when the remote has diverged — call git_pull first in that case. Use force=true only after the user explicitly approves overwriting remote.',
    inputSchema: {
      type: "object",
      properties: { force: { type: "boolean" } },
    },
  },
  git_pull: {
    name: "git_pull",
    description:
      "Fetch and merge the current branch from GitHub. Returns { clean: true } on fast-forward or { clean: false, conflicts: [paths] } when conflicts need resolving — use git_resolve_conflict for each.",
    inputSchema: EMPTY_INPUT,
  },
  git_resolve_conflict: {
    name: "git_resolve_conflict",
    description:
      "Resolve a merge conflict for a single file. Pass side='ours' or side='theirs' to use one wholesale, or pass content to write a custom merge. Afterwards call git_commit (with a merge message) to finalize once all conflicts are resolved.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        side: { type: "string", enum: ["ours", "theirs"] },
        content: { type: "string" },
      },
      required: ["path"],
    },
  },
  open_pull_request: {
    name: "open_pull_request",
    description:
      "Open a pull request from the current branch to the linked default branch (or a custom base). Push your changes first. Returns alreadyExists=true if a matching PR is already open.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        baseBranch: { type: "string" },
        headBranch: { type: "string" },
        draft: { type: "boolean" },
      },
      required: ["title"],
    },
  },
  set_git_autonomy: {
    name: "set_git_autonomy",
    description:
      "Record the user's chosen git-autonomy mode for this project. Call this exactly once after asking the autonomy question, with the value the user picked.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["autonomous", "manual", "ask-each-time"] },
      },
      required: ["mode"],
    },
  },
};

export interface SelectHostToolsInput {
  platform: string;
  hasBackend: boolean;
  hasGithub: boolean;
  stripeEnabled: boolean;
}

/**
 * Per-turn gating of which host tools an in-sandbox agent may call. Moved
 * VERBATIM from the Claude Code route so both routes offer the same surface —
 * /api/internal/claude-code-tool re-checks project state at execution time.
 *
 * Workspace control tools (dev server lifecycle + browser/dev logs) are always
 * available on sandboxed-web — they don't depend on backend type.
 * `convex_deploy` is gated on hasBackend because its deploy key must never
 * enter the sandbox env.
 */
export function selectHostTools(input: SelectHostToolsInput): string[] {
  const { platform, hasBackend, hasGithub, stripeEnabled } = input;
  const customTools: string[] = [];
  if (platform === "sandboxed-web") {
    customTools.push(
      "startDevServer",
      "stopDevServer",
      "isDevServerRunning",
      "getDevServerLog",
      "getBrowserLog",
      "refreshPreview",
      // In-chat question primitive — always available on sandboxed-web.
      "ask_question",
      // Env-var entry modal — agent picks the name, user types the value.
      "request_env_var",
      // AI image generation (FAL/Krea) — backend-agnostic; bills platform credits.
      "generate_image",
    );
    if (hasBackend) {
      customTools.push(
        "convex_deploy",
        "get_convex_logs",
        "list_convex_tables",
        "read_convex_table",
        "write_convex_data",
        "setup_auth",
        "setup_oauth_provider",
      );
      if (stripeEnabled) {
        customTools.push(
          "initialize_stripe_payments",
          "get_stripe_products",
          "create_stripe_product",
        );
      }
    }
    // Git tools — only when a repo is linked. Gating must match the project
    // state at turn-start; the host route also re-checks at execution time.
    if (hasGithub) {
      customTools.push(
        "git_status",
        "git_diff",
        "git_commit",
        "git_push",
        "git_pull",
        "git_resolve_conflict",
        "set_git_autonomy",
        "open_pull_request",
      );
    }
  } else if (platform === "swift") {
    // Simulator control — the sim never runs while the agent works (no HMR;
    // compiling is expensive). The agent opens it once its work is done.
    customTools.push(
      "start_simulator",
      "stop_simulator",
      "get_simulator_status",
      // In-chat question + env-var primitives are platform-agnostic.
      "ask_question",
      "request_env_var",
    );
    if (hasBackend) {
      // Swift + Convex backend: the deploy/logs/auth tools are platform-
      // agnostic server-side (the deploy pipeline zips /convex regardless of
      // frontend language; setup_auth is platform-aware in the host route).
      customTools.push("convex_deploy", "get_convex_logs", "setup_auth");
    }
    // Git tools — same surface as sandboxed-web. The host route executes them
    // via sandbox-git against the persistent sandbox, which is platform-
    // agnostic, and re-checks project.githubRepoOwner at execution time.
    if (hasGithub) {
      customTools.push(
        "git_status",
        "git_diff",
        "git_commit",
        "git_push",
        "git_pull",
        "git_resolve_conflict",
        "set_git_autonomy",
        "open_pull_request",
      );
    }
  }
  return customTools;
}
