import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import {
  ensureBundleIdRegistered,
  findAppByBundleId,
  type AscAuth,
} from "@/lib/asc-publish";
import { swiftProjectForbidden } from "@/lib/swift-access";
import { getUserCredentials } from "@/lib/user-credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const BUNDLE_ID_RE = /^[A-Za-z0-9.-]+$/;

/**
 * Does an App Store Connect app record exist for this bundle id?
 * The publish wizard polls this to auto-detect the user finishing the
 * one-time manual "New App" step on App Store Connect (app records cannot
 * be created via the API).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { project } = access;
  if (project.platform !== "swift") {
    return NextResponse.json(
      { error: "Project platform must be 'swift'." },
      { status: 400 },
    );
  }
  if (await swiftProjectForbidden(project)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
      { status: 403 },
    );
  }

  const bundleId = req.nextUrl.searchParams.get("bundleId")?.trim() ?? "";
  if (!bundleId || !BUNDLE_ID_RE.test(bundleId)) {
    return NextResponse.json(
      { error: "Missing or invalid bundleId query param." },
      { status: 400 },
    );
  }

  try {
    const creds = await getUserCredentials(userId);
    if (!creds.appleAscIssuerId || !creds.appleAscKeyId || !creds.appleAscKeyP8) {
      return NextResponse.json(
        {
          error:
            "Apple Developer credentials are not connected. Add your App Store Connect API key in Settings first.",
          missingCredentials: true,
        },
        { status: 400 },
      );
    }
    const ascAuth: AscAuth = {
      issuerId: creds.appleAscIssuerId,
      keyId: creds.appleAscKeyId,
      p8: creds.appleAscKeyP8,
    };
    // Register the bundle id up front so it is selectable in App Store Connect's
    // "New App" → Bundle ID dropdown while the user creates the app record. That
    // dropdown only lists already-registered identifiers, and the record can't be
    // created via API — so without this, first-time users open "New App", can't
    // find their bundle id, and stall. Best-effort: never throws, and xcodebuild
    // -allowProvisioningUpdates would register it later anyway.
    const appName = req.nextUrl.searchParams.get("name")?.trim();
    await ensureBundleIdRegistered(ascAuth, bundleId, appName || bundleId);
    const app = await findAppByBundleId(ascAuth, bundleId);
    if (!app) {
      return NextResponse.json({ found: false });
    }
    return NextResponse.json({
      found: true,
      ascAppId: app.ascAppId,
      ...(app.name ? { appName: app.name } : {}),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "App record lookup failed";
    console.error("[swift-publish/app-status]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
