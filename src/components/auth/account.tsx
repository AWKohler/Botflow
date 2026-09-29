"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { authClient } from "@/lib/auth/client";
import { ChangePlanModal } from "./change-plan";
import { PaymentMethodForm } from "./payment-method";
import { fieldClass, primaryClass } from "@/components/auth/sign-in";
interface Session {
  id: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  expiresAt: Date;
  createdAt: Date;
}
export function AccountPanel({
  embedded = false,
  initialTab = "profile",
}: {
  embedded?: boolean;
  initialTab?: string;
}) {
  const { data: session, isPending } = authClient.useSession();
  const [tab, setTab] = useState(initialTab);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [emailOtp, setEmailOtp] = useState("");
  const [emailChangePending, setEmailChangePending] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [accounts, setAccounts] = useState<
    { id: string; providerId: string; accountId: string }[]
  >([]);
  const [subscription, setSubscription] = useState<{
    plan: string;
    status: string;
    amount: number;
    interval: string;
    periodEnd: string;
    cancelAtPeriodEnd: boolean;
    migrationPending: boolean;
  } | null>(null);
  const [billingDetails, setBillingDetails] = useState<{
    upcomingPlan?: {
      plan: string;
      interval: string;
      amount: number;
      effectiveAt: number;
    } | null;
    invoices: {
      id: string;
      number: string;
      created: number;
      amount: number;
      url: string;
      status: string;
    }[];
    paymentMethods: {
      id: string;
      brand: string;
      last4: string;
      expiryMonth: number;
      expiryYear: number;
      isDefault: boolean;
    }[];
  }>({ invoices: [], paymentMethods: [] });
  const [username, setUsername] = useState("");
  const [deleteToken, setDeleteToken] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  useEffect(() => {
    const token = new URLSearchParams(location.search).get("delete_token");
    if (token) {
      setDeleteToken(token);
      setTab("security");
      history.replaceState(null, "", "/account?tab=security");
    }
  }, []);
  const [changingPlan, setChangingPlan] = useState(false);
  const [paymentSecret, setPaymentSecret] = useState("");
  function refreshBilling() {
    fetch("/api/billing/manage")
      .then((r) => r.json())
      .then((data) => {
        if (data.invoices) setBillingDetails(data);
      })
      .catch(() => {});
  }
  useEffect(() => {
    if (session && tab === "billing") refreshBilling();
  }, [session, tab]);
  async function billingAction(action: string, paymentMethodId?: string) {
    await act(async () => {
      const response = await fetch("/api/billing/manage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, paymentMethodId }),
      });
      const data = await response.json();
      if (!response.ok) return { error: { message: data.error } };
      if (data.clientSecret) setPaymentSecret(data.clientSecret);
      else refreshBilling();
      if (typeof data.cancelAtPeriodEnd === "boolean")
        setSubscription((prev) =>
          prev ? { ...prev, cancelAtPeriodEnd: data.cancelAtPeriodEnd } : null,
        );
      return {};
    });
  }
  useEffect(() => {
    if (new URLSearchParams(location.search).get("tab") === "billing")
      setTab("billing");
  }, []);
  useEffect(() => {
    if (!session) return;
    setName(session.user.name);
    setUsername(session.user.username ?? "");
    authClient.listSessions().then((r) => {
      if (r.data) setSessions(r.data as Session[]);
    });
    authClient.listAccounts().then((r) => {
      if (r.data) setAccounts(r.data);
    });
    fetch("/api/billing/status")
      .then((r) => r.json())
      .then((r) => setSubscription(r.subscription))
      .catch(() => {});
  }, [session]);
  async function act(
    fn: () => Promise<{ error?: { message?: string } | null }>,
    success = "Saved",
  ) {
    setBusy(true);
    setMessage("");
    try {
      const r = await fn();
      setMessage(r.error?.message ?? success);
    } catch {
      setMessage("Unable to complete this action. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  if (isPending)
    return <main className="p-12 text-center">Loading your account…</main>;
  if (!session)
    return (
      <main className="p-12 text-center">
        <Link href="/sign-in?redirect_url=%2Faccount">
          Sign in to manage your account
        </Link>
      </main>
    );
  return (
    <main
      className={`${embedded ? "" : "min-h-screen p-6"} bg-[var(--color-surface)] text-[var(--sand-text)]`}
    >
      <div className="mx-auto max-w-4xl">
        {changingPlan && (
          <ChangePlanModal
            currentPlan={subscription?.plan ?? "free"}
            currentInterval={subscription?.interval ?? "month"}
            onClose={() => setChangingPlan(false)}
            onSaved={() => {
              setMessage("Your plan change has been saved.");
              setChangingPlan(false);
              refreshBilling();
              fetch("/api/billing/status")
                .then((r) => r.json())
                .then((r) => setSubscription(r.subscription));
            }}
          />
        )}
        {!embedded && (
          <Link
            href="/projects"
            className="text-sm text-[var(--sand-text-muted)]"
          >
            ← Back to Botflow
          </Link>
        )}
        <div
          className={`${embedded ? "" : "mt-8"} grid overflow-hidden rounded-xl border border-[var(--sand-border)] md:grid-cols-[200px_1fr]`}
        >
          <aside className="bg-[var(--sand-elevated)] p-6">
            <h1 className="text-xl font-semibold">Account</h1>
            <p className="mt-1 text-xs text-[var(--sand-text-muted)]">
              Manage your account info.
            </p>
            <nav className="mt-6 flex flex-col gap-1">
              {["profile", "security", "billing"].map((t) => (
                <button
                  key={t}
                  className={`rounded-md px-3 py-2 text-left text-sm capitalize ${tab === t ? "bg-[var(--color-surface)] font-medium" : ""}`}
                  onClick={() => {
                    setTab(t);
                    setMessage("");
                  }}
                >
                  {t}
                </button>
              ))}
            </nav>
          </aside>
          <section className="space-y-6 p-8">
            <h2 className="text-xl font-semibold capitalize">
              {tab === "profile" ? "Profile details" : tab}
            </h2>
            {message && (
              <p
                role="status"
                className="rounded-md bg-[var(--sand-elevated)] p-3 text-sm"
              >
                {message}
              </p>
            )}
            {tab === "profile" && (
              <>
                <div className="flex items-center gap-4">
                  {session.user.image && (
                    <Image
                      unoptimized
                      width={56}
                      height={56}
                      src={session.user.image}
                      alt="Profile"
                      className="h-14 w-14 rounded-full object-cover"
                    />
                  )}
                  <label className="cursor-pointer text-sm underline">
                    Update profile image
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      disabled={busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        act(async () => {
                          const form = new FormData();
                          form.append("image", file);
                          const r = await fetch("/api/identity/avatar", {
                            method: "POST",
                            body: form,
                          });
                          const data = await r.json();
                          if (!r.ok) return { error: { message: data.error } };
                          await authClient.getSession({
                            query: { disableCookieCache: true },
                          });
                          location.reload();
                          return {};
                        });
                      }}
                    />
                  </label>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(() =>
                      authClient.updateUser({
                        name,
                        ...(username ? { username } : {}),
                      }),
                    );
                  }}
                  className="space-y-3"
                >
                  <label className="block text-sm">
                    Full name
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      className={fieldClass}
                    />
                  </label>
                  <label className="block text-sm">
                    Username
                    <input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      minLength={3}
                      maxLength={30}
                      autoComplete="username"
                      className={fieldClass}
                    />
                  </label>
                  <button disabled={busy} className={primaryClass}>
                    Save profile
                  </button>
                </form>
                <div className="border-t border-[var(--sand-border)] pt-6">
                  <h3 className="font-medium">Email address</h3>
                  <p className="mt-2 text-sm">
                    {session.user.email}{" "}
                    {session.user.emailVerified ? "· Verified" : "· Unverified"}
                  </p>
                  <form
                    className="mt-4 space-y-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      act(
                        async () => {
                          const result = emailChangePending
                            ? await authClient.emailOtp.changeEmail({
                                newEmail: email,
                                otp: emailOtp,
                              })
                            : await authClient.emailOtp.requestEmailChange({
                                newEmail: email,
                              });
                          if (!result.error)
                            setEmailChangePending(!emailChangePending);
                          return result;
                        },
                        emailChangePending
                          ? "Email updated."
                          : "Check your new email for a verification code.",
                      );
                    }}
                  >
                    <label className="block text-sm">
                      New email address
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className={fieldClass}
                      />
                    </label>
                    <>
                      {emailChangePending && (
                        <label className="block text-sm">
                          Verification code
                          <input
                            required
                            value={emailOtp}
                            onChange={(e) => setEmailOtp(e.target.value)}
                            autoComplete="one-time-code"
                            className={fieldClass}
                          />
                        </label>
                      )}
                      <button disabled={busy} className={primaryClass}>
                        {emailChangePending
                          ? "Verify new email"
                          : "Change email"}
                      </button>
                    </>
                  </form>
                </div>
                <div className="border-t border-[var(--sand-border)] pt-6">
                  <h3 className="font-medium">Connected accounts</h3>
                  {accounts
                    .filter((a) => a.providerId !== "credential")
                    .map((a) => (
                      <div
                        key={a.id}
                        className="mt-3 flex items-center justify-between text-sm"
                      >
                        <span className="capitalize">{a.providerId}</span>
                        <button
                          className="underline"
                          disabled={busy}
                          onClick={() =>
                            act(() =>
                              authClient.unlinkAccount({ accountId: a.id }),
                            )
                          }
                        >
                          Disconnect
                        </button>
                      </div>
                    ))}
                  <div className="mt-4 flex gap-4">
                    {(["google", "github"] as const)
                      .filter((p) => !accounts.some((a) => a.providerId === p))
                      .map((provider) => (
                        <button
                          key={provider}
                          className="text-sm underline"
                          onClick={() =>
                            act(() =>
                              authClient.linkSocial({
                                provider,
                                callbackURL: "/account",
                              }),
                            )
                          }
                        >
                          Connect {provider === "google" ? "Google" : "GitHub"}
                        </button>
                      ))}
                  </div>
                </div>
              </>
            )}
            {tab === "security" && (
              <>
                {deleteToken && (
                  <div className="rounded-lg border border-red-500/40 p-4">
                    <h3 className="font-medium">Confirm account deletion</h3>
                    <p className="mt-2 text-sm">
                      Your login, profile, and stored integration secrets will
                      be permanently removed. Your subscriptions will be
                      canceled and your projects will no longer be accessible
                      through this account.
                    </p>
                    <label className="mt-3 block text-sm">
                      Type DELETE to confirm
                      <input
                        value={deleteConfirmation}
                        onChange={(e) => setDeleteConfirmation(e.target.value)}
                        className={fieldClass}
                      />
                    </label>
                    <button
                      disabled={busy || deleteConfirmation !== "DELETE"}
                      className="mt-3 rounded-md bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-50"
                      onClick={() =>
                        act(async () => {
                          const result = await authClient.deleteUser({
                            token: deleteToken,
                          });
                          if (!result.error) location.assign("/");
                          return result;
                        })
                      }
                    >
                      Permanently delete account
                    </button>
                  </div>
                )}
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(
                      () =>
                        authClient.changePassword({
                          currentPassword,
                          newPassword,
                          revokeOtherSessions: true,
                        }),
                      "Password updated. Other sessions have been signed out.",
                    );
                  }}
                >
                  <h3 className="font-medium">Password</h3>
                  <label className="block text-sm">
                    Current password
                    <input
                      type="password"
                      autoComplete="current-password"
                      required
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      className={fieldClass}
                    />
                  </label>
                  <label className="block text-sm">
                    New password
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      required
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className={fieldClass}
                    />
                  </label>
                  <button disabled={busy} className={primaryClass}>
                    Update password
                  </button>
                  <button
                    type="button"
                    className="text-sm underline"
                    onClick={() =>
                      act(
                        () =>
                          authClient.requestPasswordReset({
                            email: session.user.email,
                            redirectTo: "/sign-in",
                          }),
                        "A password reset email has been sent.",
                      )
                    }
                  >
                    Reset or set a password by email
                  </button>
                </form>
                <div className="border-t border-[var(--sand-border)] pt-6">
                  <h3 className="font-medium">Active devices</h3>
                  {sessions.map((s) => (
                    <div
                      key={s.id}
                      className="mt-4 border-b border-[var(--sand-border)] pb-4"
                    >
                      <p className="text-sm">
                        {s.userAgent || "Unknown browser"}{" "}
                        {s.id === session.session.id ? "· This device" : ""}
                      </p>
                      <p className="mt-1 text-xs text-[var(--sand-text-muted)]">
                        {s.ipAddress} · Expires{" "}
                        {new Date(s.expiresAt).toLocaleString()}
                      </p>
                      {s.id !== session.session.id && (
                        <button
                          disabled={busy}
                          className="mt-2 text-sm underline"
                          onClick={() =>
                            act(async () => {
                              const r = await authClient.revokeSession({
                                token: s.token,
                              });
                              if (!r.error)
                                setSessions(
                                  sessions.filter((x) => x.id !== s.id),
                                );
                              return r;
                            })
                          }
                        >
                          Sign out this device
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    disabled={busy}
                    className="mt-4 text-sm underline"
                    onClick={() =>
                      act(
                        () => authClient.revokeOtherSessions(),
                        "Other devices signed out",
                      )
                    }
                  >
                    Sign out all other devices
                  </button>
                </div>
                <section className="border-t border-[var(--sand-border)] pt-6">
                  <h3 className="font-medium">Delete account</h3>
                  <p className="mt-2 text-sm text-[var(--sand-text-muted)]">
                    Permanently remove your account and stored integration
                    secrets. You will confirm by email before anything is
                    deleted.
                  </p>
                  <button
                    disabled={busy}
                    className="mt-3 text-sm text-red-500 underline"
                    onClick={() =>
                      act(
                        () => authClient.deleteUser({ callbackURL: "/" }),
                        "Check your email to confirm account deletion.",
                      )
                    }
                  >
                    Delete account
                  </button>
                </section>
              </>
            )}
            {tab === "billing" && (
              <>
                <div className="rounded-lg border border-[var(--sand-border)] p-5">
                  <h3 className="text-lg font-medium capitalize">
                    {subscription?.plan ?? "free"} plan
                  </h3>
                  {subscription && subscription.amount > 0 ? (
                    <>
                      <p className="mt-2">
                        ${subscription.amount / 100} / {subscription.interval}
                      </p>
                      <p className="mt-2 text-sm text-[var(--sand-text-muted)]">
                        {subscription.cancelAtPeriodEnd
                          ? "Access ends"
                          : "Renews"}{" "}
                        {new Date(subscription.periodEnd).toLocaleDateString()}
                      </p>
                    </>
                  ) : (
                    <p className="mt-2 text-sm text-[var(--sand-text-muted)]">
                      No recurring charge
                    </p>
                  )}
                </div>
                {billingDetails.upcomingPlan && (
                  <p className="rounded-lg border border-[var(--sand-border)] p-4 text-sm">
                    Scheduled:{" "}
                    <span className="capitalize">
                      {billingDetails.upcomingPlan.plan}
                    </span>{" "}
                    at ${billingDetails.upcomingPlan.amount / 100}/
                    {billingDetails.upcomingPlan.interval}, starting{" "}
                    {new Date(
                      billingDetails.upcomingPlan.effectiveAt * 1000,
                    ).toLocaleDateString()}
                    .{" "}
                    <button
                      className="underline"
                      disabled={busy}
                      onClick={() => billingAction("cancel-plan-change")}
                    >
                      Keep current plan
                    </button>
                  </p>
                )}
                {subscription?.migrationPending ? (
                  <p className="text-sm">
                    Your existing subscription is being migrated. Your current
                    price and access are preserved.
                  </p>
                ) : (
                  <div className="space-y-6">
                    <div className="flex gap-4 text-sm">
                      <button
                        disabled={busy}
                        onClick={
                          subscription?.amount
                            ? () => setChangingPlan(true)
                            : () => location.assign("/pricing")
                        }
                        className="underline"
                      >
                        Change plan
                      </button>
                      {subscription && subscription.amount > 0 && (
                        <button
                          disabled={busy}
                          className="underline"
                          onClick={() =>
                            billingAction(
                              subscription.cancelAtPeriodEnd
                                ? "resume"
                                : "cancel",
                            )
                          }
                        >
                          {subscription.cancelAtPeriodEnd
                            ? "Resume subscription"
                            : "Cancel at end of billing period"}
                        </button>
                      )}
                    </div>
                    <section className="border-t border-[var(--sand-border)] pt-5">
                      <h3 className="font-medium">Payment methods</h3>
                      {billingDetails.paymentMethods.map((card) => (
                        <div key={card.id} className="mt-3 text-sm">
                          <p className="capitalize">
                            {card.brand} •••• {card.last4} · {card.expiryMonth}/
                            {card.expiryYear}{" "}
                            {card.isDefault ? "· Default" : ""}
                          </p>
                          <div className="mt-2 flex gap-4 text-xs">
                            {!card.isDefault && (
                              <button
                                disabled={busy}
                                className="underline"
                                onClick={() =>
                                  billingAction("set-default-payment", card.id)
                                }
                              >
                                Make default
                              </button>
                            )}
                            <button
                              disabled={busy}
                              className="underline"
                              onClick={() =>
                                billingAction("remove-payment", card.id)
                              }
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                      {paymentSecret ? (
                        <div className="mt-4">
                          <PaymentMethodForm
                            clientSecret={paymentSecret}
                            onSaved={() => {
                              setPaymentSecret("");
                              refreshBilling();
                              setMessage("Payment method saved.");
                            }}
                          />
                        </div>
                      ) : (
                        <button
                          className="mt-4 text-sm underline"
                          disabled={busy}
                          onClick={() => billingAction("setup-payment")}
                        >
                          Add payment method
                        </button>
                      )}
                    </section>
                    <section className="border-t border-[var(--sand-border)] pt-5">
                      <h3 className="font-medium">Billing history</h3>
                      {billingDetails.invoices.map((invoice) => (
                        <div
                          key={invoice.id}
                          className="mt-3 flex justify-between gap-3 text-sm"
                        >
                          <span>
                            {new Date(
                              invoice.created * 1000,
                            ).toLocaleDateString()}{" "}
                            · ${invoice.amount / 100} · {invoice.status}
                          </span>
                          <a
                            href={invoice.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline"
                          >
                            Invoice
                          </a>
                        </div>
                      ))}
                      {!billingDetails.invoices.length && (
                        <p className="mt-3 text-sm text-[var(--sand-text-muted)]">
                          No invoices yet
                        </p>
                      )}
                    </section>
                  </div>
                )}
                <Link
                  href="/pricing"
                  className="block text-center text-sm underline"
                >
                  Compare plans
                </Link>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
