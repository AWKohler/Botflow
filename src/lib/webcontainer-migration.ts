/**
 * Lazy migration of legacy WebContainer projects (platform === "web") onto a
 * Vercel sandbox (platform === "sandboxed-web").
 *
 * WebContainer projects persisted their working tree to Postgres: text files in
 * `project_files` and binary assets in `project_assets` (UploadThing). When such
 * a project is opened we create a sandbox, write that saved state into it,
 * carry Convex over (env), flip the platform slug, strip every WebContainer /
 * GitHub trace, and delete the now-redundant DB file rows.
 *
 * Ordering is chosen for safe idempotency:
 *   - A failure BEFORE the platform flip leaves the project as "web" with its DB
 *     files intact → re-opening retries cleanly.
 *   - A failure AFTER the flip leaves a working sandbox project; the row cleanup
 *     simply re-runs on a later pass.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { requireProjectAccess } from "@/lib/project-access";
import {
  projects,
  projectFiles,
  projectAssets,
  projectSyncManifests,
} from "@/db/schema";
import {
  getOrCreatePersistentSandbox,
  seedSandboxIfEmpty,
  type SandboxTemplate,
} from "@/lib/vercel-sandbox";
import { materializeFrontendEnv } from "@/lib/sandbox-env";

const SANDBOX_ROOT = "/vercel/sandbox";
const WRITE_BATCH = 40;
const MKDIR_BATCH = 100;

export type MigrationResult =
  | { migrated: false; reason: "not-found" | "not-web" }
  | {
      migrated: true;
      fileCount: number;
      assetCount: number;
      seededTemplate?: SandboxTemplate;
    };

/** Project-relative path → absolute sandbox path (mirrors vercel-sandbox toAbsPath). */
function toAbs(projectRelative: string): string {
  const trimmed = projectRelative.startsWith("/")
    ? projectRelative.slice(1)
    : projectRelative;
  return trimmed ? `${SANDBOX_ROOT}/${trimmed}` : SANDBOX_ROOT;
}

type SandboxHandle = Awaited<ReturnType<typeof getOrCreatePersistentSandbox>>;

/** True when the sandbox already has project content (ignoring node_modules/.git). */
async function sandboxHasContent(sandbox: SandboxHandle): Promise<boolean> {
  const check = await sandbox.runCommand("sh", [
    "-c",
    `ls -A ${SANDBOX_ROOT} 2>/dev/null | grep -v '^node_modules$' | grep -v '^\\.git$' | head -1 || true`,
  ]);
  return Boolean((await check.stdout()).trim());
}

async function writeFilesIntoSandbox(
  sandbox: SandboxHandle,
  textFiles: Array<{ path: string; content: string }>,
  assets: Array<{ path: string; uploadThingUrl: string }>,
): Promise<void> {
  const entries: Array<{ path: string; content: Buffer }> = [];

  for (const f of textFiles) {
    entries.push({ path: toAbs(f.path), content: Buffer.from(f.content, "utf-8") });
  }

  // Binary assets live in UploadThing — fetch the bytes and write them inline.
  for (const a of assets) {
    try {
      const res = await fetch(a.uploadThingUrl);
      if (!res.ok) {
        console.warn(`[wc-migration] asset fetch ${res.status}: ${a.path}`);
        continue;
      }
      entries.push({ path: toAbs(a.path), content: Buffer.from(await res.arrayBuffer()) });
    } catch (e) {
      console.warn(`[wc-migration] asset fetch failed: ${a.path}`, e);
    }
  }

  if (entries.length === 0) return;

  // writeFiles does not create parent directories — mkdir -p them first.
  const dirs = new Set<string>();
  for (const e of entries) {
    const slash = e.path.lastIndexOf("/");
    const dir = slash > 0 ? e.path.slice(0, slash) : "";
    if (dir && dir !== SANDBOX_ROOT) dirs.add(dir);
  }
  const dirList = Array.from(dirs);
  for (let i = 0; i < dirList.length; i += MKDIR_BATCH) {
    await sandbox.runCommand("mkdir", ["-p", ...dirList.slice(i, i + MKDIR_BATCH)]);
  }

  for (let i = 0; i < entries.length; i += WRITE_BATCH) {
    await sandbox.writeFiles(entries.slice(i, i + WRITE_BATCH));
  }
}

