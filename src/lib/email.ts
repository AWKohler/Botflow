/**
 * Resend-backed email sender.
 *
 * Clerk does not send arbitrary emails — it only fires its own auth flows
 * (verification, magic links, etc). For anything we want to say to a user
 * — reaper warnings, restoration confirmations — we go through Resend.
 *
 * Clerk is still the source of truth for the user's email address; this module
 * just pulls it via `identityClient` when given a userId.
 */

import { Resend } from "resend";
import { identityClient } from "@/lib/auth/server";

const FROM_DEFAULT = process.env.EMAIL_FROM || "Botflow <noreply@botflow.io>";
const REPLY_TO_DEFAULT = process.env.EMAIL_REPLY_TO || "support@botflow.io";

let _resend: Resend | null = null;

function getResend(): Resend {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not configured");
  _resend = new Resend(key);
  return _resend;
}

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
};

export type SendEmailResult = {
  ok: boolean;
  id?: string;
  error?: string;
};

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  try {
    const resp = await getResend().emails.send({
      from: input.from || FROM_DEFAULT,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo || REPLY_TO_DEFAULT,
    });
    const respError = (resp as { error?: unknown }).error;
    if (respError) {
      return { ok: false, error: typeof respError === "string" ? respError : JSON.stringify(respError) };
    }
    return { ok: true, id: resp.data?.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Look up the primary email address for a Clerk user. Returns null if the
 * user has no addresses on file (rare — OAuth-only signups without an email
 * scope grant). The caller should fall back to an in-app banner in that case.
 */
export async function getEmailForClerkUser(userId: string): Promise<{ email: string; name: string | null } | null> {
  try {
    const client = await identityClient();
    const user = await client.users.getUser(userId);
    const primaryId = user.primaryEmailAddressId;
    const primary =
      user.emailAddresses.find((e) => e.id === primaryId) ?? user.emailAddresses[0];
    if (!primary?.emailAddress) return null;
    const name =
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
      user.username ||
      null;
    return { email: primary.emailAddress, name };
  } catch (e) {
    console.warn(`[email] failed to look up Clerk user ${userId}: ${e}`);
    return null;
  }
}
