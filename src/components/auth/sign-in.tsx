"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { safeRedirect } from "@/lib/auth/policy";
import { buttonClass } from "@/components/ui/button";
import { fieldClass as baseFieldClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { useCaptcha } from "./captcha";

// Auth forms wrap each input in its <label>, so the control carries the gap.
export const fieldClass = cn(baseFieldClass, "mt-1.5 h-10 font-normal");
export const primaryClass = buttonClass({ variant: "primary", className: "h-10 w-full" });
const socialClass = buttonClass({ variant: "secondary", className: "h-10 w-full gap-2" });
const linkClass =
  "rounded-sm font-medium text-fg underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-fg disabled:opacity-50";
export function AuthForm({
  signUp = false,
  redirectUrl,
}: {
  signUp?: boolean;
  redirectUrl?: string;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<
    | "identifier"
    | "credentials"
    | "verify"
    | "code"
    | "reset"
    | "reset-code"
    | "reset-token"
  >(signUp ? "credentials" : "identifier");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetToken, setResetToken] = useState("");
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (query.get("error")) setMessage("Sign-in could not be completed. Please try again or choose another method.");
    const token = query.get("token");
    if (token) {
      setResetToken(token);
      setStep("reset-token");
    }
  }, []);
  const callbackURL = safeRedirect(redirectUrl);
  // Password sign-in isn't gated, but its step offers "Use a code instead".
  const captcha = useCaptcha(step === "credentials" || step === "reset");
  const awaitingCaptcha =
    !captcha.ready && ((signUp && step === "credentials") || step === "reset");
  async function perform(
    fn: () => Promise<{ error?: { message?: string } | null }>,
    success?: () => void,
  ) {
    setBusy(true);
    setMessage("");
    try {
      const result = await fn();
      if (result.error)
        setMessage(
          result.error.message ?? "Unable to continue. Please try again.",
        );
      else success?.();
    } catch {
      setMessage("Unable to connect. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (step === "reset-token")
      return perform(
        () =>
          authClient.resetPassword({
            newPassword: password,
            token: resetToken,
          }),
        () => {
          history.replaceState(null, "", "/sign-in");
          setResetToken("");
          setStep("identifier");
          setPassword("");
          setMessage("Password reset. You can now sign in.");
        },
      );
    if (step === "identifier") {
      setStep("credentials");
      return;
    }
    if (step === "verify")
      return perform(
        async () => {
          const verified = await authClient.emailOtp.verifyEmail({
            email,
            otp,
          });
          if (verified.error) return verified;
          return authClient.signIn.email({ email, password, callbackURL });
        },
        () => location.assign(callbackURL),
      );
    if (step === "code")
      return perform(
        () => authClient.signIn.emailOtp({ email, otp }),
        () => location.assign(callbackURL),
      );
    if (step === "reset")
      return perform(
        () =>
          authClient.emailOtp.sendVerificationOtp({
            email,
            type: "forget-password",
            fetchOptions: captcha.take(),
          }),
        () => setStep("reset-code"),
      );
    if (step === "reset-code")
      return perform(
        () => authClient.emailOtp.resetPassword({ email, otp, password }),
        () => {
          setStep("credentials");
          setPassword("");
          setMessage("Password reset. Sign in with your new password.");
        },
      );
    if (signUp)
      return perform(
        () =>
          authClient.signUp.email({
            email,
            password,
            name,
            callbackURL,
            fetchOptions: captcha.take(),
          }),
        () => setStep("verify"),
      );
    return perform(
      () =>
        email.includes("@")
          ? authClient.signIn.email({ email, password, callbackURL })
          : authClient.signIn.username({ username: email, password }),
      () => location.assign(callbackURL),
    );
  }
  const title =
    step === "verify"
      ? "Verify your email"
      : step === "code"
        ? "Check your email"
        : step.startsWith("reset")
          ? "Reset your password"
          : signUp
            ? "Create your account"
            : "Sign in to Botflow";
  return (
    <div className="mx-auto w-full max-w-[380px] px-6 py-8 text-fg">
      <h1 className="text-center text-2xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="mb-7 mt-2 text-center text-sm text-muted">
        {["identifier", "credentials"].includes(step)
          ? signUp
            ? "Start building in a couple of minutes."
            : "Welcome back. Sign in to continue."
          : "Enter the details below to continue."}
      </p>
      {(step === "identifier" || (signUp && step === "credentials")) && (
        <>
          <div className="flex flex-col gap-2.5">
            {(["github", "google"] as const).map((provider) => (
              <button
                key={provider}
                disabled={busy}
                type="button"
                className={socialClass}
                onClick={() =>
                  perform(() =>
                    authClient.signIn.social({ provider, callbackURL }),
                  )
                }
              >
                <ProviderLogo provider={provider} />
                Continue with {provider === "google" ? "Google" : "GitHub"}
              </button>
            ))}
          </div>
          <div className="my-6 flex items-center gap-3 text-xs text-subtle">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
        </>
      )}
      <form onSubmit={submit} className="space-y-4">
        {signUp && step === "credentials" && (
          <label className="block text-[13px] font-medium">
            Full name
            <input
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={fieldClass}
            />
          </label>
        )}
        {step !== "reset-token" && (
          <label className="block text-[13px] font-medium">
            Email address
            {!signUp && step === "identifier" ? " or username" : ""}
            <input
              type={signUp || step.startsWith("reset") ? "email" : "text"}
              autoComplete="username"
              required
              value={email}
              readOnly={["verify", "code", "reset-code"].includes(step)}
              onChange={(e) => setEmail(e.target.value)}
              className={fieldClass}
            />
          </label>
        )}
        {["verify", "code", "reset-code"].includes(step) && (
          <label className="block text-[13px] font-medium">
            Verification code
            <input
              autoComplete="one-time-code"
              inputMode="numeric"
              required
              minLength={6}
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              className={fieldClass}
            />
          </label>
        )}
        {(step === "credentials" ||
          step === "reset-code" ||
          step === "reset-token") && (
          <label className="block text-[13px] font-medium">
            {step.startsWith("reset-") ? "New password" : "Password"}
            <span className="relative block">
              <input
                type={showPassword ? "text" : "password"}
                required
                minLength={signUp || step.startsWith("reset-") ? 8 : 1}
                maxLength={128}
                autoComplete={
                  signUp || step.startsWith("reset-")
                    ? "new-password"
                    : "current-password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${fieldClass} pr-10`}
              />
              <button
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute bottom-0 right-1 flex h-10 w-9 items-center justify-center rounded-md text-muted transition-colors hover:text-fg"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
          </label>
        )}
        {captcha.widget}
        {message && (
          <p
            role="status"
            className="rounded-lg border border-border bg-elevated px-3 py-2.5 text-[13px] leading-relaxed text-fg"
          >
            {message}
          </p>
        )}
        <button type="submit" disabled={busy || awaitingCaptcha} className={primaryClass}>
          {busy
            ? "Please wait…"
            : awaitingCaptcha && !captcha.failed
              ? "Verifying you’re human…"
              : "Continue"}
        </button>
      </form>
      {!signUp && step === "credentials" && (
        <div className="mt-4 flex justify-between text-[13px]">
          <button
            type="button"
            disabled={busy || !email || !captcha.ready}
            className={linkClass}
            onClick={() =>
              perform(
                () =>
                  authClient.emailOtp.sendVerificationOtp({
                    email,
                    type: "sign-in",
                    fetchOptions: captcha.take(),
                  }),
                () => setStep("code"),
              )
            }
          >
            Use a code instead
          </button>
          <button
            type="button"
            className={linkClass}
            onClick={() => {
              setStep("reset");
              setMessage("");
            }}
          >
            Forgot password?
          </button>
        </div>
      )}
      {["identifier", "credentials"].includes(step) ? (
        <p className="mt-7 text-center text-sm text-muted">
          {signUp ? "Already have an account?" : "Don’t have an account?"}{" "}
          <Link
            className={linkClass}
            href={`${signUp ? "/sign-in" : "/sign-up"}?redirect_url=${encodeURIComponent(callbackURL)}`}
          >
            {signUp ? "Sign in" : "Sign up"}
          </Link>
        </p>
      ) : (
        <button
          type="button"
          className={cn(linkClass, "mx-auto mt-6 block text-sm")}
          onClick={() => {
            setStep("credentials");
            setMessage("");
          }}
        >
          Back to sign in
        </button>
      )}
    </div>
  );
}

/** The provider's mark, shared by the sign-in buttons and Settings → Security. */
export function ProviderLogo({ provider }: { provider: string }) {
  if (provider === "github")
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
    );
  if (provider !== "google") return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.52h3.24c1.89-1.74 2.98-4.3 2.98-7.37Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.89 6.62-2.4l-3.24-2.52c-.89.6-2.03.96-3.38.96-2.6 0-4.81-1.76-5.6-4.13H3.06v2.6A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.4 13.91a6 6 0 0 1 0-3.82v-2.6H3.06a10 10 0 0 0 0 9.02l3.34-2.6Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.96c1.47 0 2.79.51 3.83 1.51l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.94 5.49l3.34 2.6A6 6 0 0 1 12 5.96Z"
      />
    </svg>
  );
}
