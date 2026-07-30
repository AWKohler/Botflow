export type ProjectPlatform = "web" | "swift" | "sandboxed-web" | "mobile" | "multiplatform";

export function isSwiftPlatformEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ALLOW_PERSISTENT_EXP === "true";
}

export function isSandboxedWebPlatformEnabled(): boolean {
  // Sandboxed-web ("Web") is now the default, always-on platform. The flag is
  // retained only so legacy call sites keep compiling; it always reports true.
  return true;
}

export function isMobilePlatformsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ALLOW_MOBILE_EXP === "true";
}

/** Returns true for any platform that runs in a Vercel sandbox (not a WebContainer). */
export function isSandboxPlatform(platform: string): boolean {
  return platform === "swift" || platform === "sandboxed-web";
}

export function getEnabledProjectPlatforms(): ProjectPlatform[] {
  // "Web" (stored as sandboxed-web, a Vercel sandbox) is the default platform.
  // Swift remains a flag-gated beta. WebContainer ("web"), mobile, and
  // multiplatform are deprecated and no longer creatable.
  const platforms: ProjectPlatform[] = ["sandboxed-web"];

  if (isSwiftPlatformEnabled()) {
    platforms.push("swift");
  }

  return platforms;
}

export function isProjectPlatform(value: string): value is ProjectPlatform {
  return (
    value === "web" ||
    value === "swift" ||
    value === "sandboxed-web" ||
    value === "mobile" ||
    value === "multiplatform"
  );
}

export function normalizeProjectPlatform(
  platform: string | null | undefined,
): ProjectPlatform {
  if (platform === "swift" && isSwiftPlatformEnabled()) {
    return "swift";
  }

  if (platform === "sandboxed-web") {
    return "sandboxed-web";
  }

  // Legacy WebContainer projects pass through as "web" so the workspace can
  // route them to the on-open migration gate. They never get re-created at
  // this value — new/unknown projects default to the sandbox platform.
  if (platform === "web") {
    return "web";
  }

  // Deprecated (mobile/multiplatform) and anything unrecognized → default.
  return "sandboxed-web";
}

export function getNextProjectPlatform(
  currentPlatform: ProjectPlatform,
): ProjectPlatform {
  const platforms = getEnabledProjectPlatforms();
  const currentIndex = platforms.indexOf(currentPlatform);

  if (currentIndex === -1) {
    return platforms[0] ?? "web";
  }

  return platforms[(currentIndex + 1) % platforms.length] ?? "web";
}

export function getProjectPlatformLabel(platform: string): string {
  switch (platform) {
    case "swift":
      return "Swift";
    // Legacy "mobile"/"multiplatform" rows are deprecated; surface them as Web
    // so old list items don't render a dead label.
    case "mobile":
    case "multiplatform":
    case "sandboxed-web":
    case "web":
    default:
      return "Web";
  }
}

export function getProjectPlatformShortLabel(platform: string): string {
  switch (platform) {
    case "swift":
      return "Swift";
    case "mobile":
    case "multiplatform":
    case "sandboxed-web":
    case "web":
    default:
      return "Web";
  }
}

export function isWebLikePlatform(platform: string): boolean {
  return platform === "web" || platform === "sandboxed-web";
}

/**
 * Backend type for a project.
 *  - 'platform' : Botflow-managed Convex backend (default for paid users)
 *  - 'user'     : User-owned Convex (BYOC) provisioned via OAuth
 *  - 'muhkoo'   : Botflow-managed MuhKoo backend (edge BaaS). Platform-owned
 *                 ONLY — there is no bring-your-own MuhKoo. Uses a different
 *                 SDK (@muhkoo/connect) + provisioning path, and has NO
 *                 Database tab (MuhKoo has no embedded dashboard).
 *  - 'none'     : No backend at all — the project is a frontend-only app
 *                 (no backend folder, no Database tab, no deploy tool).
 */
export type BackendType = "platform" | "user" | "muhkoo" | "none";

export function isBackendType(value: string): value is BackendType {
  return (
    value === "platform" ||
    value === "user" ||
    value === "muhkoo" ||
    value === "none"
  );
}

export function normalizeBackendType(
  value: string | null | undefined,
): BackendType {
  // Only explicit, recognized values map to a backend. Anything missing or
  // unrecognized falls back to "none" (no backend) so a project can never
  // silently default into a managed backend without an explicit choice.
  if (
    value === "user" ||
    value === "none" ||
    value === "platform" ||
    value === "muhkoo"
  ) {
    return value;
  }
  return "none";
}

/**
 * Whether a project (with the given backendType) uses Convex specifically.
 * True ONLY for the Convex-backed types ('platform' and 'user'). MuhKoo and
 * 'none' return false — callers that mean "has ANY backend" must use
 * {@link projectHasBackend} instead. (Convex-only surfaces such as the
 * Database tab, convexDeploy, and the /convex folder key off this.)
 */
export function projectUsesConvex(
  backendType: string | null | undefined,
): boolean {
  return backendType === "platform" || backendType === "user";
}

/**
 * Whether a project uses the MuhKoo backend (edge BaaS). Platform-owned only.
 */
export function projectUsesMuhkoo(
  backendType: string | null | undefined,
): boolean {
  return backendType === "muhkoo";
}

/**
 * Whether a project has ANY managed backend (Convex or MuhKoo). Only 'none'
 * returns false. Use this for backend-agnostic gating; narrow to a specific
 * backend with {@link projectUsesConvex} / {@link projectUsesMuhkoo}.
 */
export function projectHasBackend(
  backendType: string | null | undefined,
): boolean {
  return backendType !== "none";
}

export function getBackendTypeLabel(backendType: string): string {
  switch (backendType) {
    case "user":
      return "Bring Your Own Convex";
    case "muhkoo":
      return "MuhKoo (Beta)";
    case "none":
      return "No Backend";
    case "platform":
    default:
      return "Botflow Managed";
  }
}
