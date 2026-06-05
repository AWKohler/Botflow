import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import {
  seedSandboxIfEmpty,
  seedSandboxFromBundle,
  type SandboxTemplate,
} from "@/lib/vercel-sandbox";
import { materializeFrontendEnv } from "@/lib/sandbox-env";
import { swiftRuntimeForbidden } from "@/lib/swift-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, id));

  if (!project || project.userId !== userId || (project.platform !== "swift" && project.platform !== "sandboxed-web")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Swift's runtime is beta-only; deny non-beta owners of legacy swift projects.
  if (await swiftRuntimeForbidden(project.platform, userId)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
      { status: 403 },
    );
  }

  // Pick the template based on platform + backendType.
  let template: SandboxTemplate;
  if (project.platform === "swift") {
    template = project.backendType === "none" ? "swift" : "swiftConvex";
  } else if (project.backendType === "none") {
    template = "vite";
  } else {
    template = "viteConvex";
  }

  try {
    // Forked-from-public projects carry a source bundle to extract instead of a
    // template. Use it once, then clear the pointer.
    let seeded: boolean;
    if (project.seedBundleUrl) {
      seeded = await seedSandboxFromBundle(project.id, project.seedBundleUrl);
      await db.update(projects).set({ seedBundleUrl: null }).where(eq(projects.id, project.id));
    } else {
      seeded = await seedSandboxIfEmpty(project.id, template);
    }

    // Sandboxed-web projects: write .env so Vite picks up VITE_CONVEX_URL plus
    // any user-defined frontend vars on the first dev server start. DB is the
    // source of truth — materializeFrontendEnv regenerates the whole file.
    if (seeded && project.platform === "sandboxed-web") {
      try {
        await materializeFrontendEnv(project.id);
      } catch (e) {
        console.warn("Failed to write sandbox .env:", e);
      }
    }

    return NextResponse.json({ seeded, template });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to seed sandbox" },
      { status: 500 },
    );
  }
}