/** Delete the saved-file rows (and best-effort the UploadThing objects). */
async function clearSavedBackup(projectId: string): Promise<void> {
  const db = getDb();

  // Best-effort UploadThing cleanup so we don't orphan binary storage.
  try {
    const assets = await db
      .select({ key: projectAssets.uploadThingKey })
      .from(projectAssets)
      .where(eq(projectAssets.projectId, projectId));
    const keys = assets.map((a) => a.key).filter(Boolean);
    if (keys.length) {
      const { UTApi } = await import("uploadthing/server");
      await new UTApi().deleteFiles(keys);
    }
  } catch (e) {
    console.warn("[wc-migration] UploadThing cleanup failed (non-fatal)", e);
  }

  await db.delete(projectFiles).where(eq(projectFiles.projectId, projectId));
  await db.delete(projectAssets).where(eq(projectAssets.projectId, projectId));
  await db.delete(projectSyncManifests).where(eq(projectSyncManifests.projectId, projectId));
}

/**
 * Migrate a single legacy WebContainer project to a Vercel sandbox.
 * Idempotent: safe to call repeatedly; a no-op once the project is sandbox-based.
 */
export async function migrateWebContainerProjectToSandbox(
  projectId: string,
  userId: string,
): Promise<MigrationResult> {
  const db = getDb();
  const access = await requireProjectAccess(projectId, userId);
  if (!access) return { migrated: false, reason: "not-found" };
  const { project } = access;
  if (project.platform !== "web") return { migrated: false, reason: "not-web" };

  const template: SandboxTemplate = project.backendType === "none" ? "vite" : "viteConvex";

  // 1. Ensure the sandbox VM exists. Platform is still "web", so getOrCreate's
  //    auto-reseed (which keys off pickSandboxTemplate) is a no-op and won't
  //    drop template files on top of the content we're about to restore.
  const sandbox = await getOrCreatePersistentSandbox(projectId);

  let fileCount = 0;
  let assetCount = 0;
  let seededTemplate: SandboxTemplate | undefined;

  // 2. Populate — unless a prior interrupted run already wrote the files.
  if (!(await sandboxHasContent(sandbox))) {
    const textFiles = await db
      .select({ path: projectFiles.path, content: projectFiles.content })
      .from(projectFiles)
      .where(eq(projectFiles.projectId, projectId));
    const assets = await db
      .select({ path: projectAssets.path, uploadThingUrl: projectAssets.uploadThingUrl })
      .from(projectAssets)
      .where(eq(projectAssets.projectId, projectId));

    if (textFiles.length === 0 && assets.length === 0) {
      // Nothing was ever saved — hand the user a working starter template.
      await seedSandboxIfEmpty(projectId, template);
      seededTemplate = template;
    } else {
      await writeFilesIntoSandbox(sandbox, textFiles, assets);
      fileCount = textFiles.length;
      assetCount = assets.length;
    }
  }

  // 3. Carry Convex over: regenerate .env (VITE_CONVEX_URL + user vars).
  if (project.backendType !== "none") {
    try {
      await materializeFrontendEnv(projectId);
    } catch (e) {
      console.warn("[wc-migration] env materialize failed (non-fatal)", e);
    }
  }

  // 4. Finalize: flip the slug and erase WebContainer/GitHub/legacy-domain traces.
  //    GitHub link is intentionally dropped — the user re-links via the sandbox
  //    GitHub panel (per product decision).
  await db
    .update(projects)
    .set({
      platform: "sandboxed-web",
      sandboxTemplate: template,
      githubRepoOwner: null,
      githubRepoName: null,
      githubDefaultBranch: "main",
      githubLastPushedSha: null,
      gitAutonomy: null,
      customDomain: null,
      customDomainStatus: null,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));

  // 5. Clear the saved-file rows now that the sandbox is the source of truth.
  await clearSavedBackup(projectId);

  return { migrated: true, fileCount, assetCount, seededTemplate };
}
