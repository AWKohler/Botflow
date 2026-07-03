/**
 * Source of the Botflow MCP server that runs inside the Vercel Sandbox for
 * the OpenCode agent path.
 *
 * OpenCode registers it as a local stdio MCP server (config `mcp.botflow`).
 * It advertises the platform ("host") tools from
 * src/lib/agent/host-tools/definitions.ts and forwards every call to our
 * Next.js server at /api/internal/claude-code-tool with a short-lived bearer
 * token — byte-compatible with the CC bridge's callHostTool contract, so both
 * agents hit the same host endpoint with the same semantics.
 *
 * The definitions are embedded as a JSON literal at module-eval time, so the
 * script stays static and versionable (OPENCODE_SCRIPTS_VERSION in
 * bridge-script.ts covers BOTH scripts — bump it when this file changes).
 *
 * Env contract (set via the opencode config's mcp.botflow.environment):
 *   BOTFLOW_API_BASE           — origin for the internal callback API
 *   BOTFLOW_TOOL_TOKEN         — per-turn bearer token
 *   BOTFLOW_TOOLS              — CSV of tool names enabled for this turn
 *   BOTFLOW_OAUTH_PROVIDER_IDS — CSV for setup_oauth_provider's enum/description
 *   BOTFLOW_VERCEL_BYPASS      — optional; Vercel "Protection Bypass for
 *                                Automation" secret. Preview deployments sit
 *                                behind Deployment Protection, which answers
 *                                cookie-less requests with an HTML auth page —
 *                                this header is the official server-to-server
 *                                bypass. The route sends it ONLY on preview
 *                                deployments (VERCEL_ENV === 'preview').
 */
import {
  HOST_TOOL_DEFINITIONS,
  OAUTH_PROVIDERS_TOKEN,
} from "@/lib/agent/host-tools/definitions";

// JSON is valid JS except U+2028/U+2029; escape those so the embedded literal
// can never break the generated module. (No template-literal hazards: the
// JSON lands in the output as a plain object-literal expression.)
const DEFINITIONS_JSON = JSON.stringify(HOST_TOOL_DEFINITIONS)
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");

export const OPENCODE_MCP_SCRIPT_SOURCE = `#!/usr/bin/env node
/* eslint-disable */
/**
 * Botflow MCP server (stdio) for the OpenCode agent. Generated file — the
 * source of truth is src/lib/agent/opencode/mcp-script.ts.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const DEFINITIONS = ${DEFINITIONS_JSON};
const OAUTH_TOKEN_SENTINEL = ${JSON.stringify(OAUTH_PROVIDERS_TOKEN)};

const enabled = (process.env.BOTFLOW_TOOLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const oauthIds = (process.env.BOTFLOW_OAUTH_PROVIDER_IDS || "google")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Fill the {OAUTH_PROVIDERS} sentinel in setup_oauth_provider's description
 *  and enum with the real provider-id list for this deployment. */
function materialize(def) {
  const oauthList = oauthIds.join(", ");
  const tool = {
    name: def.name,
    description: def.description.split(OAUTH_TOKEN_SENTINEL).join(oauthList),
    inputSchema: JSON.parse(JSON.stringify(def.inputSchema)),
  };
  if (def.name === "setup_oauth_provider") {
    const provider = tool.inputSchema && tool.inputSchema.properties && tool.inputSchema.properties.provider;
    if (provider) {
      provider.enum = oauthIds;
      if (typeof provider.description === "string") {
        provider.description = provider.description.split(OAUTH_TOKEN_SENTINEL).join(oauthList);
      }
    }
  }
  return tool;
}

const tools = enabled
  .map((name) => DEFINITIONS[name])
  .filter(Boolean)
  .map(materialize);

// ---------------------------------------------------------------------------
// Host callback — identical contract to the CC bridge's callHostTool:
// POST {BOTFLOW_API_BASE}/api/internal/claude-code-tool with a bearer token;
// { ok: false } responses surface as isError tool results. No fetch timeout:
// host tools legitimately block for minutes (ask_question, Stripe modal).
// ---------------------------------------------------------------------------
async function callHostTool(toolName, input) {
  const base = process.env.BOTFLOW_API_BASE;
  const token = process.env.BOTFLOW_TOOL_TOKEN;
  if (!base || !token) {
    throw new Error("Host callback not configured (BOTFLOW_API_BASE / BOTFLOW_TOOL_TOKEN missing)");
  }
  const headers = {
    "authorization": "Bearer " + token,
    "content-type": "application/json",
  };
  if (process.env.BOTFLOW_VERCEL_BYPASS) {
    headers["x-vercel-protection-bypass"] = process.env.BOTFLOW_VERCEL_BYPASS;
  }
  const response = await fetch(base + "/api/internal/claude-code-tool", {
    method: "POST",
    headers,
    body: JSON.stringify({ tool: toolName, input: input ?? {} }),
  });
  const contentType = response.headers.get("content-type") || "unknown";
  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(
      "Host tool call failed (HTTP " + response.status + ", " + contentType + "): " + raw.slice(0, 300),
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    // A 200 that isn't JSON means something in FRONT of the app answered —
    // on Vercel previews that's Deployment Protection's HTML auth page.
    throw new Error(
      "Host tool endpoint returned non-JSON (" + contentType + ") from " + base +
      " — if this is a protected Vercel preview deployment, enable 'Protection Bypass for Automation' " +
      "and redeploy so the bypass header is sent. Body starts: " + raw.slice(0, 200),
    );
  }
}

function toCallToolResult(result) {
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
}

const server = new Server(
  { name: "botflow", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (!enabled.includes(name)) {
    return {
      content: [{ type: "text", text: "Unknown or disabled tool: " + name }],
      isError: true,
    };
  }
  try {
    const result = await callHostTool(name, args || {});
    return toCallToolResult(result);
  } catch (err) {
    return {
      content: [{ type: "text", text: err && err.message ? err.message : String(err) }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
`;
