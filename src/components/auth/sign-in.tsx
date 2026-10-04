"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Github, Eye, EyeOff } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { safeRedirect } from "@/lib/auth/policy";

export const fieldClass =
  "mt-2 w-full rounded-md border border-[var(--sand-border)] bg-[var(--color-elevated)] px-3 py-2 text-sm text-[var(--sand-text)] outline-none focus:ring-2 focus:ring-[var(--sand-text-muted)]";
export const primaryClass =
  "w-full rounded-md bg-[var(--sand-text)] px-4 py-2.5 text-sm font-medium text-[var(--sand-bg)] disabled:opacity-50";
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
        () => authClient.signUp.email({ email, password, name, callbackURL }),
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
    <div className="mx-auto w-full max-w-[372px] px-6 py-8 text-[var(--sand-text)]">
      <h1 className="text-center text-lg font-semibold tracking-tight">
        {title}
      </h1>
      <p className="mt-2 mb-6 text-center text-sm text-[var(--sand-text-muted)]">
        {["identifier", "credentials"].includes(step)
          ? signUp
            ? "Welcome! Please fill in the details to get started."
            : "Welcome back! Please sign in to continue"
          : "Enter the details below to continue."}
      </p>
      {(step === "identifier" || (signUp && step === "credentials")) && (
        <>
          <div className="flex flex-col gap-3">
            {(["github", "google"] as const).map((provider) => (
              <button
                key={provider}
                disabled={busy}
                className="flex items-center justify-center gap-2 rounded-md border border-[var(--sand-border)] bg-[var(--color-elevated)] py-1.5 text-sm font-medium disabled:opacity-50"
                onClick={() =>
                  perform(() =>
                    authClient.signIn.social({ provider, callbackURL }),
                  )
                }
              >
                {provider === "github" ? (
                  <Github size={16} />
                ) : (
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
                )}
                Continue with {provider === "google" ? "Google" : "GitHub"}
              </button>
            ))}
          </div>
          <div className="my-6 flex items-center gap-4 text-xs text-[var(--sand-text-muted)]">
            <span className="h-px flex-1 bg-[var(--sand-border)]" />
            or
            <span className="h-px flex-1 bg-[var(--sand-border)]" />
          </div>
        </>
      )}
      <form onSubmit={submit} className="space-y-4">
        {signUp && step === "credentials" && (
          <label className="block text-sm font-medium">
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
          <label className="block text-sm font-medium">
            Email address
            {!signUp && step === "identifier" ? " or username" : ""}
            <input
              placeholder={
                !signUp ? "Enter email or username" : "Enter your email address"
              }
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
          <label className="block text-sm font-medium">
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
          <label className="block text-sm font-medium">
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
                className="absolute right-3 top-3"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
          </label>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
        <button disabled={busy} className={primaryClass}>
          {busy ? "Please wait…" : "Continue"}
        </button>
      </form>
      {!signUp && step === "credentials" && (
        <div className="mt-4 flex justify-between text-xs">
          <button
            disabled={busy || !email}
            className="underline disabled:opacity-50"
            onClick={() =>
              perform(
                () =>
                  authClient.emailOtp.sendVerificationOtp({
                    email,
                    type: "sign-in",
                  }),
                () => setStep("code"),
              )
            }
          >
            Use a code instead
          </button>
          <button
            className="underline"
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
        <p className="mt-6 text-center text-sm text-[var(--sand-text-muted)]">
          {signUp ? "Already have an account?" : "Don’t have an account?"}{" "}
          <Link
            className="text-[var(--sand-text)] underline"
            href={`${signUp ? "/sign-in" : "/sign-up"}?redirect_url=${encodeURIComponent(callbackURL)}`}
          >
            {signUp ? "Sign in" : "Sign up"}
          </Link>
        </p>
      ) : (
        <button
          className="mt-5 w-full text-center text-sm underline"
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
