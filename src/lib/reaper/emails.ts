/**
 * Email templates for the project reaper. Three transactional messages:
 *
 *   warn90  — "your project will be archived in ~14 days"
 *   warn104 — "your project is being archived now / will be deleted in 14 days"
 *   restored — "you upgraded; we're not deleting anything"
 *
 * Plain HTML strings (no JSX) — keeps the dependency surface small. If the
 * marketing team eventually wants richer designs, swap to @react-email.
 */

import { sendEmail, type SendEmailResult } from "@/lib/email";

const SITE = "https://botflow.io";

// Exported for reuse by other transactional mails (convex-usage guardrails).
export function shell(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.55;color:#0a0a0a;background:#f7f7f7;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e5e5;">
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #eee;margin:28px 0;">
    <p style="color:#777;font-size:12px;margin:0;">
      You're getting this from Botflow because of activity on your account.
      Manage your projects at <a href="${SITE}" style="color:#0066cc;">botflow.io</a>.
    </p>
  </div>
</body></html>`;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── warn90 ─────────────────────────────────────────────────────────────────
export function sendWarn90Email(opts: {
  to: string;
  name: string | null;
  projectName: string;
  projectId: string;
}): Promise<SendEmailResult> {
  const greeting = opts.name ? `Hi ${esc(opts.name)},` : "Hi,";
  const link = `${SITE}/workspace/${opts.projectId}`;
  const html = shell(
    `Your project ${opts.projectName} is going idle`,
    `
    <h2 style="margin:0 0 12px;font-size:20px;">Your project is going idle</h2>
    <p>${greeting}</p>
    <p>
      We haven't seen any activity on <strong>${esc(opts.projectName)}</strong> in about
      90 days. To keep our free tier lean, we'll archive its build environment
      in <strong>14 days</strong> unless you open it.
    </p>
    <p>
      Archiving is reversible — your code stays safe (especially if you've
      linked GitHub) and we'll restore the project the next time you open it.
      After archiving, if there's still no activity and no usage for another
      year, we may delete it permanently.
    </p>
    <p style="margin:24px 0;">
      <a href="${link}" style="background:#0066cc;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;">
        Open ${esc(opts.projectName)}
      </a>
    </p>
    <p style="color:#555;font-size:13px;">
      Upgrading to a paid plan also stops this — paid plans keep projects forever.
    </p>
    `,
  );
  const text = `${greeting}

We haven't seen activity on "${opts.projectName}" in about 90 days. We'll archive its build environment in 14 days unless you open it.

Open: ${link}

Archiving is reversible. Upgrading to a paid plan stops this entirely.`;
  return sendEmail({
    to: opts.to,
    subject: `Your project "${opts.projectName}" is going idle`,
    html,
    text,
  });
}

// ─── warn104 ────────────────────────────────────────────────────────────────
export function sendWarn104Email(opts: {
  to: string;
  name: string | null;
  projectName: string;
  projectId: string;
}): Promise<SendEmailResult> {
  const greeting = opts.name ? `Hi ${esc(opts.name)},` : "Hi,";
  const link = `${SITE}/workspace/${opts.projectId}`;
  const html = shell(
    `Archiving ${opts.projectName}`,
    `
    <h2 style="margin:0 0 12px;font-size:20px;">Archiving your project</h2>
    <p>${greeting}</p>
    <p>
      We're archiving <strong>${esc(opts.projectName)}</strong> today. Its sandbox
      environment will be torn down to save resources.
    </p>
    <p>
      Your project record is still here. Open it any time within the next year
      and we'll spin a fresh environment back up automatically. After a year of
      continued inactivity with no app traffic, we may delete the project.
    </p>
    <p style="margin:24px 0;">
      <a href="${link}" style="background:#0066cc;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;">
        Restore ${esc(opts.projectName)}
      </a>
    </p>
    `,
  );
  const text = `${greeting}

We're archiving "${opts.projectName}" today. Open it within a year to restore the environment automatically:
${link}`;
  return sendEmail({
    to: opts.to,
    subject: `Archiving "${opts.projectName}"`,
    html,
    text,
  });
}

// ─── restored ───────────────────────────────────────────────────────────────
export function sendRestoredEmail(opts: {
  to: string;
  name: string | null;
  projectName: string;
  projectId: string;
}): Promise<SendEmailResult> {
  const greeting = opts.name ? `Hi ${esc(opts.name)},` : "Hi,";
  const link = `${SITE}/workspace/${opts.projectId}`;
  const html = shell(
    `Welcome back — ${opts.projectName} is safe`,
    `
    <h2 style="margin:0 0 12px;font-size:20px;">Welcome back</h2>
    <p>${greeting}</p>
    <p>
      Thanks for upgrading. We've cancelled the pending archive of
      <strong>${esc(opts.projectName)}</strong>; nothing will be deleted.
    </p>
    <p style="margin:24px 0;">
      <a href="${link}" style="background:#0066cc;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;">
        Open ${esc(opts.projectName)}
      </a>
    </p>
    `,
  );
  const text = `${greeting}

Thanks for upgrading. We've cancelled the pending archive of "${opts.projectName}".

Open: ${link}`;
  return sendEmail({
    to: opts.to,
    subject: `Your project "${opts.projectName}" is safe`,
    html,
    text,
  });
}
