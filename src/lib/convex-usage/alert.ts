/**
 * Operator alerts for the Convex usage guardrails. These go to the platform
 * operator (CONVEX_USAGE_ALERT_EMAIL), NOT to end users — user-facing emails
 * are Phase 2 (see docs/features/convex-usage-guardrails.md).
 */

import { sendEmail } from "@/lib/email";

export type UsageAlertKind =
  | "warn"
  | "pause"
  | "would_pause"
  | "pause_failed"
  | "paused_but_active";

export type UsageAlertInput = {
  kind: UsageAlertKind;
  projectId: string;
  projectName: string;
  ownerUserId: string;
  deploymentName: string;
  callsToday: number;
  warnThreshold: number;
  pauseThreshold: number;
  /** Extra context line (e.g. the pause error). */
  detail?: string;
};

const KIND_SUBJECT: Record<UsageAlertKind, string> = {
  warn: "⚠️ Convex usage warning",
  pause: "⛔ Convex deployment PAUSED",
  would_pause: "⛔ Convex deployment over pause threshold (auto-pause OFF)",
  pause_failed: "🚨 Convex PAUSE FAILED — deployment still running over threshold",
  paused_but_active: "🚨 Paused Convex deployment is serving traffic (state drift)",
};

// Full HTML escape — project names are user-controlled.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Returns true when the alert was delivered OR alerting is deliberately
 * unconfigured (env unset); false only on an attempted-but-failed send, so
 * callers can hold back a status transition and retry next tick.
 */
export async function sendUsageAlert(input: UsageAlertInput): Promise<boolean> {
  const to = process.env.CONVEX_USAGE_ALERT_EMAIL;
  if (!to) {
    console.warn(
      `[convex-usage] CONVEX_USAGE_ALERT_EMAIL not set — dropping ${input.kind} alert for project ${input.projectId}`,
    );
    return true;
  }

  const lines = [
    `Project: ${input.projectName} (${input.projectId})`,
    `Owner: ${input.ownerUserId}`,
    `Deployment: ${input.deploymentName}`,
    `Calls today (UTC): ${input.callsToday.toLocaleString("en-US")}`,
    `Thresholds: warn ${input.warnThreshold.toLocaleString("en-US")} / pause ${input.pauseThreshold.toLocaleString("en-US")}`,
    ...(input.detail ? [`Detail: ${input.detail}`] : []),
  ];
  const html = `<pre style="font-family:ui-monospace,monospace;font-size:13px;">${lines
    .map(esc)
    .join("\n")}</pre>
<p>Admin unpause: <code>node scripts/admin-unpause-convex.mjs ${esc(input.projectId)}</code></p>`;

  // One in-tick retry: several alert kinds are one-shot (their dedup is a
  // persisted transition or a daily crossing), so a transient Resend blip
  // must not permanently eat them. A sustained outage still can — documented
  // residual in docs/features/convex-usage-guardrails.md.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2_000));
    const result = await sendEmail({
      to,
      subject: `${KIND_SUBJECT[input.kind]} — ${input.projectName}`,
      html,
      text: lines.join("\n"),
    });
    if (result.ok) return true;
    console.error(
      `[convex-usage] alert email failed (attempt ${attempt + 1}/2): ${result.error}`,
    );
  }
  return false;
}
