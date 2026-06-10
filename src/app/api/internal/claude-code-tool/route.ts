/**
 * /api/internal/claude-code-tool
 *
 * Internal callback endpoint for the Claude Code bridge running inside a
 * sandbox. Authenticated via a short-lived bearer token (NOT Clerk) so the
 * sandbox can call back without holding a Clerk session.
 *
 * The whole point of this endpoint is that platform-managed secrets (e.g.
 * the Convex platform deploy key) must NEVER enter the sandbox env. The
 * bridge POSTs a tool name + input here; we look up the credentials
 * server-side and run the tool under the user's context. Result is returned
 * in the response body, where the bridge passes it back to Claude Code as
 * the MCP tool's result.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatQuestions, projects } from "@/db/schema";
import { resolveToolToken } from "@/lib/agent/claude-code/tool-token";
import {
  buildConvexDeployZip,
  writeGeneratedConvexFiles,
  type DeployResult,
} from "@/lib/sandbox-convex-deploy";
import { setupConvexAuth, refreshAuthSiteUrl } from "@/lib/convex-auth-setup";
import { makeStripeLookupKey } from "@/lib/stripe-scaffold";
import { getUserCredentials } from "@/lib/user-credentials";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import {
  getSandboxBrowserLog,
  getSandboxDevServerLog,
  isSandboxDevServerRunning,
  requestSandboxPreviewRefresh,
  startSandboxDevServer,
  stopSandboxDevServer,
} from "@/lib/workspace-control";
import {
  abortMerge,
  commitAll,
  getCurrentBranch,
  getDiff,
  getStatus,
  hasGitDir,
  pullBranch,
  pushBranch,
  resolveWithContent,
  resolveWithSide,
} from "@/lib/sandbox-git";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FLY_WORKER_URL = process.env.FLY_WORKER_URL;
const WORKER_AUTH_TOKEN =
  process.env.FLY_WORKER_AUTH_TOKEN ?? process.env.WORKER_AUTH_TOKEN ?? "";

interface RequestBody {
  tool: string;
  input?: Record<string, unknown>;
}

export async function POST(req: Request) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    return NextResponse.json({ ok: false, error: "Missing bearer token" }, { status: 401 });
  }
  const binding = await resolveToolToken(match[1]);
  if (!binding) {
    return NextResponse.json({ ok: false, error: "Invalid or expired tool token" }, { status: 401 });
  }

  // ── Parse ────────────────────────────────────────────────────────────────
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const { tool } = body;
  if (!tool || typeof tool !== "string") {
    return NextResponse.json({ ok: false, error: "tool field is required" }, { status: 400 });
  }

  // ── Project lookup + ownership re-check ─────────────────────────────────
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, binding.projectId));
  if (!project || project.userId !== binding.userId) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────
  switch (tool) {
    case "convex_deploy": {
      if (project.backendType === "none") {
        return NextResponse.json({
          ok: false,
          content: "This project was created with the No Backend option — there's nothing to deploy.",
        });
      }
      const deployKey = (project.userConvexDeployKey || project.convexDeployKey || "").trim();
      if (!deployKey) {
        return NextResponse.json({
          ok: false,
          content: "No Convex deploy key is available for this project. Reconnect Convex from Settings.",
        });
      }

      if (!FLY_WORKER_URL) {
        return NextResponse.json({
          ok: false,
          content: "Convex deploy worker is not configured on the server (FLY_WORKER_URL missing).",
        });
      }

      // Build the zip from the project's sandbox FS.
      let zipBlob = await buildConvexDeployZip(binding.projectId);
      if (!zipBlob) {
        // Sandbox may have expired and been re-created empty. Try auto-seeding
        // with the PROJECT'S template (a swift project must reseed swiftConvex,
        // never viteConvex) and the platform-correct config injection — Swift
        // gets ConvexConfig.swift, web gets .env. Mirrors deployConvexFromSandbox.
        try {
          const { seedSandboxIfEmpty, pickSandboxTemplate } = await import("@/lib/vercel-sandbox");
          const template = pickSandboxTemplate(project);
          if (template) {
            const seeded = await seedSandboxIfEmpty(binding.projectId, template);
            if (seeded) {
              const { materializeFrontendEnv, materializeSwiftConvexConfig } =
                await import("@/lib/sandbox-env");
              const materialize =
                template === "swiftConvex" ? materializeSwiftConvexConfig : materializeFrontendEnv;
              await materialize(binding.projectId).catch(() => undefined);
              zipBlob = await buildConvexDeployZip(binding.projectId);
            }
          }
        } catch (reseedErr) {
          console.warn("[claude-code-tool] auto-reseed failed:", reseedErr);
        }
      }
      if (!zipBlob) {
        return NextResponse.json({
          ok: false,
          content: "No /convex folder found in this project — nothing to deploy.",
        });
      }

      // Hand off to the same Fly worker the WebContainer flow uses.
      let workerResponse: Response;
      try {
        workerResponse = await fetch(FLY_WORKER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WORKER_AUTH_TOKEN}`,
            "X-Convex-Deploy-Key": deployKey,
          },
          body: zipBlob,
        });
      } catch (fetchError) {
        return NextResponse.json({
          ok: false,
          content: `Deployment service unreachable: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
        });
      }

      let workerJson: {
        success?: boolean;
        logs?: string;
        error?: string;
        generatedFiles?: { path: string; content: string }[];
      };
      try {
        workerJson = await workerResponse.json();
      } catch {
        return NextResponse.json({
          ok: false,
          content: `Deployment service returned an unexpected response (status ${workerResponse.status}).`,
        });
      }

      if (!workerResponse.ok || !workerJson.success) {
        return NextResponse.json({
          ok: false,
          content: `Convex deploy failed.\n${workerJson.error ?? ""}\n${workerJson.logs ?? ""}`.trim(),
        });
      }

      // Sync the generated types back into the sandbox so the agent's next
      // read/grep sees fresh `_generated/api.d.ts` etc.
      if (workerJson.generatedFiles && workerJson.generatedFiles.length > 0) {
        await writeGeneratedConvexFiles(binding.projectId, workerJson.generatedFiles);
      }

      const result: DeployResult = {
        ok: true,
        output: workerJson.logs ?? "",
        generatedFiles: workerJson.generatedFiles ?? [],
      };

      return NextResponse.json({
        ok: true,
        content: `Convex deployment completed.\n\n${result.output}`.trim(),
        generatedFilesCount: result.generatedFiles?.length ?? 0,
      });
    }
    // ── Workspace control: dev server lifecycle + browser/dev logs ──────
    // All six tools call into the same server-side primitives the Botflow
    // sandboxed-web agent uses, so the two agent paths stay in lockstep.
    case "startDevServer": {
      const result = await startSandboxDevServer(binding.projectId, {
        port: 5173,
        installFirst: true,
      });
      if (result.ok && result.previewUrl) {
        // Keep SITE_URL in sync — fire-and-forget, non-fatal.
        void refreshAuthSiteUrl(binding.projectId, result.previewUrl).catch(() => {});
      }
      // Terse content — URL intentionally withheld. The user's workspace
      // polls preview-state and surfaces the preview automatically.
      const content = result.ok
        ? "Dev server started. The preview is now visible to the user."
        : (result.log ? `${result.message}\n\nLast log:\n${result.log.slice(-2000)}` : result.message);
      return NextResponse.json({ ok: result.ok, content });
    }

    case "stopDevServer": {
      const result = await stopSandboxDevServer(binding.projectId);
      return NextResponse.json({
        ok: result.ok,
        content: result.ok
          ? (result.alreadyStopped ? "Dev server was not running." : "Dev server stopped.")
          : result.message,
        alreadyStopped: Boolean(result.alreadyStopped),
      });
    }

    case "isDevServerRunning": {
      const result = await isSandboxDevServerRunning(binding.projectId);
      return NextResponse.json({
        ok: result.ok,
        content: result.message,
        running: result.running,
      });
    }

    case "getDevServerLog": {
      const linesBack = typeof body.input?.linesBack === "number" ? body.input.linesBack : 200;
      const result = await getSandboxDevServerLog(binding.projectId, linesBack);
      return NextResponse.json({
        ok: result.ok,
        content: result.log ?? result.message,
      });
    }

    case "getBrowserLog": {
      const linesBack = typeof body.input?.linesBack === "number" ? body.input.linesBack : 200;
      const result = await getSandboxBrowserLog(binding.projectId, linesBack);
      return NextResponse.json({
        ok: result.ok,
        content: result.log ?? result.message,
      });
    }

    case "get_convex_logs": {
      const { getConvexLogs } = await import("@/lib/convex-admin");
      const limit =
        typeof body.input?.limit === "number" ? body.input.limit : undefined;
      const onlyErrors =
        typeof body.input?.onlyErrors === "boolean" ? body.input.onlyErrors : undefined;
      const result = await getConvexLogs(binding.projectId, {
        ...(limit !== undefined ? { limit } : {}),
        ...(onlyErrors !== undefined ? { onlyErrors } : {}),
      });
      return NextResponse.json({
        ok: result.ok,
        content: result.ok
          ? JSON.stringify({ entries: result.entries, truncated: result.truncated })
          : (result.error ?? "Failed to read Convex logs"),
      });
    }

    case "list_convex_tables": {
      const { listConvexTables } = await import("@/lib/convex-admin");
      const result = await listConvexTables(binding.projectId);
      return NextResponse.json({
        ok: result.ok,
        content: result.ok
          ? JSON.stringify({ tables: result.tables })
          : result.error,
      });
    }

    case "read_convex_table": {
      const { readConvexTable } = await import("@/lib/convex-admin");
      const table = typeof body.input?.table === "string" ? body.input.table : undefined;
      if (!table) {
        return NextResponse.json({ ok: false, content: "read_convex_table requires `table`." });
      }
      const limit = typeof body.input?.limit === "number" ? body.input.limit : undefined;
      const order =
        body.input?.order === "asc" || body.input?.order === "desc" ? body.input.order : undefined;
      const cursor = typeof body.input?.cursor === "string" ? body.input.cursor : undefined;
      const result = await readConvexTable(binding.projectId, {
        table,
        ...(limit !== undefined ? { limit } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return NextResponse.json({
        ok: result.ok,
        content: result.ok
          ? JSON.stringify({
              documents: result.documents,
              continueCursor: result.continueCursor,
              isDone: result.isDone,
            })
          : result.error,
      });
    }

    case "write_convex_data": {
      const { writeConvexData } = await import("@/lib/convex-admin");
      const i = body.input ?? {};
      const result = await writeConvexData(binding.projectId, {
        operation: i.operation as "insert" | "patch" | "replace" | "delete",
        ...(typeof i.table === "string" ? { table: i.table } : {}),
        ...(Array.isArray(i.documents) ? { documents: i.documents } : {}),
        ...(Array.isArray(i.ids) ? { ids: i.ids as string[] } : {}),
        ...(i.fields && typeof i.fields === "object"
          ? { fields: i.fields as Record<string, unknown> }
          : {}),
        ...(typeof i.id === "string" ? { id: i.id } : {}),
        ...(i.document && typeof i.document === "object"
          ? { document: i.document as Record<string, unknown> }
          : {}),
        ...(typeof i.confirmed === "boolean" ? { confirmed: i.confirmed } : {}),
      });
      return NextResponse.json({
        ok: result.ok,
        content: JSON.stringify({
          status: result.status,
          ...(result.preview ? { preview: result.preview } : {}),
          ...(result.instruction ? { instruction: result.instruction } : {}),
          ...(result.error ? { error: result.error } : {}),
          ...(result.result !== undefined ? { result: result.result } : {}),
        }),
      });
    }

    case "refreshPreview": {
      const result = await requestSandboxPreviewRefresh(binding.projectId);
      return NextResponse.json({
        ok: result.ok,
        content: result.message,
      });
    }

    case "initialize_stripe_payments": {
      // Modal-driven Stripe Connect via OAuth (Standard). Mirrors
      // POST /api/projects/[id]/stripe/initialize.
      const { STRIPE_CONNECT_ENABLED } = await import("@/lib/feature-flags");
      if (!STRIPE_CONNECT_ENABLED) {
        return NextResponse.json({
          ok: false,
          content: "Stripe Connect is not enabled on this deployment.",
        });
      }
      if (project.backendType === "none") {
        return NextResponse.json({
          ok: false,
          status: "backend-blocked",
          content:
            "This project has no backend. Stripe requires a Convex backend to receive webhook events and store billing state.",
        });
      }

      const { canUseStripeConnect } = await import("@/lib/tier");
      const gate = await canUseStripeConnect(binding.userId);
      if (!gate.allowed) {
        return NextResponse.json({
          ok: false,
          status: "tier-blocked",
          content: gate.reason,
          tier: gate.tier,
        });
      }

      const { isConnectOAuthConfigured } = await import("@/lib/stripe");
      const { userStripeIdentity } = await import("@/db/schema");
      const mode: "test" | "live" = project.stripePaymentMode === "live" ? "live" : "test";

      if (!isConnectOAuthConfigured(mode)) {
        return NextResponse.json({
          ok: false,
          status: "misconfigured",
          content: `Stripe Connect OAuth client_id for ${mode} mode is not configured on the server.`,
        });
      }

      const [identity] = await db
        .select()
        .from(userStripeIdentity)
        .where(eq(userStripeIdentity.userId, binding.userId))
        .limit(1);

      const existingAccountId =
        identity && mode === "live" ? identity.liveAccountId : identity?.testAccountId;

      const seedWebhookSecret = () =>
        `bfws_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;

      if (existingAccountId) {
        const webhookSecret = project.stripeWebhookSecret ?? seedWebhookSecret();
        await db
          .update(projects)
          .set({
            stripeEnabled: true,
            stripeWebhookSecret: webhookSecret,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, binding.projectId));

        // Scaffold in the background — file drop + Convex env set can be
        // slow for cold sandboxes/new projects. Don't block the tool call.
        const { after } = await import("next/server");
        const { ensureDemoProductPrice, scaffoldStripeIntoProject } = await import(
          "@/lib/stripe-scaffold"
        );
        after(async () => {
          try {
            const demoPriceId = await ensureDemoProductPrice(existingAccountId, mode);
            const result = await scaffoldStripeIntoProject(binding.projectId, {
              mode,
              webhookSecret,
              proxyBase: process.env.APP_BASE_URL || "https://botflow.io",
              ...(demoPriceId ? { demoPriceId } : {}),
            });
            console.log(
              "[claude-code-tool/stripe] background scaffold complete",
              binding.projectId,
              "files=", result.filesWritten,
              "envSet=", result.envSet,
              result.envError ? `envError=${result.envError}` : "",
              result.filesError ? `filesError=${result.filesError}` : "",
            );
          } catch (err) {
            console.error("[claude-code-tool/stripe] background scaffold threw:", err);
          }
        });

        return NextResponse.json({
          ok: true,
          status: "already-connected",
          mode,
          accountId: existingAccountId,
          scaffoldDeferred: true,
          content: `Stripe is already linked for this user. This project is enabled to use account ${existingAccountId} in ${mode} mode. Stripe helper files (convex/platformStripe.ts, convex/stripeWebhook.ts, convex/billing.ts) are scaffolding into the sandbox in the background — wait ~5 seconds before calling convex_deploy. Then write checkout UI that imports from convex/platformStripe.ts.`,
        });
      }

      // Open the modal: cancel stale, mint state + URL, create pending request.
      const {
        cancelPendingConnectRequests,
        createConnectRequest,
        mintStripeAuthorizeUrl,
        pollConnectRequest,
      } = await import("@/lib/stripe-connect");
      await cancelPendingConnectRequests(binding.projectId);
      const appOrigin = process.env.APP_BASE_URL || "https://botflow.io";
      const { state, authorizeUrl } = await mintStripeAuthorizeUrl({
        userId: binding.userId,
        projectId: binding.projectId,
        mode,
        appOrigin,
      });
      const { id: requestId } = await createConnectRequest({
        userId: binding.userId,
        projectId: binding.projectId,
        mode,
        state,
        authorizeUrl,
      });

      const deadlineMs = Date.now() + 5 * 60 * 1000;
      const result = await pollConnectRequest({ requestId, projectId: binding.projectId, deadlineMs });

      if (result === "completed") {
        const [linked] = await db
          .select()
          .from(userStripeIdentity)
          .where(eq(userStripeIdentity.userId, binding.userId))
          .limit(1);
        const accountId =
          linked && mode === "live" ? linked.liveAccountId : linked?.testAccountId;
        const webhookSecret = project.stripeWebhookSecret ?? seedWebhookSecret();
        await db
          .update(projects)
          .set({
            stripeEnabled: true,
            stripeWebhookSecret: webhookSecret,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, binding.projectId));
        const { after } = await import("next/server");
        const { ensureDemoProductPrice, scaffoldStripeIntoProject } = await import(
          "@/lib/stripe-scaffold"
        );
        after(async () => {
          try {
            const demoPriceId = accountId
              ? await ensureDemoProductPrice(accountId, mode)
              : null;
            const result = await scaffoldStripeIntoProject(binding.projectId, {
              mode,
              webhookSecret,
              proxyBase: process.env.APP_BASE_URL || "https://botflow.io",
              ...(demoPriceId ? { demoPriceId } : {}),
            });
            console.log(
              "[claude-code-tool/stripe] background scaffold complete",
              binding.projectId,
              "files=", result.filesWritten,
              "envSet=", result.envSet,
            );
          } catch (err) {
            console.error("[claude-code-tool/stripe] background scaffold threw:", err);
          }
        });
        return NextResponse.json({
          ok: true,
          status: "connected",
          mode,
          accountId,
          scaffoldDeferred: true,
          content: `User completed Stripe OAuth. Account ${accountId} linked. Stripe helper files scaffolding in background — wait ~5 seconds before calling convex_deploy.`,
        });
      }

      if (result === "dismissed" || result === "gone") {
        return NextResponse.json({
          ok: false,
          status: "dismissed",
          content:
            "User declined to connect Stripe. The modal was dismissed and no account was linked. Do not retry automatically. Continue with the rest of the implementation and tell the user they can set up Stripe later from the workspace.",
        });
      }

      return NextResponse.json({
        ok: false,
        status: "timeout",
        content:
          "Timed out waiting for the user to complete Stripe OAuth (5 minutes elapsed). Treat like a dismiss — do not retry.",
      });
    }

    case "get_stripe_products":
    case "create_stripe_product": {
      // Both tools list/create Products+Prices on the user's connected
      // account. Mirrors GET/POST /api/projects/[id]/stripe/products, but runs
      // under the sandbox tool-token binding instead of a Clerk session.
      const { STRIPE_CONNECT_ENABLED } = await import("@/lib/feature-flags");
      if (!STRIPE_CONNECT_ENABLED) {
        return NextResponse.json({
          ok: false,
          content: "Stripe Connect is not enabled on this deployment.",
        });
      }
      const { canUseStripeConnect } = await import("@/lib/tier");
      const gate = await canUseStripeConnect(binding.userId);
      if (!gate.allowed) {
        return NextResponse.json({
          ok: false,
          status: "tier-blocked",
          content: gate.reason,
        });
      }
      const { getStripe, isStripeConfigured } = await import("@/lib/stripe");
      const { userStripeIdentity } = await import("@/db/schema");
      const mode: "test" | "live" =
        project.stripePaymentMode === "live" ? "live" : "test";
      if (!isStripeConfigured(mode)) {
        return NextResponse.json({
          ok: false,
          content: `Stripe keys for ${mode} mode are not configured on the server.`,
        });
      }
      const [identity] = await db
        .select()
        .from(userStripeIdentity)
        .where(eq(userStripeIdentity.userId, binding.userId))
        .limit(1);
      const accountId =
        identity && mode === "live" ? identity.liveAccountId : identity?.testAccountId;
      if (!accountId) {
        return NextResponse.json({
          ok: false,
          status: "not-connected",
          content:
            "The user has not linked a Stripe account for this mode yet. Call initialize_stripe_payments first.",
        });
      }

      const stripe = getStripe(mode);

      if (tool === "get_stripe_products") {
        try {
          const list = await stripe.products.list(
            { active: true, limit: 50 },
            { stripeAccount: accountId },
          );
          const products = await Promise.all(
            list.data.map(async (p) => {
              const prices = await stripe.prices.list(
                { product: p.id, active: true, limit: 20 },
                { stripeAccount: accountId },
              );
              return {
                productId: p.id,
                name: p.name,
                description: p.description ?? null,
                prices: prices.data.map((pr) => ({
                  priceId: pr.id,
                  lookupKey: pr.lookup_key ?? null,
                  unitAmount: pr.unit_amount,
                  currency: pr.currency,
                  recurring: pr.recurring
                    ? { interval: pr.recurring.interval, intervalCount: pr.recurring.interval_count }
                    : null,
                })),
              };
            }),
          );
          return NextResponse.json({
            ok: true,
            mode,
            content: JSON.stringify({ mode, products }),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({
            ok: false,
            content: `Failed to list Stripe products: ${message}`,
          });
        }
      }

      // create_stripe_product
      const args = body.input ?? {};
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const unitAmount = typeof args.unitAmount === "number" ? args.unitAmount : NaN;
      if (!name) {
        return NextResponse.json({ ok: false, content: "name is required." });
      }
      if (!Number.isInteger(unitAmount) || unitAmount <= 0) {
        return NextResponse.json({
          ok: false,
          content: "unitAmount (a positive integer in cents) is required.",
        });
      }
      const currency =
        typeof args.currency === "string" ? args.currency.toLowerCase() : "usd";
      const interval =
        typeof args.interval === "string" ? args.interval : undefined;
      const intervalCount =
        typeof args.intervalCount === "number" ? args.intervalCount : undefined;

      // Stable, mode-agnostic handle the app stores instead of a price_… id.
      const lookupKeyHint =
        typeof args.lookupKey === "string" ? args.lookupKey : name;
      const lookupKey = makeStripeLookupKey(binding.projectId, lookupKeyHint);

      try {
        const priceData: import("stripe").Stripe.PriceCreateParams = {
          currency,
          unit_amount: unitAmount,
          lookup_key: lookupKey,
          transfer_lookup_key: true,
          product_data: {
            name,
            metadata: {
              botflow_project_id: binding.projectId,
              botflow_managed: "1",
              botflow_lookup_key: lookupKey,
            },
          },
        };
        if (interval) {
          priceData.recurring = {
            interval: interval as import("stripe").Stripe.PriceCreateParams.Recurring.Interval,
            interval_count: Math.max(1, intervalCount ?? 1),
          };
        }
        const price = await stripe.prices.create(priceData, {
          stripeAccount: accountId,
        });
        const productId =
          typeof price.product === "string" ? price.product : price.product.id;
        return NextResponse.json({
          ok: true,
          mode,
          content: JSON.stringify({
            mode,
            productId,
            priceId: price.id,
            lookupKey,
            name,
            unitAmount,
            currency,
            recurring: price.recurring
              ? { interval: price.recurring.interval, intervalCount: price.recurring.interval_count }
              : null,
          }),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({
          ok: false,
          content: `Failed to create Stripe product: ${message}`,
        });
      }
    }

    case "setup_auth": {
      if (project.backendType === "none") {
        return NextResponse.json({
          ok: false,
          content: "This project has no backend — Convex Auth is not available.",
        });
      }
      const isSwiftAuth = project.platform === "swift";
      if (project.platform !== "sandboxed-web" && !isSwiftAuth) {
        return NextResponse.json({
          ok: false,
          content: "setupAuth is only available for sandboxed-web and swift projects.",
        });
      }

      // Resolve SITE_URL. Web uses the sandbox's stable preview domain. Swift
      // has no web preview origin (the app returns to a custom URL scheme), so
      // SITE_URL only needs to be a valid URL — use the deployment's own
      // *.convex.site origin when known. Mirrors the public setup-auth route.
      let siteUrl = "https://placeholder.example.com";
      if (isSwiftAuth) {
        const convexUrl = project.convexDeployUrl ?? project.userConvexUrl ?? null;
        if (convexUrl) siteUrl = convexUrl.replace(".convex.cloud", ".convex.site");
      } else {
        try {
          const sandbox = await getOrCreatePersistentSandbox(binding.projectId);
          siteUrl = sandbox.domain(5173);
        } catch {
          // Non-fatal — placeholder is acceptable
        }
      }

      let userConvexOAuthToken: string | null = null;
      if (project.backendType === "user") {
        const creds = await getUserCredentials(binding.userId);
        userConvexOAuthToken = creds.convexOAuthAccessToken;
        if (!userConvexOAuthToken) {
          return NextResponse.json({
            ok: false,
            content:
              "Your Convex account is not connected. Please reconnect it in Settings → Connections before setting up auth.",
          });
        }
      }

      let authResult;
      try {
        authResult = await setupConvexAuth(binding.projectId, {
          siteUrl,
          userConvexOAuthToken,
          platform: isSwiftAuth ? "swift" : "web",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[claude-code-tool/setup_auth] threw:", err);
        return NextResponse.json({ ok: false, content: `setupAuth failed: ${message}` });
      }
      if (!authResult.ok) {
        return NextResponse.json({ ok: false, content: authResult.error });
      }

      // Everything must ride inside `content` — the bridge's MCP handler only
      // surfaces result.content to the model (sibling fields like `files` are
      // silently dropped). content is an object; the bridge JSON.stringifies it.
      return NextResponse.json({
        ok: true,
        content: {
          files: authResult.files,
          packagesToInstall: authResult.packagesToInstall,
          context: authResult.context,
        },
      });
    }

    case "setup_oauth_provider": {
      if (!project.authConfigured) {
        return NextResponse.json({
          ok: false,
          content: "Auth must be set up before adding OAuth providers. Call setup_auth first.",
        });
      }
      if (project.backendType === "none") {
        return NextResponse.json({
          ok: false,
          content: "This project has no backend — OAuth providers are not available.",
        });
      }

      // We re-use the REST API endpoints rather than duplicating the DB logic.
      // The internal tool token doesn't carry a Clerk session, so we call the
      // Next.js API with a synthetic request that includes the user's context
      // via a server-side URL call. Instead, we duplicate the minimal logic here.
      const { getDb: getDbLocal } = await import("@/db");
      const { oauthProviderRequests: oauthTable } = await import("@/db/schema");
      const { eq: eqLocal, and: andLocal, desc: descLocal } = await import("drizzle-orm");

      const dbLocal = getDbLocal();

      const inputProvider = (body.input?.provider as string | undefined) ?? "google";
      if (inputProvider !== "google") {
        return NextResponse.json({
          ok: false,
          content: `Unsupported OAuth provider: ${inputProvider}. Only 'google' is supported.`,
        });
      }

      const deployUrl = project.userConvexUrl ?? project.convexDeployUrl ?? null;
      const convexSiteUrl = deployUrl
        ? deployUrl.replace(".convex.cloud", ".convex.site")
        : null;

      // Cancel stale pending requests
      await dbLocal
        .update(oauthTable)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(
          andLocal(
            eqLocal(oauthTable.projectId, project.id),
            eqLocal(oauthTable.status, "pending"),
          ),
        );

      // Create new request
      const [oauthRecord] = await dbLocal
        .insert(oauthTable)
        .values({
          projectId: project.id,
          userId: binding.userId,
          provider: inputProvider,
          status: "pending",
          convexSiteUrl,
        })
        .returning();

      const requestId = oauthRecord.id;

      // Poll for up to 5 minutes for the user to complete the modal
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 3000));

        const [statusRow] = await dbLocal
          .select({ status: oauthTable.status })
          .from(oauthTable)
          .where(
            andLocal(
              eqLocal(oauthTable.id, requestId),
              eqLocal(oauthTable.projectId, project.id),
            ),
          )
          .limit(1);

        if (!statusRow) break; // Shouldn't happen — bail gracefully

        if (statusRow.status === "completed") {
          return NextResponse.json({
            ok: true,
            content: `=== GOOGLE OAUTH CREDENTIALS SAVED ===

AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET are now set on your Convex deployment.

REQUIRED NEXT STEPS:

1. Update convex/auth.ts — add the Google provider:

   import { convexAuth } from "@convex-dev/auth/server";
   import { Password } from "@convex-dev/auth/providers/Password";
   import Google from "@auth/core/providers/google";

   export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
     providers: [Password, Google],
   });

2. Run convex_deploy to push the updated auth config.

3. Add a Google sign-in button to the UI:

   const { signIn } = useAuthActions();
   <button onClick={() => void signIn("google")}>Sign in with Google</button>

   Clicking the button redirects to Google's consent screen.
   On return, Convex Auth creates or merges the user account automatically.`,
          });
        }

        if (statusRow.status === "dismissed") {
          return NextResponse.json({
            ok: false,
            content:
              "User dismissed the Google OAuth modal without saving credentials. " +
              "Do not retry automatically. Continue with other work.",
          });
        }
        // status === 'pending' — keep polling
      }

      return NextResponse.json({
        ok: false,
        content:
          "Timed out waiting for Google OAuth credentials (5 minutes). " +
          "Call setup_oauth_provider again when the user is ready.",
      });
    }

    case "ask_question": {
      // Mirror of the Botflow askQuestion execute: insert a chat_questions
      // row keyed by a synthetic tool_call_id, poll for an answer, return.
      const inputQuestions = body.input?.questions;
      if (!Array.isArray(inputQuestions) || inputQuestions.length === 0) {
        return NextResponse.json({
          ok: false,
          content: "askQuestion requires a non-empty questions array.",
        });
      }

      const toolCallId = `claude-${randomUUID()}`;
      const dbLocal = getDb();
      await dbLocal.insert(chatQuestions).values({
        projectId: binding.projectId,
        userId: binding.userId,
        segmentId: project.currentSegmentId,
        toolCallId,
        questions: inputQuestions as unknown as object,
        status: "pending",
      });

      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        const [row] = await dbLocal
          .select({ status: chatQuestions.status, answer: chatQuestions.answer })
          .from(chatQuestions)
          .where(
            and(
              eq(chatQuestions.toolCallId, toolCallId),
              eq(chatQuestions.projectId, binding.projectId),
            ),
          )
          .limit(1);
        if (!row) break;
        if (row.status === "answered") {
          const ans = row.answer as
            | { selectedIds?: string[]; selectedLabels?: string[]; text?: string | null }
            | null;
          const labels = ans?.selectedLabels ?? [];
          const summary = labels.length > 0
            ? `User picked: ${labels.join(", ")}${ans?.text ? ` (with custom note: "${ans.text}")` : ""}`
            : (ans?.text ?? "Answered");
          return NextResponse.json({
            ok: true,
            content: summary,
            answered: true,
            selectedIds: ans?.selectedIds ?? [],
            selectedLabels: labels,
            customText: ans?.text ?? null,
          });
        }
        if (row.status === "dismissed") {
          return NextResponse.json({
            ok: true,
            content: "User dismissed the question without picking an option. Do not retry; continue with whatever default is reasonable.",
            answered: false,
            dismissed: true,
          });
        }
      }

      await dbLocal
        .update(chatQuestions)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(
          and(
            eq(chatQuestions.toolCallId, toolCallId),
            eq(chatQuestions.projectId, binding.projectId),
          ),
        )
        .catch(() => undefined);
      return NextResponse.json({
        ok: true,
        content: "Question timed out (5 minutes) without an answer. Continue with a reasonable default.",
        answered: false,
        timedOut: true,
      });
    }

    // ── Git tools — gated server-side by the project having a linked repo ──
    case "git_status": {
      if (!project.githubRepoOwner) {
        return NextResponse.json({
          ok: false,
          content: "This project has no GitHub repository linked.",
        });
      }
      if (!(await hasGitDir(binding.projectId))) {
        return NextResponse.json({
          ok: false,
          content: "Sandbox has no .git directory. Ask the user to re-link the repository.",
        });
      }
      const res = await getStatus(binding.projectId);
      if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
      return NextResponse.json({ ok: true, content: JSON.stringify(res.status) });
    }

    case "git_diff": {
      if (!project.githubRepoOwner) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const path = typeof body.input?.path === "string" ? body.input.path : undefined;
      const staged = body.input?.staged === true;
      const res = await getDiff(binding.projectId, { path, staged });
      if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
      return NextResponse.json({ ok: true, content: res.diff ?? "(no changes)" });
    }

    case "git_commit": {
      if (!project.githubRepoOwner) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const message = typeof body.input?.message === "string" ? body.input.message.trim() : "";
      if (!message) {
        return NextResponse.json({ ok: false, content: "Commit message is required." });
      }
      const res = await commitAll(binding.projectId, message);
      if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
      if (res.nothingToCommit) {
        return NextResponse.json({ ok: true, content: "No changes to commit." });
      }
      return NextResponse.json({ ok: true, content: `Committed as ${res.sha}.` });
    }

    case "git_push": {
      if (!project.githubRepoOwner || !project.githubRepoName) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const creds = await getUserCredentials(binding.userId);
      if (!creds.githubAccessToken) {
        return NextResponse.json({ ok: false, content: "GitHub not connected." });
      }
      const cur = await getCurrentBranch(binding.projectId);
      const branch = cur.ok && cur.branch ? cur.branch : (project.githubDefaultBranch ?? "main");
      const force = body.input?.force === true;
      const res = await pushBranch(binding.projectId, {
        token: creds.githubAccessToken,
        owner: project.githubRepoOwner,
        name: project.githubRepoName,
        branch,
        force,
      });
      if (!res.ok) {
        const note = res.code === "non-fast-forward"
          ? " Call git_pull first, resolve any conflicts, then retry git_push."
          : "";
        return NextResponse.json({ ok: false, content: `${res.message}${note}` });
      }
      return NextResponse.json({ ok: true, content: `Pushed ${res.newSha} to ${branch}.` });
    }

    case "git_pull": {
      if (!project.githubRepoOwner || !project.githubRepoName) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const creds = await getUserCredentials(binding.userId);
      if (!creds.githubAccessToken) {
        return NextResponse.json({ ok: false, content: "GitHub not connected." });
      }
      const cur = await getCurrentBranch(binding.projectId);
      const branch = cur.ok && cur.branch ? cur.branch : (project.githubDefaultBranch ?? "main");
      const res = await pullBranch(binding.projectId, {
        token: creds.githubAccessToken,
        owner: project.githubRepoOwner,
        name: project.githubRepoName,
        branch,
      });
      if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
      if (res.clean) return NextResponse.json({ ok: true, content: "Up to date / fast-forwarded." });
      return NextResponse.json({
        ok: true,
        content: `Merge conflicts to resolve in:\n${res.conflicts.join("\n")}\n\nResolve each with git_resolve_conflict, then call git_commit with a merge message.`,
        conflicts: res.conflicts,
      });
    }

    case "git_resolve_conflict": {
      if (!project.githubRepoOwner) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const path = typeof body.input?.path === "string" ? body.input.path : "";
      if (!path) return NextResponse.json({ ok: false, content: "path is required." });
      const side = body.input?.side;
      const content = body.input?.content;
      if (side === "ours" || side === "theirs") {
        const res = await resolveWithSide(binding.projectId, path, side);
        if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
        return NextResponse.json({ ok: true, content: `Resolved ${path} with ${side}.` });
      }
      if (typeof content === "string") {
        const res = await resolveWithContent(binding.projectId, path, content);
        if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
        return NextResponse.json({ ok: true, content: `Resolved ${path} with custom merge.` });
      }
      return NextResponse.json({
        ok: false,
        content: "Provide either side=ours|theirs or content=<merged text>.",
      });
    }

    case "git_abort_merge": {
      if (!project.githubRepoOwner) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const res = await abortMerge(binding.projectId);
      if (!res.ok) return NextResponse.json({ ok: false, content: res.message });
      return NextResponse.json({ ok: true, content: "Merge aborted; working tree restored." });
    }

    case "open_pull_request": {
      if (!project.githubRepoOwner || !project.githubRepoName) {
        return NextResponse.json({ ok: false, content: "No GitHub repository linked." });
      }
      const creds = await getUserCredentials(binding.userId);
      if (!creds.githubAccessToken) {
        return NextResponse.json({ ok: false, content: "GitHub not connected." });
      }
      const title = typeof body.input?.title === "string" ? body.input.title.trim() : "";
      if (!title) return NextResponse.json({ ok: false, content: "title is required." });
      const cur = await getCurrentBranch(binding.projectId);
      const head = (typeof body.input?.headBranch === "string" && body.input.headBranch.trim())
        || (cur.ok && cur.branch ? cur.branch : (project.githubDefaultBranch ?? "main"));
      const base = (typeof body.input?.baseBranch === "string" && body.input.baseBranch.trim())
        || (project.githubDefaultBranch ?? "main");
      if (head === base) {
        return NextResponse.json({
          ok: false,
          content: "PR head and base are the same branch. Create a feature branch first.",
        });
      }
      const ghRes = await fetch(
        `https://api.github.com/repos/${project.githubRepoOwner}/${project.githubRepoName}/pulls`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.githubAccessToken}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title,
            body: body.input?.body ?? undefined,
            head,
            base,
            draft: body.input?.draft === true,
          }),
        },
      );
      if (ghRes.ok) {
        const pr = await ghRes.json() as { html_url: string; number: number };
        return NextResponse.json({
          ok: true,
          content: `Opened PR #${pr.number}: ${pr.html_url}`,
          url: pr.html_url,
          number: pr.number,
        });
      }
      if (ghRes.status === 422) {
        const listRes = await fetch(
          `https://api.github.com/repos/${project.githubRepoOwner}/${project.githubRepoName}/pulls?head=${encodeURIComponent(`${project.githubRepoOwner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`,
          {
            headers: {
              Authorization: `Bearer ${creds.githubAccessToken}`,
              Accept: "application/vnd.github.v3+json",
            },
          },
        );
        if (listRes.ok) {
          const list = await listRes.json() as Array<{ html_url: string; number: number }>;
          if (list.length > 0) {
            return NextResponse.json({
              ok: true,
              content: `A PR for this branch already exists: ${list[0].html_url}`,
              url: list[0].html_url,
              number: list[0].number,
              alreadyExists: true,
            });
          }
        }
      }
      const err = (await ghRes.json().catch(() => ({}))) as { message?: string };
      return NextResponse.json({ ok: false, content: err.message ?? `GitHub ${ghRes.status}` });
    }

    case "set_git_autonomy": {
      const mode = body.input?.mode;
      if (mode !== "autonomous" && mode !== "manual" && mode !== "ask-each-time") {
        return NextResponse.json({
          ok: false,
          content: "mode must be 'autonomous', 'manual', or 'ask-each-time'.",
        });
      }
      const db = getDb();
      await db
        .update(projects)
        .set({ gitAutonomy: mode, updatedAt: new Date() })
        .where(eq(projects.id, binding.projectId));
      return NextResponse.json({ ok: true, content: `Git autonomy set to ${mode}.` });
    }

    default:
      return NextResponse.json(
        { ok: false, error: `Unknown tool: ${tool}` },
        { status: 400 },
      );
  }
}
