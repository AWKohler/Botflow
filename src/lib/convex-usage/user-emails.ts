/**
 * User-facing (project OWNER) emails for the Convex usage guardrails —
 * distinct from the operator alerts in alert.ts. Two messages:
 *
 *   warned — congratulatory in tone ("your app is busy"), sent on the
 *            active→warned transition. The good-faith viral app hears about
 *            limits BEFORE anything goes dark.
 *   paused — factual, sent when the deployment is actually paused
 *            (auto-pause mode only; alert-only mode pauses nothing, so the
 *            owner gets no pause email for a pause that didn't happen).
 *
 * Reuses the reaper's branded shell/esc. Best-effort like the reaper's
 * emails: failures are logged by the caller, never block the sweep.
 */

import { sendEmail, type SendEmailResult } from "@/lib/email";
import { esc, shell } from "@/lib/reaper/emails";

const SITE = "https://botflow.io";
const SUPPORT_MAILTO = "mailto:support@botflow.io?subject=Convex%20backend%20paused";

export function sendConvexWarnedEmail(opts: {
  to: string;
  name: string | null;
  projectName: string;
  projectId: string;
}): Promise<SendEmailResult> {
  const greeting = opts.name ? `Hi ${esc(opts.name)},` : "Hi,";
  const link = `${SITE}/workspace/${opts.projectId}`;
  const html = shell(
    `${opts.projectName} is getting busy`,
    `
    <h2 style="margin:0 0 12px;font-size:20px;">Your app is getting busy 🎉</h2>
    <p>${greeting}</p>
    <p>
      <strong>${esc(opts.projectName)}</strong>'s backend is seeing a lot of
      traffic — more than most apps on managed hosting. That's usually great
      news, but it can also mean a runaway loop (like a scheduled function
      re-triggering itself), so it's worth a quick look.
    </p>
    <p>
      If usage keeps climbing past what managed hosting includes, the backend
      may be paused automatically to protect the platform. If your app is
      genuinely taking off, reply to this email — we can move the backend to
      your own Convex account so it's never capped by platform limits.
    </p>
    <p style="margin-top:20px;">
      <a href="${link}" style="display:inline-block;background:#0a0a0a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">
        Open ${esc(opts.projectName)}
      </a>
    </p>`,
  );
  return sendEmail({
    to: opts.to,
    subject: `${opts.projectName} is getting busy — a heads-up about backend usage`,
    html,
  });
}

export function sendConvexPausedEmail(opts: {
  to: string;
  name: string | null;
  projectName: string;
  projectId: string;
}): Promise<SendEmailResult> {
  const greeting = opts.name ? `Hi ${esc(opts.name)},` : "Hi,";
  const link = `${SITE}/workspace/${opts.projectId}`;
  const html = shell(
    `${opts.projectName}: backend paused`,
    `
    <h2 style="margin:0 0 12px;font-size:20px;">Your backend has been paused</h2>
    <p>${greeting}</p>
    <p>
      <strong>${esc(opts.projectName)}</strong>'s backend exceeded the usage
      included with managed hosting, so it has been paused. While paused, the
      app's database queries and functions will fail. <strong>Your data is
      safe</strong> — nothing has been deleted, and this is fully reversible.
    </p>
    <p>
      This usually means a runaway loop (for example a scheduled function
      re-triggering itself) or genuinely heavy traffic.
    </p>
    <p>
      To get running again — including moving the backend to your own Convex
      account so it's never capped by platform limits —
      <a href="${SUPPORT_MAILTO}" style="color:#0066cc;">contact us</a> or just
      reply to this email. If you think this is a mistake, tell us that too;
      accidental loops are easy to fix and unpause.
    </p>
    <p style="margin-top:20px;">
      <a href="${link}" style="display:inline-block;background:#0a0a0a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">
        Open ${esc(opts.projectName)}
      </a>
    </p>`,
  );
  return sendEmail({
    to: opts.to,
    subject: `Action needed: ${opts.projectName}'s backend is paused`,
    html,
  });
}
