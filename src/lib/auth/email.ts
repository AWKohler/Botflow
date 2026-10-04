import { Resend } from "resend";
export async function sendAuthEmail(
  email: string,
  subject: string,
  text: string,
) {
  if (!process.env.RESEND_API_KEY)
    throw new Error("Authentication email delivery is not configured");
  const result = await new Resend(process.env.RESEND_API_KEY).emails.send({
    from: process.env.EMAIL_FROM || "Botflow <noreply@botflow.io>",
    to: email,
    subject,
    text,
  });
  if (result.error) throw new Error("Authentication email delivery failed");
}
