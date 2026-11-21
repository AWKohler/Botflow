import { captcha } from "better-auth/plugins";

/**
 * Every public route that emails an address the caller merely typed. Bots use
 * these to make Botflow send mail to strangers, so they all need the check:
 * gating only sign-up would move the same traffic to the OTP and reset routes.
 * Password sign-in sends nothing, so it stays frictionless.
 */
export const CAPTCHA_ENDPOINTS = [
  "/sign-up/email",
  "/send-verification-email",
  "/request-password-reset",
  "/email-otp/send-verification-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
];

/** Off without a secret, so local dev and previews need no Turnstile widget. */
export function captchaPlugin() {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  const plugin = captcha({
    provider: "cloudflare-turnstile",
    secretKey: secretKey ?? "",
    endpoints: CAPTCHA_ENDPOINTS,
  });
  return { ...plugin, onRequest: secretKey ? plugin.onRequest : undefined };
}
