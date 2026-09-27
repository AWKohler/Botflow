import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import {
  invalidateTierCache,
  invalidateBetaCache,
  type Tier,
} from "@/lib/tier";
import { getEmailForClerkUser } from "@/lib/email";
import { sendRestoredEmail } from "@/lib/reaper/emails";

export async function handlePlanChange(
  userId: string,
  newTier: Tier,
): Promise<void> {
  // Toggling isBeta arrives as a user.updated event too; refresh both caches so
  // tier (which beta can lift) and the Swift gate pick up the change immediately.
  await Promise.all([invalidateTierCache(userId), invalidateBetaCache(userId)]);
  const db = getDb();

  if (newTier === "free") {
    // Downgrade: stamp becameReapableAt on all of this user's non-archived
    // projects that don't already have it set.
    await db
      .update(projects)
      .set({ becameReapableAt: new Date() })
      .where(
        and(
          eq(projects.userId, userId),
          isNull(projects.deletedAt),
          isNull(projects.becameReapableAt),
          ne(projects.reapStage, "deleted"),
        ),
      );
    return;
  }

  // Upgrade (or stays paid): clear becameReapableAt and rewind any
  // in-warning reap stages back to active. Send a restoration email for
  // projects that had actually received a warning so the user gets explicit
  // closure on any "we'll delete your project" message in their inbox.
  const wasInWarning = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      and(
        eq(projects.userId, userId),
        inArray(projects.reapStage, ["warned_90d", "warned_104d"]),
      ),
    );

  await db
    .update(projects)
    .set({
      becameReapableAt: null,
      // Don't rescue archived/deleted projects automatically — those need a
      // deliberate restore flow. Just rewind in-progress warnings.
      reapStage: "active",
      lastReapWarningSentAt: null,
    })
    .where(
      and(
        eq(projects.userId, userId),
        inArray(projects.reapStage, ["active", "warned_90d", "warned_104d"]),
      ),
    );

  if (wasInWarning.length === 0) return;
  const contact = await getEmailForClerkUser(userId);
  if (!contact) return;
  for (const p of wasInWarning) {
    await sendRestoredEmail({
      to: contact.email,
      name: contact.name,
      projectName: p.name,
      projectId: p.id,
    }).catch((e) => console.warn("[clerk-webhook] restored email failed:", e));
  }
}
