/**
 * POST /api/projects/[id]/convex/setup-auth
 *
 * Provisions Convex Auth on a sandboxed-web project:
 *   1. Generates an RSA-256 key pair server-side.
 *   2. Sets CONVEX_AUTH_PRIVATE_KEY, JWKS, SITE_URL, CONVEX_SITE_URL on the
 *      Convex deployment via its own admin HTTP API. Credentials stay server-side.
 *   3. Returns boilerplate file templates + a rich reference context.
 *
 * Safe to call multiple times — it just rotates the signing keys.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { setupConvexAuth } from "@/lib/convex-auth-setup";
import { getUserCredentials } from "@/lib/user-credentials";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const { id: projectId } = await params;
    const db = getDb();
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);

    if (!project) {
      return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
    }
    if (project.backendType === "none") {
      return NextResponse.json(
        { ok: false, error: "This project has no backend — Convex Auth is not available." },
        { status: 400 },
      );
    }
    const isSwift = project.platform === "swift";
    if (project.platform !== "sandboxed-web" && !isSwift) {
      return NextResponse.json(
        { ok: false, error: "setupAuth is only available for sandboxed-web and swift projects." },
        { status: 400 },
      );
    }

    // Resolve SITE_URL. Web reads it from the sandbox's stable preview domain.
    // Swift has no web preview origin — its "frontend" returns to a custom URL
    // scheme — so SITE_URL only needs to be a valid URL (password sign-in never
    // redirects). Use the deployment's own *.convex.site origin when known.
    let siteUrl = "https://placeholder.example.com";
    if (isSwift) {
      const convexUrl = project.convexDeployUrl ?? project.userConvexUrl ?? null;
      if (convexUrl) siteUrl = convexUrl.replace(".convex.cloud", ".convex.site");
    } else {
      try {
        const sandbox = await getOrCreatePersistentSandbox(projectId);
        siteUrl = sandbox.domain(5173);
      } catch (err) {
        console.warn("[setup-auth] could not resolve sandbox preview URL:", err);
      }
    }

    // For BYOC backends, use the user's Convex OAuth access token
    let userConvexOAuthToken: string | null = null;
    if (project.backendType === "user") {
      const creds = await getUserCredentials(userId);
      userConvexOAuthToken = creds.convexOAuthAccessToken;
      if (!userConvexOAuthToken) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Your Convex account is not connected. Please reconnect it in Settings → Connections before setting up auth.",
          },
          { status: 402 },
        );
      }
    }

    const result = await setupConvexAuth(projectId, {
      siteUrl,
      userConvexOAuthToken,
      platform: isSwift ? "swift" : "web",
    });

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[setup-auth] unhandled error:", err);
    return NextResponse.json({ ok: false, error: `setupAuth failed: ${message}` }, { status: 500 });
  }
}
