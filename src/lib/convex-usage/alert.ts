/**
 * Operator alerts for the Convex usage guardrails. These go to the platform
 * operator (CONVEX_USAGE_ALERT_EMAIL), NOT to end users — user-facing emails
 * are Phase 2 (see docs/features/convex-usage-guardrails.md).
 */

import { sendEmail } from "@/lib/email";

export type UsageAlertKind = "warn" | "pause" | "would_pause";

export type UsageAlertInput = {
  kind: UsageAlertKind;
  projectId: string;
  projectName: string;
  ownerUserId: string;
  deploymentName: string;
  callsToday: number;
  warnThreshold: number;
  pauseThreshold: number;
};

const KIND_SUBJECT: Record<UsageAlertKind, string> = {
  warn: "⚠️ Convex usage warning",
  pause: "⛔ Convex deployment PAUSED",
  would_pause: "⛔ Convex deployment over pause threshold (auto-pause OFF)",
};

export async function sendUsageAlert(input: UsageAlertInput): Promise<void> {
  const to = process.env.CONVEX_USAGE_ALERT_EMAIL;
  if (!to) {
    console.warn(
      `[convex-usage] CONVEX_USAGE_ALERT_EMAIL not set — dropping ${input.kind} alert for project ${input.projectId}`,
    );
    return;
  }

  const lines = [
    `Project: ${input.projectName} (${input.projectId})`,
    `Owner: ${input.ownerUserId}`,
    `Deployment: ${input.deploymentName}`,
    `Calls today (UTC): ${input.callsToday.toLocaleString("en-US")}`,
    `Thresholds: warn ${input.warnThreshold.toLocaleString("en-US")} / pause ${input.pauseThreshold.toLocaleString("en-US")}`,
  ];
  const html = `<pre style="font-family:ui-monospace,monospace;font-size:13px;">${lines
    .map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;"))
    .join("\n")}</pre>
<p>Admin unpause: <code>node scripts/admin-unpause-convex.mjs ${input.projectId}</code></p>`;

  const result = await sendEmail({
    to,
    subject: `${KIND_SUBJECT[input.kind]} — ${input.projectName}`,
    html,
    text: lines.join("\n"),
  });
  if (!result.ok) {
    console.error(`[convex-usage] alert email failed: ${result.error}`);
  }
}
