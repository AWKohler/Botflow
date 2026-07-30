import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { requireProjectAccess } from "@/lib/project-access";
import {
  seedSandboxIfEmpty,
  seedSandboxFromBundle,
  type SandboxTemplate,
} from "@/lib/vercel-sandbox";
import { materializeFrontendEnv } from "@/lib/sandbox-env";
import { swiftProjectForbidden } from "@/lib/swift-access";
import { enforce, identifierFor } from "@/lib/rate-limit";
import { ensureMuhkooProvisioned } from "@/lib/muhkoo-provision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Heavy IO+compute: template extract / bundle seed + env materialization.
  const blocked = await enforce(identifierFor(userId, req), "expensive");
  if (blocked) return blocked;

  const { id } = await params;
  const access = await requireProjectAccess(id, userId);
  if (!access || (access.project.platform !== "swift" && access.project.platform !== "sandboxed-web")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { project } = access;
  // Swift's runtime is beta-only; deny non-beta owners of legacy swift projects.
  if (await swiftProjectForbidden(project)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
      { status: 403 },
    );
  }

  // Pick the template based on platform + backendType.
  let template: SandboxTemplate;
  if (project.platform === "swift") {
    template = project.backendType === "none" ? "swift" : "swiftConvex";
  } else if (project.backendType === "muhkoo") {
    template = "viteMuhkoo";
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
      await getDb().update(projects).set({ seedBundleUrl: null }).where(eq(projects.id, project.id));
    } else {
      seeded = await seedSandboxIfEmpty(project.id, template);
    }

    // Sandboxed-web projects: write .env so Vite picks up VITE_CONVEX_URL plus
    // any user-defined frontend vars on the first dev server start. DB is the
    // source of truth — materializeFrontendEnv regenerates the whole file.
    // MuhKoo projects: ensure the backend app exists on EVERY seed call, not
    // just when this route did the seeding — the sandbox get-or-create path can
    // auto-reseed the template first (making `seeded` false here), and an
    // earlier provisioning failure (e.g. expired platform token) must heal on
    // the next workspace open. ensureMuhkooProvisioned is idempotent.
    let muhkooWarning: string | undefined;
    if (project.backendType === "muhkoo") {
      try {
        await ensureMuhkooProvisioned(project.id);
      } catch (e) {
        muhkooWarning = e instanceof Error ? e.message : String(e);
        console.warn("[seed] MuhKoo provisioning failed:", muhkooWarning);
      }
    }

    // For muhkoo, rewrite .env even when this call didn't seed, so a
    // just-provisioned publishable key lands regardless of who seeded.
    if (
      project.platform === "sandboxed-web" &&
      (seeded || project.backendType === "muhkoo")
    ) {
      try {
        await materializeFrontendEnv(project.id);
      } catch (e) {
        console.warn("Failed to write sandbox .env:", e);
      }
    }

    return NextResponse.json({
      seeded,
      template,
      ...(muhkooWarning ? { muhkooWarning } : {}),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to seed sandbox" },
      { status: 500 },
    );
  }
}
