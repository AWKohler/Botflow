/**
 * Clerk webhook receiver.
 *
 * Fires on user lifecycle events. We care about plan transitions:
 *   - free → paid: clear becameReapableAt on the user's projects; cancel
 *     in-flight reaper warnings; send a "you're safe" email for projects
 *     that had received warn90/warn104 in the previous free interval.
 *   - paid → free: set becameReapableAt = now on the user's non-archived
 *     projects so the reaper's idle clock starts from the downgrade. This
 *     gives a freshly-downgraded user the full warning window instead of
 *     inheriting two-year-old paid-era inactivity.
 *
 * Clerk dispatches `user.created`, `user.updated`, `user.deleted`, and
 * `session.*` events. We listen to user.updated because Clerk pushes
 * publicMetadata.plan changes through there. (Clerk Billing also surfaces
 * `subscription.*` events; we treat user.updated as the source of truth so
 * BOTH Clerk Billing and manually-set publicMetadata.plan flow through here.)
 *
 * Set CLERK_WEBHOOK_SECRET in the Clerk dashboard under the webhook endpoint
 * and replay events to test.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { Webhook } from "svix";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { invalidateTierCache, invalidateBetaCache, type Tier } from "@/lib/tier";
import { getEmailForClerkUser } from "@/lib/email";
import { claimPendingInvites, verifiedEmailsForUser } from "@/lib/sharing";
import { sendRestoredEmail } from "@/lib/reaper/emails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ClerkUserUpdated = {
  type: "user.updated" | "user.created" | "user.deleted";
  data: {
    id: string;
    public_metadata?: Record<string, unknown>;
  };
};

// Effective tier from the event's public_metadata. Beta is a FLOOR (free → pro)
// so a beta user with no paid plan isn't treated as free here — otherwise the
// reaper would start its idle clock on someone who has effective Pro access.
// Reads straight off the webhook payload, so no extra Clerk fetch.
function effectiveTierFromMetadata(md: Record<string, unknown> | undefined): Tier {
  const plan = (md as { plan?: string } | undefined)?.plan;
  if (plan === "max") return "max";
  if (plan === "pro") return "pro";
  return (md as { isBeta?: boolean } | undefined)?.isBeta === true ? "pro" : "free";
}

export async function POST(req: Request) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[clerk-webhook] CLERK_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const hdrs = await headers();
  const svixId = hdrs.get("svix-id");
  const svixTimestamp = hdrs.get("svix-timestamp");
  const svixSignature = hdrs.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing svix headers" }, { status: 400 });
  }

  const body = await req.text();
  let evt: ClerkUserUpdated;
  try {
    const wh = new Webhook(secret);
    evt = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkUserUpdated;
  } catch (e) {
    console.warn("[clerk-webhook] signature verification failed:", e);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (evt.type === "user.created" || evt.type === "user.updated") {
    await handlePlanChange(evt.data.id, effectiveTierFromMetadata(evt.data.public_metadata));
  }
  // user.deleted: leave projects alone; admin/console flow handles user removal.

  // Sharing: a new signup may be the target of pending project invites —
  // claim them by the account's VERIFIED emails (plan §4). Best-effort; the
  // projects-list route lazy-claims as a fallback for missed webhooks.
  if (evt.type === "user.created") {
    try {
      const emails = await verifiedEmailsForUser(evt.data.id);
      const claimed = await claimPendingInvites(evt.data.id, emails);
      if (claimed > 0) console.log(`[clerk-webhook] claimed ${claimed} project invite(s) for ${evt.data.id}`);
    } catch (e) {
      console.warn("[clerk-webhook] invite claim failed:", e);
    }
  }

  return NextResponse.json({ ok: true });
}

async function handlePlanChange(userId: string, newTier: Tier): Promise<void> {
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
