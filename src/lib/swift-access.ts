import { getUserTier, tierMeetsRequirement } from "@/lib/tier";

/**
 * Swift is available to Pro/Max users and invited beta users. Beta users already
 * receive an automatic Pro tier floor in getUserTier(), so the effective tier is
 * the single source of truth for both access paths.
 */
export async function canUseSwift(userId: string): Promise<boolean> {
  const tier = await getUserTier(userId);
  return tierMeetsRequirement(tier, "pro");
}

/**
 * Gating project *creation* is not a security boundary: users can still own
 * legacy `platform === 'swift'` projects. Every request that can reach the Swift
 * runtime must call this — the trust boundary lives at the runtime endpoints,
 * not at creation.
 *
 * Returns true when access must be DENIED. Non-Swift projects always pass
 * (returns false without a Clerk/Redis lookup), so `sandboxed-web` — the default
 * platform for every user — is completely unaffected and pays zero overhead.
 *
 * Access is resolved through the effective tier, which is Redis-cached for 60s.
 */
export async function swiftRuntimeForbidden(
  platform: string,
  userId: string,
): Promise<boolean> {
  if (platform !== "swift") return false;
  return !(await canUseSwift(userId));
}

/**
 * Swift runtime entitlement for a PROJECT follows its OWNER, not the acting
 * user (sharing decision 2026-07-06): a free editor may work on a Swift
 * project shared by a paying owner — the owner's plan funds the runtime.
 * The one per-ACTOR gate is the iOS simulator (see the swift-preview routes):
 * simulator streaming requires the acting user to be Pro/Max themselves;
 * device builds stay open to free editors.
 *
 * For unshared projects owner == actor, so this is behavior-identical to the
 * old acting-user check everywhere sharing isn't in play.
 */
export async function swiftProjectForbidden(project: {
  platform: string;
  userId: string;
}): Promise<boolean> {
  return swiftRuntimeForbidden(project.platform, project.userId);
}
