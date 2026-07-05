import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import {
  ensureBundleIdRegistered,
  findAppByBundleId,
  nextBuildNumber,
  type AscAuth,
} from "@/lib/asc-publish";
import { materializeSwiftBuildConfig } from "@/lib/sandbox-env";
import { submitAppStoreBuild } from "@/lib/sim-platform";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import { recordSwiftPublishBuild } from "@/lib/swift-publish-store";
import { getUserCredentials } from "@/lib/user-credentials";
import { tarSandboxProject } from "@/lib/vercel-sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Reverse-DNS: ≥2 dot-separated segments, each alphanumeric-led, ≤63 chars.
// Rejects junk the loose `[A-Za-z0-9.-]+` admitted (".", "..", "com.").
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}(\.[A-Za-z0-9][A-Za-z0-9-]{0,62})+$/;
const MARKETING_VERSION_RE = /^\d+\.\d+(\.\d+)?$/;

interface SubmitBody {
  bundleId?: unknown;
  marketingVersion?: unknown;
  appName?: unknown;
  scheme?: unknown;
}

export async function POST(
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
  if (await swiftRuntimeForbidden(project.platform, userId)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as SubmitBody | null;
  const bundleId = typeof body?.bundleId === "string" ? body.bundleId.trim() : "";
  const marketingVersion =
    typeof body?.marketingVersion === "string" ? body.marketingVersion.trim() : "";
  const appName = typeof body?.appName === "string" ? body.appName.trim() : "";
  const scheme = typeof body?.scheme === "string" ? body.scheme.trim() : "";

  // Bound field sizes before any regex / downstream use (cheap abuse guard;
  // also stops a marketing version with arbitrarily long numeric components).
  if (
    bundleId.length > 155 ||
    marketingVersion.length > 18 ||
    appName.length > 255 ||
    scheme.length > 100
  ) {
    return NextResponse.json({ error: "One or more fields are too long." }, { status: 400 });
  }
  if (!bundleId || !BUNDLE_ID_RE.test(bundleId)) {
    return NextResponse.json(
      { error: "Invalid bundle id. Use reverse-DNS form, e.g. com.example.app." },
      { status: 400 },
    );
  }
  if (!marketingVersion || !MARKETING_VERSION_RE.test(marketingVersion)) {
    return NextResponse.json(
      { error: "Invalid marketing version. Use MAJOR.MINOR or MAJOR.MINOR.PATCH (e.g. 1.0 or 1.0.0)." },
      { status: 400 },
    );
  }

  try {
    // 1. Apple credentials (Clerk privateMetadata via the unified store)
    const creds = await getUserCredentials(userId);
    const { appleAscIssuerId, appleAscKeyId, appleAscKeyP8, appleTeamId } = creds;
    if (!appleAscIssuerId || !appleAscKeyId || !appleAscKeyP8 || !appleTeamId) {
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
      issuerId: appleAscIssuerId,
      keyId: appleAscKeyId,
      p8: appleAscKeyP8,
    };

    // 2. The app record must already exist on App Store Connect (the API
    //    cannot create one) — the wizard guides the user through that step.
    const app = await findAppByBundleId(ascAuth, bundleId);
    if (!app) {
      return NextResponse.json(
        {
          error: "No App Store Connect app record for this bundle id yet.",
          appRecordMissing: true,
          bundleId,
        },
        { status: 409 },
      );
    }

    // 3. Best-effort bundle-id registration (xcodebuild
    //    -allowProvisioningUpdates can also do it) + next CFBundleVersion.
    await ensureBundleIdRegistered(ascAuth, bundleId, appName || app.name || bundleId);
    const buildNumber = await nextBuildNumber(ascAuth, app.ascAppId);

    // 4. Snapshot the project source (same prep as the device-build flow).
    //    'release': App Store builds always carry the production appl_ key —
    //    never the Test Store key (dev builds are always test mode instead).
    await materializeSwiftBuildConfig(projectId, "release");
    const tarball = await tarSandboxProject(projectId, { excludeConvex: true });

    // 5. Hand off to the Mac controller for archive → signed export → upload.
    const build = await submitAppStoreBuild(tarball, {
      teamId: appleTeamId,
      keyId: appleAscKeyId,
      issuerId: appleAscIssuerId,
      p8Base64: Buffer.from(appleAscKeyP8).toString("base64"),
      ascAppId: app.ascAppId,
      bundleId,
      marketingVersion,
      buildNumber,
      ...(scheme ? { scheme } : {}),
    });

    // 6. Record ownership so status polls can be authorized cross-instance.
    await recordSwiftPublishBuild(build.buildId, userId, projectId);

    return NextResponse.json({
      buildId: build.buildId,
      state: build.state,
      buildNumber,
      marketingVersion,
      bundleId,
    });
  } catch (error) {
    // User-actionable failures (missing creds / app record / bad input) are
    // returned above. Anything reaching here is unexpected: log the detail
    // server-side (the p8 + x-asc-* headers are never part of these messages)
    // and return a generic message rather than echoing internal or controller
    // response bodies back to the client.
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[swift-publish/submit]", detail);
    return NextResponse.json(
      { error: "Couldn't start the App Store build. Please try again in a moment." },
      { status: 500 },
    );
  }
}
