/**
 * DB-aware MuhKoo provisioning orchestration.
 *
 * Bridges the pure API client (`muhkoo-platform.ts`) and the `projects` table:
 * provisions a MuhKoo app under the platform account and persists its creds.
 * The MuhKoo analogue of the auto-provision block in the Convex deploy route.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import {
  provisionMuhkooBackend,
  putMuhkooTable,
  createMuhkooAccessToken,
  type MuhkooTableSpec,
} from "@/lib/muhkoo-platform";

/**
 * The starter template (vite_muhkoo_template) ships with a generic `items`
 * board wired to this table, so we provision it at creation to make the app
 * work out of the box. The agent can add/reshape tables later via the MuhKoo
 * API. Keep in sync with the template's src/appConfig.ts TABLE.
 */
const DEFAULT_MUHKOO_TABLE: MuhkooTableSpec = {
  table: "items",
  columns: [
    { name: "title", type: "text" },
    { name: "done", type: "boolean" },
    { name: "created_at", type: "text" },
  ],
};

export interface EnsureMuhkooResult {
  /** true if we provisioned just now; false if it was already provisioned. */
  provisioned: boolean;
  appId: string | null;
  slug: string | null;
  hostingUrl: string | null;
}

/**
 * Ensure a MuhKoo project has a provisioned backend. Idempotent: returns early
 * if the project already has a `muhkooAppId`. Otherwise provisions a MuhKoo app
 * and stores appId/slug/keys/hostingUrl on the project row.
 *
 * Note: like the Convex deploy route, the re-read here narrows but does not
 * fully close the concurrent-provision window — a per-project lock would.
 */
export async function ensureMuhkooProvisioned(
  projectId: string,
): Promise<EnsureMuhkooResult> {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error("Project not found");

  if (project.backendType !== "muhkoo") {
    return { provisioned: false, appId: null, slug: null, hostingUrl: null };
  }
  if (project.muhkooAppId) {
    return {
      provisioned: false,
      appId: project.muhkooAppId,
      slug: project.muhkooSlug,
      hostingUrl: project.muhkooHostingUrl,
    };
  }

  const app = await provisionMuhkooBackend({
    projectId: project.id,
    projectName: project.name,
    allowedOrigins: "*",
  });

  await db
    .update(projects)
    .set({
      muhkooAppId: app.appId,
      muhkooSlug: app.slug,
      muhkooPublishableKey: app.publishableKey,
      muhkooSecretKey: app.secretKey,
      muhkooHostingUrl: app.hostingUrl,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));

  // Provision the starter's default table so the template works immediately.
  // Best-effort: a table hiccup shouldn't block the app from being usable.
  try {
    await putMuhkooTable(app.appId, DEFAULT_MUHKOO_TABLE);
  } catch (e) {
    console.warn("[muhkoo] default table provisioning failed (non-fatal):", e);
  }

  // Mint the scoped read/write credential the agent's table tools use.
  // Best-effort: the app is fully usable without it (only agent reads degrade).
  await ensureMuhkooAccessToken(projectId).catch((e) =>
    console.warn("[muhkoo] access-token minting failed (non-fatal):", e),
  );

  return {
    provisioned: true,
    appId: app.appId,
    slug: app.slug,
    hostingUrl: app.hostingUrl,
  };
}

/**
 * Ensure the project has a stored MuhKoo access token, minting one if absent.
 *
 * Separate from provisioning so it also HEALS projects created before access
 * tokens existed (and any run where minting failed) — callers can invoke it
 * lazily right before they need a data-plane read.
 *
 * Scoped to `db:read` + `db:write` and long-lived (1y) on purpose: it must
 * outlive the ~1-day platform developer session so agent table reads keep
 * working. Server-only — never injected into the sandbox.
 */
export async function ensureMuhkooAccessToken(
  projectId: string,
): Promise<string | null> {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || project.backendType !== "muhkoo" || !project.muhkooAppId) {
    return null;
  }
  if (project.muhkooAccessToken) return project.muhkooAccessToken;

  const token = await createMuhkooAccessToken(project.muhkooAppId, {
    scopes: ["db:read", "db:write"],
    env: "test",
    expiresInDays: 365,
    label: `botflow-${project.id.slice(0, 8)}`,
  });

  await db
    .update(projects)
    .set({ muhkooAccessToken: token.plaintext, updatedAt: new Date() })
    .where(eq(projects.id, projectId));

  return token.plaintext;
}
