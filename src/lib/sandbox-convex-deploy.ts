/**
 * Server-side Convex deploy from a Vercel Sandbox.
 *
 * Mirrors the WebContainer flow in `convex-deploy.ts`, but reads files via the
 * sandbox API instead of the in-browser filesystem. The zip is sent to the same
 * Fly worker that the WebContainer path uses, via the existing
 * `/api/projects/:id/convex/deploy` route — keeping deploy auth and key
 * resolution unified across platforms.
 *
 * Used as the server-side `execute()` of the `convexDeploy` tool for the
 * sandboxed-web platform.
 */
import JSZip from "jszip";
import { sandboxListFiles, sandboxReadFile, sandboxWriteFile } from "./vercel-sandbox";

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface DeployResult {
  ok: boolean;
  output: string;
  error?: string;
  generatedFiles?: GeneratedFile[];
}

/**
 * Build the Convex deploy zip bundle from a project's sandbox filesystem.
 * Returns null when /convex doesn't exist (nothing to deploy).
 *
 * Format matches what the Fly worker expects: `convex/...` directory tree at
 * the top level plus the relevant manifest/lock files in the root.
 */
export async function buildConvexDeployZip(projectId: string): Promise<Blob | null> {
  const convexEntries = await sandboxListFiles(projectId, "/convex", false);
  if (convexEntries.length === 0) return null;

  const zip = new JSZip();
  await addSandboxFolderToZip(projectId, "/convex", zip, "convex");

  const supportFiles = ["/package.json", "/pnpm-lock.yaml", "/package-lock.json", "/tsconfig.json", "/convex.json"];
  for (const path of supportFiles) {
    const file = await sandboxReadFile(projectId, path);
    if (file && !file.binary) {
      zip.file(path.slice(1), file.content);
    }
  }

  return zip.generateAsync({ type: "blob" });
}

/**
 * Write the `_generated/*` files that Convex's deploy worker returns back
 * into the project sandbox so subsequent reads/greps see fresh types.
 */
export async function writeGeneratedConvexFiles(
  projectId: string,
  generatedFiles: GeneratedFile[],
): Promise<void> {
  for (const file of generatedFiles) {
    try {
      await sandboxWriteFile(projectId, `/convex/_generated/${file.path}`, file.content);
    } catch (err) {
      console.warn(`Failed to write generated file convex/_generated/${file.path}:`, err);
    }
  }
}

/**
 * Read /convex (recursively) plus support files from the sandbox, zip them,
 * and forward to the existing convex/deploy route which posts to the Fly worker.
 *
 * After a successful deploy, write the returned generated files back into the
 * sandbox so subsequent `read`/`grep` calls see fresh `_generated/api.d.ts` etc.
 */
export async function deployConvexFromSandbox(params: {
  projectId: string;
  /** Absolute base URL of the Botflow app (used to call our own /api route). */
  appBaseUrl: string;
  /**
   * Forwarded auth headers for the internal /api call. The convex/deploy route
   * uses Clerk auth() which reads from cookies/headers — server-to-server calls
   * must replay the inbound request's auth context.
   */
  authHeaders?: Record<string, string>;
}): Promise<DeployResult> {
  const { projectId, appBaseUrl, authHeaders = {} } = params;

  try {
    let zipBlob = await buildConvexDeployZip(projectId);

    if (!zipBlob) {
      // Sandbox may have expired and been re-created empty. Try auto-seeding —
      // but with the project's OWN template, not a hardcoded web one. A Swift
      // project must reseed `swiftConvex`, never `viteConvex`, or we'd clobber
      // its source tree.
      try {
        const { seedSandboxIfEmpty, pickSandboxTemplate } = await import("./vercel-sandbox");
        const { getDb } = await import("@/db");
        const { projects } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");

        const db = getDb();
        const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
        const template = project ? pickSandboxTemplate(project) : null;

        if (template) {
          const seeded = await seedSandboxIfEmpty(projectId, template);
          if (seeded) {
            // Regenerate the platform-correct config so the re-created sandbox
            // keeps its backend wiring: Swift gets ConvexConfig.swift, web gets
            // .env (frontend vars + VITE_CONVEX_URL).
            const { materializeFrontendEnv, materializeSwiftBuildConfig } =
              await import("./sandbox-env");
            const regenerate =
              project?.platform === "swift"
                ? materializeSwiftBuildConfig
                : materializeFrontendEnv;
            await regenerate(projectId).catch(() => undefined);
            zipBlob = await buildConvexDeployZip(projectId);
          }
        }
      } catch (reseedErr) {
        console.warn("[sandbox-convex-deploy] auto-reseed failed:", reseedErr);
      }
    }

    if (!zipBlob) {
      return {
        ok: false,
        output: "",
        error: "No convex folder found in project — nothing to deploy",
        generatedFiles: [],
      };
    }

    const response = await fetch(`${appBaseUrl}/api/projects/${projectId}/convex/deploy`, {
      method: "POST",
      headers: authHeaders,
      body: zipBlob,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        ok: false,
        output: errorData.output || "",
        error: errorData.error || `Deployment failed with status ${response.status}`,
        generatedFiles: [],
      };
    }

    const result = await response.json() as DeployResult;
    if (result.ok && result.generatedFiles && result.generatedFiles.length > 0) {
      await writeGeneratedConvexFiles(projectId, result.generatedFiles);
    }

    return result;
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: `Deployment error: ${error instanceof Error ? error.message : String(error)}`,
      generatedFiles: [],
    };
  }
}

async function addSandboxFolderToZip(
  projectId: string,
  sourcePath: string,
  zip: JSZip,
  zipPath: string,
): Promise<void> {
  const entries = await sandboxListFiles(projectId, sourcePath, false);

  for (const entry of entries) {
    const name = entry.path.split("/").pop() ?? "";
    if (name === "_generated" || name === "node_modules") continue;

    const fullSource = entry.path; // already project-relative starting with /
    const fullZip = `${zipPath}/${name}`;

    if (entry.type === "folder") {
      await addSandboxFolderToZip(projectId, fullSource, zip, fullZip);
    } else {
      const file = await sandboxReadFile(projectId, fullSource);
      if (!file) continue;
      if (file.binary) {
        zip.file(fullZip, Buffer.from(file.content, "base64"));
      } else {
        zip.file(fullZip, file.content);
      }
    }
  }
}
