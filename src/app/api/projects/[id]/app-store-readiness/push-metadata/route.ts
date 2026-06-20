import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import { getUserCredentials } from "@/lib/user-credentials";
import { findAppByBundleId, type AscAuth } from "@/lib/asc-publish";
import { pushAppStoreMetadata, type MetadataPush } from "@/lib/app-store-readiness/asc-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}(\.[A-Za-z0-9][A-Za-z0-9-]{0,62})+$/;
const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;
const FIELD_MAX = { name: 30, subtitle: 30, description: 4000, keywords: 100 } as const;

/**
 * POST /api/projects/[id]/app-store-readiness/push-metadata
 * Body: { bundleId, marketingVersion, name?, subtitle?, description?, keywords? }
 * Pushes the approved text metadata to App Store Connect.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId } = await params;
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (project.platform !== "swift") {
    return NextResponse.json({ error: "Project platform must be 'swift'." }, { status: 400 });
  }
  if (await swiftRuntimeForbidden(project.platform, userId)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const bundleId = str(body.bundleId);
  const marketingVersion = str(body.marketingVersion);

  if (!BUNDLE_ID_RE.test(bundleId)) {
    return NextResponse.json({ error: "Invalid bundle id." }, { status: 400 });
  }
  if (!VERSION_RE.test(marketingVersion)) {
    return NextResponse.json({ error: "Invalid marketing version." }, { status: 400 });
  }

  // Only forward fields that are present and within Apple's limits.
  const meta: MetadataPush = {};
  for (const key of ["name", "subtitle", "description", "keywords"] as const) {
    const v = str(body[key]);
    if (!v) continue;
    if (v.length > FIELD_MAX[key]) {
      return NextResponse.json({ error: `${key} exceeds ${FIELD_MAX[key]} characters.` }, { status: 400 });
    }
    meta[key] = v;
  }
  if (Object.keys(meta).length === 0) {
    return NextResponse.json({ error: "Nothing to push — provide at least one field." }, { status: 400 });
  }

  const creds = await getUserCredentials(userId);
  if (!creds.appleAscIssuerId || !creds.appleAscKeyId || !creds.appleAscKeyP8) {
    return NextResponse.json(
      { error: "Apple Developer credentials are not connected.", missingCredentials: true },
      { status: 400 },
    );
  }
  const ascAuth: AscAuth = {
    issuerId: creds.appleAscIssuerId,
    keyId: creds.appleAscKeyId,
    p8: creds.appleAscKeyP8,
  };

  try {
    const app = await findAppByBundleId(ascAuth, bundleId);
    if (!app) {
      return NextResponse.json(
        { error: "No App Store Connect app record for this bundle id yet.", appRecordMissing: true, bundleId },
        { status: 409 },
      );
    }
    const result = await pushAppStoreMetadata(ascAuth, app.ascAppId, meta, marketingVersion);
    return NextResponse.json(result);
  } catch (error) {
    console.error(
      "[app-store-readiness/push-metadata]",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: "Couldn't push metadata to App Store Connect." }, { status: 500 });
  }
}
