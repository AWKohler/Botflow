/**
 * Source of the bridge script that runs inside the Vercel Sandbox.
 *
 * Exported as a string so we can write it to disk in the sandbox at setup
 * time — no template-repo changes, no CDN dependency. The script reads a JSON
 * config from stdin, drives @anthropic-ai/claude-agent-sdk, and streams events
 * back to stdout as NDJSON.
 *
 * Bump BRIDGE_SCRIPT_VERSION whenever the script source changes so the setup
 * helper knows to rewrite it on the next agent turn.
 */

export const BRIDGE_SCRIPT_VERSION = "33";

export const BRIDGE_SCRIPT_SOURCE = `#!/usr/bin/env node
/* eslint-disable */
/**
 * Botflow Claude Code bridge.
 *
 * Reads config from a JSON file (path in BOTFLOW_CONFIG_PATH), drives
 * @anthropic-ai/claude-agent-sdk's query(), streams events to stdout as NDJSON.
 *
 * Custom MCP tools (convex_deploy etc.) call back to our Next.js server via
 * HTTPS using a short-lived bearer token (BOTFLOW_TOOL_TOKEN). This keeps
 * sensitive credentials (e.g. platform-managed Convex deploy keys) on the
 * server — they never enter the sandbox env.
 *
 * Config shape:
 *   {
 *     prompt: string,
 *     images?: { media_type: string, data: string }[],  // base64 image blocks
 *     sessionId?: string,
 *     model?: string,
 *     cwd?: string,
 *     appendSystemPrompt?: string,
 *     customTools?: string[],         // names of MCP tools to enable
 *   }
 *
 * When images is present we drive query() in streaming-input mode (an async
 * iterable of one user message carrying [text?, ...image blocks]) instead of a
 * plain string prompt — a string can't carry images. The generator yields once
 * and completes, so the SDK runs a single turn just like string mode.
 *
 * Env vars (set by the host):
 *   BOTFLOW_CONFIG_PATH   — path to the config JSON file (required)
 *   BOTFLOW_API_BASE      — origin for our internal callback API (https://...)
 *   BOTFLOW_TOOL_TOKEN    — bearer token validated by the callback endpoint
 *   BOTFLOW_EVENT_FILE    — NDJSON tee file; every stdout event is also
 *                           appended here so the host can re-attach to this
 *                           turn after its streaming route dies (maxDuration)
 *   BOTFLOW_PID_FILE      — where to write our pid so the host can kill or
 *                           liveness-probe this bridge across requests
 *
 * stdout NDJSON events:
 *   { type: "ready" }
 *   { type: "session_started", sessionId }
 *   { type: "sdk_message", message }
 *   { type: "usage", tokens, breakdown }     — real token counts from the SDK
 *   { type: "compact_boundary", trigger, preTokens }   — auto/manual compaction
 *   { type: "compacting" }                   — status message: SDK is compacting
 *   { type: "end_turn" }
 *   { type: "error", error }
 */

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// Tee every event to BOTFLOW_EVENT_FILE (in addition to stdout). The file is
// what lets the host re-attach to this turn after the original streaming
// request dies at its serverless maxDuration — the bridge (and the turn)
// keep going regardless.
const EVENT_FILE = process.env.BOTFLOW_EVENT_FILE || null;

function emit(event) {
  const line = JSON.stringify(event) + "\\n";
  process.stdout.write(line);
  if (EVENT_FILE) {
    try { appendFileSync(EVENT_FILE, line); } catch { /* tee is best-effort */ }
  }
}

// The in-flight query() generator, held so SIGTERM can interrupt the claude
// subprocess instead of orphaning it — a superseded/stopped turn must stop
// editing files immediately.
let activeQuery = null;

process.on("SIGTERM", () => {
  try { emit({ type: "error", error: "Turn stopped (superseded by a new turn or stopped by the user)." }); } catch {}
  try {
    if (activeQuery && typeof activeQuery.interrupt === "function") {
      activeQuery.interrupt();
    }
  } catch {}
  // Give the interrupt a moment to reach the subprocess, then exit regardless.
  setTimeout(() => process.exit(1), 1500);
});

// ---------------------------------------------------------------------------
// Host callback for tools whose execution must stay on the server side.
//
// Bridge → POST {BOTFLOW_API_BASE}/api/internal/claude-code-tool
//   Authorization: Bearer {BOTFLOW_TOOL_TOKEN}
//   Body: { tool: string, input: object }
// Server runs the tool with its own credentials, returns
//   { ok: boolean, content: string | object }.
//
// WAITABLE TOOLS: modal-driven tools (setup_oauth_provider, request_env_var,
// initialize_stripe_payments) can't block inside one serverless invocation —
// the host route dies at its maxDuration long before a human finishes an
// OAuth console setup. Instead the host returns
//   { ok: true, pending: true, wait: { requestId, pollDelayMs } }
// and THIS loop re-polls briefly, then STOPS: pinning a live turn open for
// the minutes a console setup takes is how turns die mid-modal. Past the
// short grace below the model gets the host's pendingGuidance (modal stays
// open, system note fires on submit, tools are idempotent on re-call).
// ---------------------------------------------------------------------------
const WAIT_CLIENT_CAP_MS = 20 * 1000;
// ask_question is the one waitable tool worth blocking on: without the answer
// the model would have to guess. The host enforces its own ~5-min ceiling
// (auto-dismiss → terminal timeout result); this cap is a runaway backstop.
const ASK_QUESTION_CLIENT_CAP_MS = 8 * 60 * 1000;

function waitCapFor(toolName) {
  return toolName === "ask_question" ? ASK_QUESTION_CLIENT_CAP_MS : WAIT_CLIENT_CAP_MS;
}

// Per-request hard deadline. The host route's maxDuration is 300s (a cold
// convex_deploy legitimately runs minutes), so the default must exceed one
// full invocation — this only guards against a request that HANGS.
const DEFAULT_FETCH_TIMEOUT_MS = 330 * 1000;

async function postHostTool(toolName, input, timeoutMs) {
  const base = process.env.BOTFLOW_API_BASE;
  const token = process.env.BOTFLOW_TOOL_TOKEN;
  if (!base || !token) {
    throw new Error("Host callback not configured (BOTFLOW_API_BASE / BOTFLOW_TOOL_TOKEN missing)");
  }
  const deadlineMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_FETCH_TIMEOUT_MS;
  const headers = {
    "authorization": "Bearer " + token,
    "content-type": "application/json",
  };
  // Preview deployments answer cookie-less requests with the Vercel
  // Deployment Protection page (401) before our route ever runs — the same
  // wall the Anthropic-proxy calls dodge via ANTHROPIC_CUSTOM_HEADERS. The
  // host route sets this env only on protected previews.
  if (process.env.BOTFLOW_VERCEL_BYPASS) {
    headers["x-vercel-protection-bypass"] = process.env.BOTFLOW_VERCEL_BYPASS;
  }
  // A 429 from the host limiter is transient and self-clearing: the response
  // carries Retry-After, so pace against it instead of surfacing a turn-killing
  // "rate_limited" error the user has to manually retry. Bounded attempts so a
  // genuinely stuck limiter still eventually errors out.
  const MAX_429_RETRIES = 6;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(base + "/api/internal/claude-code-tool", {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: toolName, input: input ?? {} }),
      // Fresh deadline per attempt — a hung request aborts instead of
      // pinning the tool call open indefinitely.
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (response.status === 429 && attempt < MAX_429_RETRIES) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitSec = retryAfter > 0 ? retryAfter : Math.min(30, Math.pow(2, attempt));
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      continue;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error("Host tool call failed (HTTP " + response.status + "): " + text);
    }
    return response.json();
  }
}

async function callHostTool(toolName, input) {
  let result = await postHostTool(toolName, input);
  const startedWaiting = Date.now();
  let transientFailures = 0;
  while (result && result.pending === true && result.wait && result.wait.requestId) {
    // Short grace only (~two 20s host windows ≈ 45s wall-clock, since the
    // elapsed clock starts after the first window). A human filling an OAuth
    // console or hunting an API key takes MINUTES — blocking a live turn that
    // long is how turns die mid-modal. Past the grace, surface the host's
    // pendingGuidance: the modal stays open, a system note fires on submit,
    // and the waitable tools are idempotent (re-call returns success
    // instantly once the user has finished).
    if (Date.now() - startedWaiting > waitCapFor(toolName)) {
      if (toolName === "ask_question") {
        // Questions have no wait marker or system-note path — past the
        // backstop just tell the model to proceed with a default.
        return {
          ok: true,
          content:
            "No answer arrived in time. Continue with a reasonable default; do not block on this question.",
          answered: false,
          timedOut: true,
        };
      }
      // First tell the host we stopped so it clears the "agent is waiting"
      // marker (otherwise a save within the marker's TTL would skip the
      // workspace system-note and the completion would be lost). The host's
      // reply doubles as a final status check: if the user's save slipped
      // into the gap, it returns the terminal result with finalized:true —
      // deliver THAT to the model instead of "still pending".
      try {
        const stopRes = await postHostTool(toolName, {
          ...(input ?? {}),
          waitRequestId: result.wait.requestId,
          stopWaiting: true,
        });
        if (stopRes && stopRes.finalized === true) return stopRes;
      } catch {
        // Marker clearing is best-effort; the still-pending guidance below
        // is still correct and the marker TTL expires on its own.
      }
      return {
        ok: true,
        status: "still-pending",
        content:
          (typeof result.pendingGuidance === "string" && result.pendingGuidance) ||
          ("The user has not finished this yet — the request is still pending and the modal stays open in their workspace. " +
            "Do NOT report it as dismissed or declined. Continue other work or end your turn; " +
            "you'll get a system note when the user completes it, and calling the tool again later is safe."),
      };
    }
    const delay = Number(result.wait.pollDelayMs) > 0 ? Number(result.wait.pollDelayMs) : 2500;
    await new Promise((r) => setTimeout(r, delay));
    try {
      result = await postHostTool(toolName, { ...(input ?? {}), waitRequestId: result.wait.requestId });
      transientFailures = 0;
    } catch (err) {
      // Don't let one blip (redeploy, network hiccup) abort a long human
      // wait — retry a few times before surfacing the error.
      transientFailures += 1;
      if (transientFailures >= 5) throw err;
    }
  }
  return result;
}

// Helper: wrap a host-tool callback into the MCP CallToolResult shape.
// Every custom tool we register has the same shape, so factoring this out
// keeps the registrations short and uniform.
function makeHostToolHandler(toolName) {
  return async (args) => {
    try {
      const result = await callHostTool(toolName, args || {});
      const text = typeof result === "string"
        ? result
        : (result && result.content)
          ? (typeof result.content === "string" ? result.content : JSON.stringify(result.content))
          : JSON.stringify(result);
      const isError = result && result.ok === false;
      return {
        content: [{ type: "text", text }],
        ...(isError ? { isError: true } : {}),
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: err && err.message ? err.message : String(err) }],
        isError: true,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Native AskUserQuestion → Botflow question UI.
//
// Claude Code's built-in AskUserQuestion tool requests user input through the
// canUseTool callback (the SDK invokes it even under bypassPermissions — it's
// an input request, not a permission check). Without a handler the call never
// reaches the user and the question UI never shows. We forward it to the same
// host "ask_question" endpoint the MCP tool uses, so both tools share one
// chat_questions row + QuestionPrompt UI + answer flow, then hand the answers
// back to the SDK in its expected { questions, answers: { [questionText]:
// label } } shape (recent CLIs look answers up by question text).
// ---------------------------------------------------------------------------
async function handleNativeAskUserQuestion(input) {
  const rawQuestions = Array.isArray(input && input.questions) ? input.questions : [];
  if (rawQuestions.length === 0) {
    return { behavior: "deny", message: "AskUserQuestion requires a non-empty questions array." };
  }

  // Convert to the host ask_question schema, which requires ids. Ids are
  // deterministic ("q-0", "opt-0-1") — the stream translator derives the same
  // ids for the UI card, so the user's selectedIds line up with these.
  const converted = rawQuestions.map((q, qi) => ({
    id: "q-" + qi,
    ...(q && q.header ? { header: String(q.header) } : {}),
    question: q && typeof q.question === "string" ? q.question : "",
    options: (q && Array.isArray(q.options) ? q.options : []).map((opt, oi) => ({
      id: "opt-" + qi + "-" + oi,
      label: opt && typeof opt.label === "string" ? opt.label : "Option " + (oi + 1),
      ...(opt && opt.description ? { description: String(opt.description) } : {}),
    })),
    multiSelect: !!(q && q.multiSelect),
  }));

  // One host call for all questions: the host blocks (up to 5 min) until the
  // user answers or dismisses in the workspace UI.
  const result = await callHostTool("ask_question", { questions: converted });
  if (!result || result.answered !== true) {
    return {
      behavior: "deny",
      message:
        "The user dismissed the question (or it timed out) without answering. " +
        "Do not ask again; continue with a reasonable default.",
    };
  }

  const labels = Array.isArray(result.selectedLabels) ? result.selectedLabels : [];
  let answerText = labels.join(", ");
  if (result.customText) {
    answerText = answerText ? answerText + " — " + result.customText : String(result.customText);
  }
  if (!answerText) answerText = "(no selection)";

  // The Botflow question card collects a single answer (for the first
  // question), so map it there and mark any extras unanswered.
  const answers = {};
  converted.forEach((q, qi) => {
    answers[q.question] = qi === 0
      ? answerText
      : "(not answered — the user was only shown the first question; use your best judgment)";
  });

  return { behavior: "allow", updatedInput: { questions: rawQuestions, answers } };
}

function buildCustomTools(customTools, oauthProviderIds) {
  if (!Array.isArray(customTools) || customTools.length === 0) return [];
  const tools = [];

  if (customTools.includes("convex_deploy")) {
    tools.push(
      tool(
        "convex_deploy",
        "Deploy the project's /convex folder to its Convex deployment. " +
        "Call this AFTER editing files under /convex/ — changes are not live until deployed. " +
        "Takes no arguments; the project's deploy key is resolved server-side.",
        {},
        makeHostToolHandler("convex_deploy"),
        { annotations: { destructiveHint: true } },
      ),
    );
  }

  if (customTools.includes("list_muhkoo_tables")) {
    tools.push(
      tool(
        "list_muhkoo_tables",
        "List this project's MuhKoo database tables with their columns and types. " +
        "Use it to discover the app's schema before reading data or writing frontend code against a table — the shapes here are authoritative, not what the client code assumes. " +
        "Returns { ok, tables: [{ table, columns: [{ name, type }] }] }.",
        {},
        makeHostToolHandler("list_muhkoo_tables"),
      ),
    );
  }

  if (customTools.includes("read_muhkoo_table")) {
    tools.push(
      tool(
        "read_muhkoo_table",
        "Read rows from one MuhKoo database table. " +
        "Use it to inspect real data, verify a write from the app actually landed, or check a row's shape before coding against it. " +
        "Optionally filter with \`where\` — e.g. scope to one user with { column: 'owner', op: 'eq', value: '<commitment>' }. " +
        "Returns { ok, rows, nextCursor }; pass nextCursor back as cursor to page further. Each row includes its \`_id\`.",
        {
          table: z.string().describe("Table name (from list_muhkoo_tables)."),
          where: z
            .array(
              z.object({
                column: z.string(),
                op: z.enum([
                  "eq",
                  "neq",
                  "gt",
                  "gte",
                  "lt",
                  "lte",
                  "in",
                  "like",
                  "likeStartsWith",
                  "likeContains",
                ]),
                value: z.unknown(),
              }),
            )
            .optional(),
          limit: z.number().int().positive().optional(),
          cursor: z.string().optional(),
        },
        makeHostToolHandler("read_muhkoo_table"),
      ),
    );
  }

  if (customTools.includes("provision_muhkoo_table")) {
    tools.push(
      tool(
        "provision_muhkoo_table",
        "Provision (create or extend) a MuhKoo database table so the frontend can read/write it via client.db.table(name). " +
        "MuhKoo tables are created SERVER-SIDE — you cannot create them from client code, so call this BEFORE using a new table. " +
        "Additive only: adding columns is fine, but dropping or retyping a column fails. Column types: text | integer | real | boolean | timestamp | json. A synthetic _id primary key is added automatically. A default 'items' table already exists.",
        {
          table: z
            .string()
            .describe("Table name, e.g. 'bookings' (lowercase letters, numbers, underscores)."),
          columns: z
            .array(
              z.object({
                name: z.string(),
                type: z.enum(["text", "integer", "real", "boolean", "timestamp", "json"]),
              }),
            )
            .describe("Columns to create or add."),
        },
        makeHostToolHandler("provision_muhkoo_table"),
      ),
    );
  }

  if (customTools.includes("get_convex_logs")) {
    tools.push(
      tool(
        "get_convex_logs",
        "Read recent function-execution logs from this project's Convex deployment — query/mutation/action completions, their console.log output, execution time, and thrown errors. " +
        "Use this to debug WHY a Convex function failed: Convex hides thrown error details from the browser client, but they appear here. " +
        "Set onlyErrors=true to filter to just failed calls. Returns the most recent entries (default 50, max 200).",
        {
          limit: z.number().int().positive().optional(),
          onlyErrors: z.boolean().optional(),
        },
        makeHostToolHandler("get_convex_logs"),
      ),
    );
  }

  if (customTools.includes("setup_auth")) {
    tools.push(
      tool(
        "setup_auth",
        "Provision Convex Auth (email + password sign-in) on this project. Call this ONCE when the user wants accounts / login / sign-up / per-user data. " +
        "It generates RSA signing keys server-side and sets them on the Convex deployment (you never see them), then returns JSON with 'files' (boilerplate to write verbatim), 'packagesToInstall', and 'context' (the full reference — READ IT; it is platform-specific). " +
        "After it returns: write every file in 'files' (merge your existing schema tables into the returned schema.ts, keeping ...authTables), install the packages in /convex's package scope, then run convex_deploy — auth is not live until deployed. " +
        "Calling again just rotates the signing keys.",
        {},
        makeHostToolHandler("setup_auth"),
        { annotations: { destructiveHint: true } },
      ),
    );
  }

  if (customTools.includes("setup_oauth_provider")) {
    const oauthIds = Array.isArray(oauthProviderIds) && oauthProviderIds.length
      ? oauthProviderIds
      : ["google"];
    const oauthList = oauthIds.join(", ");
    tools.push(
      tool(
        "setup_oauth_provider",
        "Add a social sign-in provider (" + oauthList + ") to Convex Auth on this project. " +
        "Opens a modal in the user's workspace where they register an app with the provider and paste their credentials (Apple uploads a .p8). " +
        "ONLY call this when the user EXPLICITLY asks for social sign-in; otherwise default to password sign-in via setup_auth. " +
        "PREREQUISITE: setup_auth must have run first. " +
        "IDEMPOTENT: once the provider's credentials are saved it returns success IMMEDIATELY (no modal) with the exact registration snippet — " +
        "safe to call any time you need the wiring instructions. Pass reconfigure:true ONLY when the user explicitly wants to REPLACE saved credentials (reopens the modal). " +
        "WAITING: console setup takes the user minutes — this tool waits only briefly, then returns 'still pending' while the modal STAYS OPEN. " +
        "That is normal, not an error: continue other work or end your turn; a system note arrives when they save, then call this tool again for the snippet. " +
        "NEVER re-call in a tight loop, and NEVER report a still-pending modal as dismissed or declined. " +
        "'dismissed' means the user explicitly closed the modal — do NOT retry. " +
        "On success: register the provider in convex/auth.ts EXACTLY as the returned snippet shows (Apple REQUIRES the custom profile() mapping in it — " +
        "omitting it breaks account creation), run convex_deploy, then follow the snippet's remaining platform steps " +
        "(web: wire the sign-in button via startOAuthSignIn; Swift: NO client code — the hosted sign-in page updates automatically). " +
        "Until success is returned, do NOT edit convex/auth.ts or add/expose the provider sign-in UI. " +
        "VERIFY before declaring done: after deploying, ask the user for one test sign-in and check get_convex_logs for auth errors.",
        {
          provider: z
            .enum(oauthIds)
            .describe("Provider id (required, no default): " + oauthList + "."),
          reconfigure: z
            .boolean()
            .optional()
            .describe(
              "Reopen the credentials modal even though this provider is already configured — ONLY when the user explicitly asks to replace the saved credentials.",
            ),
        },
        makeHostToolHandler("setup_oauth_provider"),
      ),
    );
  }

  if (customTools.includes("list_convex_tables")) {
    tools.push(
      tool(
        "list_convex_tables",
        "List the user tables in this project's Convex deployment. " +
        "Use it to discover what data the app stores before reading or editing. Convex has no SQL — inspect data with read_convex_table. " +
        "Returns { ok, tables }.",
        {},
        makeHostToolHandler("list_convex_tables"),
      ),
    );
  }

  if (customTools.includes("read_convex_table")) {
    tools.push(
      tool(
        "read_convex_table",
        "Read a page of documents from one Convex table (newest first by default). " +
        "Use it to inspect real data, verify a mutation worked, or gather the _id values you need before editing. " +
        "Returns { ok, documents, continueCursor, isDone }; pass continueCursor back as cursor to page further. Each document includes its _id.",
        {
          table: z.string(),
          limit: z.number().int().positive().optional(),
          order: z.enum(["asc", "desc"]).optional(),
          cursor: z.string().optional(),
        },
        makeHostToolHandler("read_convex_table"),
      ),
    );
  }

  if (customTools.includes("write_convex_data")) {
    tools.push(
      tool(
        "write_convex_data",
        "Directly edit data in this project's Convex database — insert, patch, replace, or delete documents — without writing or deploying a Convex function. The streamlined path for one-off data fixes, seeding, or corrections. " +
        "CONFIRMATION REQUIRED: always call first WITHOUT confirmed to get a preview (status='needs-confirmation', no write happens). Show the user what will change, ask approval with the AskUserQuestion/ask tool, then call again with the SAME args plus confirmed:true. " +
        "Operations: insert (table + documents, no _id); patch (table + ids + fields, merges fields, no keys starting with _); replace (id + document, full overwrite); delete (table + ids, permanent). Get _id values from read_convex_table first.",
        {
          operation: z.enum(["insert", "patch", "replace", "delete"]),
          table: z.string().optional(),
          documents: z.array(z.record(z.string(), z.any())).optional(),
          ids: z.array(z.string()).optional(),
          fields: z.record(z.string(), z.any()).optional(),
          id: z.string().optional(),
          document: z.record(z.string(), z.any()).optional(),
          confirmed: z.boolean().optional(),
        },
        makeHostToolHandler("write_convex_data"),
        { annotations: { destructiveHint: true } },
      ),
    );
  }

  if (customTools.includes("initialize_stripe_payments")) {
    tools.push(
      tool(
        "initialize_stripe_payments",
        "Set up Stripe payments for this project. Call when the user asks to add checkout, subscriptions, billing, a paywall, or any payment flow. " +
        "Stripe Standard Connect — the user links their own Stripe account once and reuses it across every Botflow project. " +
        "If they've already linked it: returns status='already-connected' immediately. " +
        "Otherwise: opens a modal in the workspace and waits briefly while the user clicks Connect with Stripe and authorizes. " +
        "Returns status='connected' on success; 'dismissed' means the user explicitly cancelled (do NOT retry — continue and tell the user they can connect later); " +
        "'still-pending' means the user hasn't finished YET — the modal stays open, so NEVER describe it as dismissed or declined; " +
        "continue other work or end your turn, a system note arrives when they connect, then call this again (returns already-connected with next steps); " +
        "'tier-blocked' (Free; relay message); 'backend-blocked' (no Convex backend).",
        {},
        makeHostToolHandler("initialize_stripe_payments"),
      ),
    );
  }

  if (customTools.includes("initialize_revenuecat_payments")) {
    tools.push(
      tool(
        "initialize_revenuecat_payments",
        "Set up RevenueCat in-app purchases for this Swift project. Call this FIRST for a paywall, subscriptions, premium features, consumables, or any iOS payment flow. It opens the Payments setup wizard when needed and returns already-connected, needs-connect, tier-blocked, or backend-blocked. Never hardcode SDK keys; Botflow writes RevenueCatConfig.swift before builds.",
        {},
        makeHostToolHandler("initialize_revenuecat_payments"),
      ),
    );
  }

  if (customTools.includes("get_stripe_products")) {
    tools.push(
      tool(
        "get_stripe_products",
        "List the Stripe Products and Prices on the user's connected account for this project's current test/live mode. " +
        "Call this BEFORE writing checkout code so you reference a product by its lookupKey — never invent or hardcode a price_ id. " +
        "Returns { ok, mode, products: [{ productId, name, prices: [{ priceId, lookupKey, unitAmount, currency, recurring }] }] }. " +
        "Use the lookupKey (not priceId) in checkout — it resolves to the right price in whichever mode is active. " +
        "If the account has no products, create one with create_stripe_product. " +
        "Returns status='not-connected' if Stripe isn't linked (run initialize_stripe_payments first) or status='tier-blocked' for Free users.",
        {},
        makeHostToolHandler("get_stripe_products"),
      ),
    );
  }

  if (customTools.includes("create_stripe_product")) {
    tools.push(
      tool(
        "create_stripe_product",
        "Create a Stripe Product + Price on the user's connected account and get back a stable lookupKey. " +
        "Use when the app needs a product/price that doesn't exist yet (check first with get_stripe_products). " +
        "unitAmount is in cents: 1500 = 15.00 USD. Omit interval for a one-time price; set it ('month'/'year'/etc.) for a subscription. " +
        "Returns { ok, productId, priceId, lookupKey, ... } — store the lookupKey in the app and pass it to createCheckoutSession, " +
        "NEVER the raw price_ id. The lookupKey is mode-agnostic and is mirrored across test/live on switch, so checkout never breaks.",
        {
          name: z.string(),
          unitAmount: z.number().int().positive(),
          currency: z.string().optional(),
          description: z.string().optional(),
          interval: z.enum(["day", "week", "month", "year"]).optional(),
          intervalCount: z.number().int().positive().optional(),
        },
        makeHostToolHandler("create_stripe_product"),
      ),
    );
  }

  // ── Workspace control: dev server lifecycle + browser/dev logs ────────
  if (customTools.includes("startDevServer")) {
    tools.push(
      tool(
        "startDevServer",
        "Start the project's Vite dev server inside the sandbox. Idempotent — restarts cleanly if already running. Returns the public preview URL once reachable.",
        {},
        makeHostToolHandler("startDevServer"),
      ),
    );
  }

  if (customTools.includes("stopDevServer")) {
    tools.push(
      tool(
        "stopDevServer",
        "Stop the running dev server (kills the vite process). Idempotent.",
        {},
        makeHostToolHandler("stopDevServer"),
      ),
    );
  }

  if (customTools.includes("isDevServerRunning")) {
    tools.push(
      tool(
        "isDevServerRunning",
        "Check whether the dev server is currently running. Cheap (~50ms). Use before reading logs or refreshing the preview if you're not sure.",
        {},
        makeHostToolHandler("isDevServerRunning"),
      ),
    );
  }

  if (customTools.includes("getDevServerLog")) {
    tools.push(
      tool(
        "getDevServerLog",
        "Tail the dev server stdout/stderr (vite output: HMR events, build errors, warnings).",
        { linesBack: z.number().int().positive().optional() },
        makeHostToolHandler("getDevServerLog"),
      ),
    );
  }

  if (customTools.includes("getBrowserLog")) {
    tools.push(
      tool(
        "getBrowserLog",
        "Read the BROWSER console log from the running preview iframe — console.log/warn/error, runtime JS errors, React errors, Vite HMR events. Indispensable for diagnosing why a feature isn't working in the user's preview.",
        { linesBack: z.number().int().positive().optional() },
        makeHostToolHandler("getBrowserLog"),
      ),
    );
  }

  if (customTools.includes("refreshPreview")) {
    tools.push(
      tool(
        "refreshPreview",
        "Force the preview iframe in the user's workspace to hard-reload. Useful after changes that Vite HMR cannot pick up.",
        {},
        makeHostToolHandler("refreshPreview"),
      ),
    );
  }

  // ── Simulator control (Swift) — desired-state via the host, honored by the
  // user's open workspace (it owns the stream). ─────────────────────────────
  if (customTools.includes("start_simulator")) {
    tools.push(
      tool(
        "start_simulator",
        "Build the project and run it on the iOS simulator in the user's workspace. The simulator does NOT run while you work (no HMR — compiling is expensive), so call this ONCE at the END of your turn, after your changes are complete. " +
        "This tool BLOCKS until the build finishes (several minutes for large projects) and returns the build outcome: on failure you get the compiler errors/warnings — fix them and call start_simulator again; on success you get any warnings and the app launches on the simulator. " +
        "If the user's workspace tab is closed, it returns status='workspace-closed' within ~30 seconds. Do NOT call this mid-work or when the build is known-broken.",
        {},
        makeHostToolHandler("start_simulator"),
      ),
    );
  }

  if (customTools.includes("stop_simulator")) {
    tools.push(
      tool(
        "stop_simulator",
        "Stop the running iOS simulator stream in the user's workspace. Use when the user asks to stop it, or before making a large batch of changes that would make the running build stale.",
        {},
        makeHostToolHandler("stop_simulator"),
      ),
    );
  }

  if (customTools.includes("get_simulator_status")) {
    tools.push(
      tool(
        "get_simulator_status",
        "Check whether the iOS simulator is currently running/streaming in the user's workspace. Returns state ('stopped' | 'starting' | 'building' | 'installing' | 'live' | 'failed'), the device model, any pending start/stop request, and lastBuild (the most recent build's outcome + diagnostics — useful if start_simulator timed out while the build was still running). Cheap — call before start_simulator if unsure.",
        {},
        makeHostToolHandler("get_simulator_status"),
      ),
    );
  }

  if (customTools.includes("ask_question")) {
    tools.push(
      tool(
        "ask_question",
        "Ask the user a multiple-choice question inline in the chat. Use when you genuinely need a decision and continuing without it would be guessing. Each question needs: id (slug), question (prompt), options (each with id, label, optional description). Optional: header, multiSelect (default false), allowCustom + customPlaceholder for free-form input. Blocks up to 5 minutes; returns { answered: false } on dismiss/timeout — proceed without that input.",
        {
          questions: z.array(z.object({
            id: z.string(),
            header: z.string().optional(),
            question: z.string(),
            options: z.array(z.object({
              id: z.string(),
              label: z.string(),
              description: z.string().optional(),
            })),
            multiSelect: z.boolean().optional(),
            allowCustom: z.boolean().optional(),
            customPlaceholder: z.string().optional(),
          })),
        },
        makeHostToolHandler("ask_question"),
      ),
    );
  }

  if (customTools.includes("generate_image")) {
    tools.push(
      tool(
        "generate_image",
        "Generate an image with AI (Krea 2 Medium) from a text prompt and save it into the project at the given path. " +
        "Blocks until generation finishes (typically 10-30s); on success the file exists in the project immediately. " +
        "Use for hero images, backgrounds, illustrations, placeholder photos, textures, etc. " +
        "Put web assets under public/ (e.g. public/images/hero.png) and reference them by URL path ('/images/hero.png'), or under src/assets/ for bundled imports. Use a .png or .jpg extension. " +
        "Each call costs the user credits, so don't regenerate an image that already looks right and don't call this speculatively. " +
        "Pro/Max feature: for Free users this returns a tier-blocked error — relay it to the user and do NOT retry; fall back to CSS/gradients or existing assets.",
        {
          prompt: z.string().describe("Text description of the image to generate. Be concrete about subject, style, lighting, and mood."),
          output_path: z.string().describe("Project-relative file path to save the image to, e.g. public/images/hero.png. Parent directories are created automatically."),
          aspect_ratio: z.enum(["1:1", "4:3", "3:2", "16:9", "2.35:1", "4:5", "2:3", "9:16"]).optional().describe("Aspect ratio of the generated image. Defaults to '1:1'."),
        },
        makeHostToolHandler("generate_image"),
      ),
    );
  }

  if (customTools.includes("request_env_var")) {
    tools.push(
      tool(
        "request_env_var",
        "Ask the user to enter the value of an environment variable. Opens a modal in the user's workspace showing the variable NAME you chose; the user types only the VALUE. The value is stored server-side and NEVER shown to you — assume it is set and write code that reads it. " +
        "Targets: 'client' = frontend Vite .env (only VITE_-prefixed vars reach browser code); 'server' = the Convex deployment env (process.env in Convex functions; requires a backend). " +
        "Use for third-party API keys, webhook secrets, etc. Set isSecret=true for sensitive values. Include a short message explaining what the value is and where to find it — it's rendered in the modal. " +
        "Waits briefly for the user to save; finding an API key can take a while, so a 'still pending' result is normal — " +
        "the modal STAYS OPEN, you'll get a system note when they save, and until then continue work that doesn't need the value (never call that dismissed). " +
        "'dismissed' means the user explicitly closed the modal: do NOT retry automatically; continue without it.",
        {
          target: z.enum(["client", "server"]),
          key: z.string(),
          message: z.string().optional(),
          isSecret: z.boolean().optional(),
        },
        makeHostToolHandler("request_env_var"),
      ),
    );
  }

  // ── Git tools (Phase D — only registered when project has a GitHub repo) ──
  // The host route gates these on project.githubRepoOwner; we still need to
  // advertise them to Claude Code when the route includes them in customTools.
  if (customTools.includes("git_status")) {
    tools.push(
      tool(
        "git_status",
        "Show the working-tree status: current branch, ahead/behind counts, and lists of added/modified/deleted/untracked/conflicted files.",
        {},
        makeHostToolHandler("git_status"),
      ),
    );
  }
  if (customTools.includes("git_diff")) {
    tools.push(
      tool(
        "git_diff",
        "Show the unified diff of working-tree changes. Optionally limit to a single path or show only staged changes.",
        {
          path: z.string().optional(),
          staged: z.boolean().optional(),
        },
        makeHostToolHandler("git_diff"),
      ),
    );
  }
  if (customTools.includes("git_commit")) {
    tools.push(
      tool(
        "git_commit",
        "Stage all working-tree changes and create a local commit. Does NOT push to GitHub — call git_push for that. Skipped silently if there's nothing to commit.",
        { message: z.string() },
        makeHostToolHandler("git_commit"),
      ),
    );
  }
  if (customTools.includes("git_push")) {
    tools.push(
      tool(
        "git_push",
        "Push the current branch to GitHub. Returns code=\\\"non-fast-forward\\\" when the remote has diverged — call git_pull first in that case. Use force=true only after the user explicitly approves overwriting remote.",
        { force: z.boolean().optional() },
        makeHostToolHandler("git_push"),
      ),
    );
  }
  if (customTools.includes("git_pull")) {
    tools.push(
      tool(
        "git_pull",
        "Fetch and merge the current branch from GitHub. Returns { clean: true } on fast-forward or { clean: false, conflicts: [paths] } when conflicts need resolving — use git_resolve_conflict for each.",
        {},
        makeHostToolHandler("git_pull"),
      ),
    );
  }
  if (customTools.includes("git_resolve_conflict")) {
    tools.push(
      tool(
        "git_resolve_conflict",
        "Resolve a merge conflict for a single file. Pass side='ours' or side='theirs' to use one wholesale, or pass content to write a custom merge. Afterwards call git_commit (with a merge message) to finalize once all conflicts are resolved.",
        {
          path: z.string(),
          side: z.enum(["ours", "theirs"]).optional(),
          content: z.string().optional(),
        },
        makeHostToolHandler("git_resolve_conflict"),
      ),
    );
  }
  if (customTools.includes("open_pull_request")) {
    tools.push(
      tool(
        "open_pull_request",
        "Open a pull request from the current branch to the linked default branch (or a custom base). Push your changes first. Returns alreadyExists=true if a matching PR is already open.",
        {
          title: z.string(),
          body: z.string().optional(),
          baseBranch: z.string().optional(),
          headBranch: z.string().optional(),
          draft: z.boolean().optional(),
        },
        makeHostToolHandler("open_pull_request"),
      ),
    );
  }

  if (customTools.includes("set_git_autonomy")) {
    tools.push(
      tool(
        "set_git_autonomy",
        "Record the user's chosen git-autonomy mode for this project. Call this exactly once after asking the autonomy question, with the value the user picked.",
        {
          mode: z.enum(["autonomous", "manual", "ask-each-time"]),
        },
        makeHostToolHandler("set_git_autonomy"),
      ),
    );
  }

  return tools;
}

async function main() {
  const configPath = process.env.BOTFLOW_CONFIG_PATH;
  if (!configPath) {
    emit({ type: "error", error: "BOTFLOW_CONFIG_PATH env var is required" });
    process.exit(1);
  }

  let config;
  try {
    const raw = await readFile(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch (err) {
    emit({ type: "error", error: "Failed to read config file: " + (err && err.message ? err.message : String(err)) });
    process.exit(1);
  }

  // Advertise our pid so the host can kill/probe this bridge from a later
  // request (one bridge per project — the next turn kills us first).
  const pidFile = process.env.BOTFLOW_PID_FILE;
  if (pidFile) {
    try {
      mkdirSync(dirname(pidFile), { recursive: true });
      writeFileSync(pidFile, String(process.pid));
    } catch { /* liveness probing degrades gracefully without it */ }
  }

  emit({ type: "ready" });

  const { prompt, images, sessionId, model, cwd, appendSystemPrompt, customTools, oauthProviderIds } = config;

  const tools = buildCustomTools(customTools, oauthProviderIds);
  const mcpServer = tools.length > 0 ? createSdkMcpServer({ name: "botflow", tools }) : null;

  const options = {
    ...(sessionId ? { resume: sessionId } : {}),
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(appendSystemPrompt
      ? {
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: appendSystemPrompt,
          },
        }
      : {}),
    ...(mcpServer
      ? {
          // v0.3+ shape: the server instance is the value directly. The old
          // { type: "sdk", name, instance } wrapper was for pre-release
          // versions; passing it now causes connectSdkMcpServer to throw
          // "X.connect is not a function" because the SDK calls .connect()
          // on the wrapper object instead of the server.
          mcpServers: {
            botflow: mcpServer,
          },
          // Auto-approve our own MCP tools. permissionMode: bypassPermissions
          // also covers them, but listing explicitly here is more surgical and
          // matches the SDK's recommended pattern.
          allowedTools: [
            "mcp__botflow__*",
          ],
        }
      : {}),
    // Auto-accept all tool calls. We're running in an isolated per-project
    // sandbox where the user explicitly opted into Claude Code by selecting
    // a Claude model — there's no human to approve individual writes, and
    // the action stream surfaced in the Botflow UI is the user-visible audit
    // trail. Equivalent to claude --dangerously-skip-permissions.
    permissionMode: "bypassPermissions",
    // AskUserQuestion is routed through canUseTool even in bypassPermissions
    // mode — it's a user-input request, not a permission check. Everything
    // else is allowed unchanged (bypassPermissions already covers it; this is
    // just the backstop for any call the SDK still routes here).
    canUseTool: async (toolName, toolInput) => {
      if (toolName === "AskUserQuestion") {
        try {
          return await handleNativeAskUserQuestion(toolInput);
        } catch (err) {
          return {
            behavior: "deny",
            message: "Question UI unavailable: " + (err && err.message ? err.message : String(err)),
          };
        }
      }
      return { behavior: "allow", updatedInput: toolInput };
    },
    env: { ...process.env },
    includePartialMessages: false,
  };

  // Build the prompt for query(). With no images we pass the plain string
  // (single-shot "print" mode). With images we MUST use streaming-input mode:
  // a string prompt can't carry image blocks. We yield exactly one user message
  // whose content is [text?, ...image blocks], then let the generator complete
  // — the SDK runs one turn and the async iterator ends after the result
  // message, same as string mode.
  let queryPrompt = prompt;
  if (Array.isArray(images) && images.length > 0) {
    const content = [];
    if (typeof prompt === "string" && prompt.length > 0) {
      content.push({ type: "text", text: prompt });
    }
    for (const img of images) {
      if (img && typeof img.data === "string" && img.data.length > 0) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: typeof img.media_type === "string" ? img.media_type : "image/jpeg",
            data: img.data,
          },
        });
      }
    }
    if (content.length > 0) {
      queryPrompt = (async function* () {
        yield {
          type: "user",
          message: { role: "user", content: content },
          parent_tool_use_id: null,
        };
      })();
    }
  }

  let lastSessionId = null;

  // ---------------------------------------------------------------------------
  // Token usage + compaction tracking.
  //
  // SDKAssistantMessage.message.usage and SDKResultMessage.usage both carry
  // Anthropic-shape totals: input_tokens, output_tokens, cache_creation_input_tokens,
  // cache_read_input_tokens. The "context size" sent on a turn is
  // input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
  //
  // SDKCompactBoundaryMessage marks where Claude auto-compacted (or where the
  // user ran /compact). After the boundary the next assistant message's usage
  // will reflect a much smaller context — the bar should drop accordingly.
  // ---------------------------------------------------------------------------
  function extractUsage(u) {
    if (!u || typeof u !== "object") return null;
    const input = Number(u.input_tokens || 0);
    const output = Number(u.output_tokens || 0);
    const cacheCreate = Number(u.cache_creation_input_tokens || 0);
    const cacheRead = Number(u.cache_read_input_tokens || 0);
    const contextTokens = input + cacheCreate + cacheRead;
    return {
      tokens: contextTokens,
      breakdown: {
        input,
        output,
        cacheCreate,
        cacheRead,
      },
    };
  }

  try {
    activeQuery = query({ prompt: queryPrompt, options });
    for await (const message of activeQuery) {
      if (message && message.session_id && message.session_id !== lastSessionId) {
        lastSessionId = message.session_id;
        emit({ type: "session_started", sessionId: message.session_id });
      }
      emit({ type: "sdk_message", message });

      // Pull real token usage out of assistant/result messages so the UI can
      // drive its context-usage bar from authoritative numbers.
      if (message && message.type === "assistant" && message.message && message.message.usage) {
        const u = extractUsage(message.message.usage);
        if (u) emit({ type: "usage", source: "assistant", ...u });
      } else if (message && message.type === "result" && message.usage) {
        const u = extractUsage(message.usage);
        if (u) emit({ type: "usage", source: "result", ...u });
      }

      // Surface compaction so the UI can render a "context compacted" divider
      // and reset its bar basis. The next assistant usage will already reflect
      // the post-compaction context.
      if (message && message.type === "system" && message.subtype === "compact_boundary") {
        const meta = message.compact_metadata || {};
        emit({
          type: "compact_boundary",
          trigger: meta.trigger || "auto",
          preTokens: Number(meta.pre_tokens || 0),
        });
      } else if (message && message.type === "system" && message.subtype === "status" && message.status === "compacting") {
        emit({ type: "compacting" });
      }
    }
    emit({ type: "end_turn" });
    process.exit(0);
  } catch (err) {
    // Include the constructor name and a trimmed stack so a minified or
    // cryptic message (e.g. "Q.connect is not a function") still tells us
    // which library/file threw. Falls back to plain message if the error
    // lacks structure. NB: this code runs inside the SANDBOX as plain JS,
    // not in the TS template — every \${...} here is escaped because the
    // bridge file is itself a TS template literal.
    const name = (err && err.constructor && err.constructor.name) || "Error";
    const message = (err && err.message) || String(err);
    const stack = (err && err.stack) ? String(err.stack).split("\\n").slice(0, 6).join("\\n") : "";
    const summary = stack ? \`\${name}: \${message}\\n\${stack}\` : \`\${name}: \${message}\`;
    emit({ type: "error", error: summary });
    process.exit(1);
  }
}

main();
`;
