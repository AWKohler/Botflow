/**
 * MuhKoo backend access gating.
 *
 * MuhKoo is in private beta. Access is gated on the same beta flag used for
 * Swift (Clerk `publicMetadata.isBeta`, cached in Redis — see `isBetaUser`).
 * Mirrors `swift-access.ts`.
 */
import { isBetaUser } from "@/lib/tier";

/**
 * Whether a user is forbidden from using a MuhKoo backend for the given
 * backendType. Returns false (allowed) for any non-MuhKoo backend, so callers
 * can invoke this unconditionally with zero cost on the common path.
 */
export async function muhkooForbidden(
  backendType: string,
  userId: string,
): Promise<boolean> {
  if (backendType !== "muhkoo") return false;
  return !(await isBetaUser(userId));
}
