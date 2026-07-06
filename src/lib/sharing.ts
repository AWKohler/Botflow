/**
 * Project sharing — invite/claim/member helpers + the shared-turn guard.
 * See docs/features/project-sharing-plan.md §4 (invites) and §5.2 (turns).
 * Everything here is inert unless SHARING_ENABLED (feature-flags.ts).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { clerkClient } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projectMembers, type ProjectMember } from '@/db/schema';
import { SHARING_ENABLED } from '@/lib/feature-flags';
import { sendEmail } from '@/lib/email';
import { getTurnRecord } from '@/lib/agent/claude-code/turn-registry';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Pending invites older than this are treated as expired (lazy — no cron). */
export const INVITE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

export function inviteExpired(m: Pick<ProjectMember, 'status' | 'invitedAt'>): boolean {
  return m.status === 'pending' && Date.now() - m.invitedAt.getTime() > INVITE_EXPIRY_MS;
}

/**
 * Find an existing Clerk user by email — matching VERIFIED addresses only,
 * so an unverified claim on someone else's email can never capture an invite.
 */
export async function findClerkUserByVerifiedEmail(
  email: string,
): Promise<{ userId: string } | null> {
  const client = await clerkClient();
  const { data } = await client.users.getUserList({ emailAddress: [email] });
  for (const u of data) {
    const verified = u.emailAddresses.some(
      (e) =>
        e.emailAddress.toLowerCase() === email &&
        e.verification?.status === 'verified',
    );
    if (verified) return { userId: u.id };
  }
  return null;
}

/** All of a Clerk user's VERIFIED email addresses, normalized. */
export async function verifiedEmailsForUser(userId: string): Promise<string[]> {
  const client = await clerkClient();
  const u = await client.users.getUser(userId);
  return u.emailAddresses
    .filter((e) => e.verification?.status === 'verified')
    .map((e) => normalizeEmail(e.emailAddress));
}

/**
 * Claim pending invites for a user by their verified emails: fills userId,
 * flips status to active. Called from the Clerk user.created webhook, with a
 * lazy fallback on the projects-list route (covers missed webhooks). Expired
 * pendings are skipped. Returns how many rows were claimed.
 */
export async function claimPendingInvites(userId: string, verifiedEmails: string[]): Promise<number> {
  if (!SHARING_ENABLED || verifiedEmails.length === 0) return 0;
  const db = getDb();
  const pending = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        inArray(projectMembers.invitedEmail, verifiedEmails),
        eq(projectMembers.status, 'pending'),
      ),
    );
  const claimable = pending.filter((m) => !inviteExpired(m));
  if (claimable.length === 0) return 0;
  await db
    .update(projectMembers)
    .set({ userId, status: 'active', acceptedAt: new Date() })
    .where(
      inArray(
        projectMembers.id,
        claimable.map((m) => m.id),
      ),
    );
  return claimable.length;
}

// ─── Invite email ────────────────────────────────────────────────────────────

export async function sendInviteEmail(opts: {
  to: string;
  inviterName: string;
  projectName: string;
  projectId: string;
  /** True when the invitee already has an account (added instantly). */
  existingUser: boolean;
}): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://botflow.io';
  const link = opts.existingUser
    ? `${appUrl}/workspace/${opts.projectId}`
    : `${appUrl}/sign-up?redirect_url=${encodeURIComponent(`/workspace/${opts.projectId}`)}`;
  const cta = opts.existingUser ? 'Open the project' : 'Create your account';
  const lead = opts.existingUser
    ? `You now have edit access — open it any time from your projects page.`
    : `Create a Botflow account with this email address and the project will be waiting for you.`;
  const { ok, error } = await sendEmail({
    to: opts.to,
    subject: `${opts.inviterName} shared "${opts.projectName}" with you on Botflow`,
    html: `
      <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#2f2f31">
        <h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(opts.inviterName)} shared a project with you</h2>
        <p style="font-size:14px;line-height:1.6;margin:0 0 8px">
          <strong>${escapeHtml(opts.projectName)}</strong> on Botflow — you can open the workspace,
          chat with your own AI agent, and edit the app together.
        </p>
        <p style="font-size:14px;line-height:1.6;margin:0 0 20px">${lead}</p>
        <a href="${link}" style="display:inline-block;background:#1d52f1;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:10px">${cta}</a>
        <p style="font-size:12px;color:#8a8a8e;margin:24px 0 0">
          Invites expire after 14 days. If you weren't expecting this, you can ignore it.
        </p>
      </div>`,
    text: `${opts.inviterName} shared "${opts.projectName}" with you on Botflow. ${lead} ${link}`,
  });
  if (!ok) console.warn('[sharing] invite email failed:', error);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Shared-turn guard (plan Phase 3: agents globally serialized) ───────────

/** Turns older than this are assumed dead even without an end marker (the
 *  route's maxDuration is 300s; detached bridges rarely outlive a few multiples). */
const TURN_STALE_MS = 15 * 60 * 1000;

/**
 * Phase 3 keeps one agent per project across ALL collaborators: if another
 * user's turn is live, a new spawn is rejected instead of killing their
 * bridge (the existing kill-previous behavior stays for one's OWN turns).
 * Returns an error message when blocked, else null.
 */
export async function sharedTurnBlockReason(
  projectId: string,
  userId: string,
): Promise<string | null> {
  if (!SHARING_ENABLED) return null;
  const record = await getTurnRecord(projectId);
  if (!record || record.endedNormally || record.dead) return null;
  if (!record.userId || record.userId === userId) return null;
  if (Date.now() - record.startedAt > TURN_STALE_MS) return null;
  return "Another collaborator's agent is currently working in this project. Wait for it to finish, then try again.";
}
