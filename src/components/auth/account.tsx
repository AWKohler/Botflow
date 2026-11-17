"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { authClient } from "@/lib/auth/client";
import { ChangePlanModal } from "./change-plan";
import { PaymentMethodForm } from "./payment-method";
import { CreditCard, ExternalLink, ShieldCheck, UserRound } from "lucide-react";
import { AppShell } from "@/components/site/AppShell";
import { Badge, Notice } from "@/components/ui/badge";
import { Button, buttonClass } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Field, TextInput } from "@/components/ui/field";
import { cn } from "@/lib/utils";
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
  const [emailAddresses, setEmailAddresses] = useState<
    { email: string; verified: boolean; primary: boolean }[]
  >([]);
  function refreshEmails() {
    fetch("/api/identity/emails")
      .then((response) => response.json())
      .then((data) => {
        if (data.emails) setEmailAddresses(data.emails);
      })
      .catch(() => {});
  }
  async function emailAction(action: string, address: string, code?: string) {
    const response = await fetch("/api/identity/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, email: address, otp: code }),
    });
    const data = await response.json();
    if (!response.ok) return { error: { message: data.error } };
    refreshEmails();
    if (action === "primary")
      await authClient.getSession({ query: { disableCookieCache: true } });
    return {};
  }
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
      kind?: "invoice" | "receipt";
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
    const query = new URLSearchParams(location.search);
    if (query.get("error"))
      setMessage(
        "That account could not be connected. It may already belong to another Botflow user.",
      );
    const token = query.get("delete_token");
    if (token) {
      setDeleteToken(token);
      setTab("security");
      history.replaceState(null, "", "/account?tab=security");
    }
  }, []);
  const [changingPlan, setChangingPlan] = useState(false);
  const [paymentSecret, setPaymentSecret] = useState("");
  const [pendingPlan, setPendingPlan] = useState<{
    plan: string;
    interval: string;
  } | null>(null);
  useEffect(() => {
    if (!pendingPlan) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    async function reconcile() {
      try {
        const response = await fetch("/api/billing/status");
        if (!response.ok) throw new Error("Billing status unavailable");
        const data = await response.json();
        if (stopped) return;
        if (data.subscription) setSubscription(data.subscription);
        if (
          data.subscription?.plan === pendingPlan!.plan &&
          data.subscription?.interval === pendingPlan!.interval
        ) {
          setPendingPlan(null);
          setMessage("Your new plan is active.");
          refreshBilling();
          return;
        }
      } catch {
        // Stripe webhooks may arrive after the payment confirmation.
      }
      if (stopped) return;
      if (++attempts < 15) timer = setTimeout(reconcile, 2000);
      else {
        setPendingPlan(null);
        setMessage(
          "Your payment was submitted. Refresh this page shortly to see the updated plan.",
        );
      }
    }
    void reconcile();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pendingPlan]);
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
    refreshEmails();
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
    return (
      <Frame embedded={embedded}>
        <p className="py-16 text-center text-sm text-muted">Loading your account…</p>
      </Frame>
    );
  if (!session)
    return (
      <Frame embedded={embedded}>
        <div className="py-16 text-center">
          <Link href="/sign-in?redirect_url=%2Faccount" className={buttonClass({ variant: "primary" })}>
            Sign in to manage your account
          </Link>
        </div>
      </Frame>
    );

  const tabs = [
    { id: "profile", label: "Profile", icon: UserRound },
    { id: "security", label: "Security", icon: ShieldCheck },
    { id: "billing", label: "Billing", icon: CreditCard },
  ] as const;
  const socialAccounts = accounts.filter((a) => a.providerId !== "credential");
  const initial = (session.user.name?.[0] ?? session.user.email?.[0] ?? "U").toUpperCase();

  return (
    <Frame embedded={embedded}>
      {changingPlan && (
        <ChangePlanModal
          currentPlan={subscription?.plan ?? "free"}
          currentInterval={subscription?.interval ?? "month"}
          onClose={() => setChangingPlan(false)}
          onSaved={(change) => {
            setMessage(
              change.scheduled
                ? "Your plan change has been scheduled."
                : "Your payment was submitted. Updating your plan…",
            );
            setChangingPlan(false);
            refreshBilling();
            if (!change.scheduled) setPendingPlan(change);
          }}
        />
      )}

      <div className={cn("grid gap-8 md:grid-cols-[200px_minmax(0,760px)] md:gap-12", embedded && "p-6 sm:p-8")}>
        <aside>
          <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
          <p className="mt-1.5 text-sm text-muted">Your profile, sign-in and billing.</p>
          <nav aria-label="Account sections" className="mt-6 flex gap-1 md:flex-col">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={tab === t.id ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
                  tab === t.id ? "bg-elevated text-fg" : "text-muted hover:bg-elevated/60 hover:text-fg",
                )}
                onClick={() => {
                  setTab(t.id);
                  setMessage("");
                }}
              >
                <t.icon className="h-4 w-4" strokeWidth={1.75} />
                {t.label}
              </button>
            ))}
          </nav>
        </aside>

        <section className="min-w-0 space-y-6">
          {message && (
            <Notice role="status" className="text-fg">
              {message}
            </Notice>
          )}

          {tab === "profile" && (
            <>
              <Card className="p-6">
                <SectionHeader title="Profile" description="How you appear across Botflow." />
                <div className="mt-5 flex items-center gap-4">
                  {session.user.image ? (
                    <Image
                      unoptimized
                      width={56}
                      height={56}
                      src={session.user.image}
                      alt="Profile"
                      className="h-14 w-14 rounded-full border border-border object-cover"
                    />
                  ) : (
                    <div className="flex h-14 w-14 items-center justify-center rounded-full border border-border bg-elevated text-lg font-medium text-muted">
                      {initial}
                    </div>
                  )}
                  <label className={buttonClass({ variant: "secondary", size: "sm", className: "cursor-pointer" })}>
                    Change photo
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
                  className="mt-6"
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Full name" htmlFor="account-name">
                      <TextInput
                        id="account-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        autoComplete="name"
                      />
                    </Field>
                    <Field label="Username" htmlFor="account-username">
                      <TextInput
                        id="account-username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        minLength={3}
                        maxLength={30}
                        autoComplete="username"
                        placeholder="Optional"
                      />
                    </Field>
                  </div>
                  <div className="mt-5 flex justify-end">
                    <Button type="submit" variant="primary" disabled={busy}>
                      Save changes
                    </Button>
                  </div>
                </form>
              </Card>

              <Card className="p-6">
                <SectionHeader title="Email addresses" description="Use any verified address to sign in." />
                <ul className="mt-4 divide-y divide-border">
                  {emailAddresses.map((address) => (
                    <li key={address.email} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                        <span className="truncate">{address.email}</span>
                        {address.primary && <Badge tone="accent">Primary</Badge>}
                        <Badge tone={address.verified ? "success" : "warning"}>
                          {address.verified ? "Verified" : "Unverified"}
                        </Badge>
                      </span>
                      {!address.primary && (
                        <span className="flex gap-1">
                          {address.verified && (
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={busy}
                              onClick={() =>
                                act(
                                  () => emailAction("primary", address.email),
                                  "Primary email updated.",
                                )
                              }
                            >
                              Make primary
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            onClick={() =>
                              act(
                                () => emailAction("remove", address.email),
                                "Email removed.",
                              )
                            }
                          >
                            Remove
                          </Button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <form
                  className="mt-2 border-t border-border pt-5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(
                      async () => {
                        const result = await emailAction(
                          emailChangePending ? "verify" : "request",
                          email,
                          emailChangePending ? emailOtp : undefined,
                        );
                        if (!result.error) {
                          setEmailChangePending(!emailChangePending);
                          if (emailChangePending) {
                            setEmail("");
                            setEmailOtp("");
                          }
                        }
                        return result;
                      },
                      emailChangePending
                        ? "Email verified. You can now make it primary or use it to sign in."
                        : "Check your email for a verification code.",
                    );
                  }}
                >
                  <div className="flex flex-wrap items-end gap-3">
                    <Field label="Add an email address" htmlFor="account-email" className="min-w-[220px] flex-1">
                      <TextInput
                        id="account-email"
                        type="email"
                        required
                        value={email}
                        readOnly={emailChangePending}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                      />
                    </Field>
                    {emailChangePending && (
                      <Field label="Verification code" htmlFor="account-email-otp" className="w-40">
                        <TextInput
                          id="account-email-otp"
                          required
                          value={emailOtp}
                          onChange={(e) => setEmailOtp(e.target.value)}
                          autoComplete="one-time-code"
                          inputMode="numeric"
                          pattern="[0-9]{6}"
                          placeholder="6 digits"
                        />
                      </Field>
                    )}
                    <div className="flex gap-2">
                      <Button type="submit" variant="secondary" disabled={busy}>
                        {emailChangePending ? "Verify email" : "Add email"}
                      </Button>
                      {emailChangePending && (
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setEmailChangePending(false);
                            setEmailOtp("");
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                </form>
              </Card>

              <Card className="p-6">
                <SectionHeader title="Connected accounts" description="Sign in faster with a provider you already use." />
                <ul className="mt-4 divide-y divide-border">
                  {(["google", "github"] as const).map((provider) => {
                    const linked = socialAccounts.find((a) => a.providerId === provider);
                    return (
                      <li key={provider} className="flex items-center justify-between gap-3 py-3">
                        <span className="flex items-center gap-2 text-sm">
                          {provider === "google" ? "Google" : "GitHub"}
                          {linked && <Badge tone="success">Connected</Badge>}
                        </span>
                        {linked ? (
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            onClick={() =>
                              act(async () => {
                                const result = await authClient.unlinkAccount({
                                  accountId: linked.id,
                                });
                                if (!result.error) {
                                  const updated = await authClient.listAccounts();
                                  if (updated.data) setAccounts(updated.data);
                                }
                                return result;
                              })
                            }
                          >
                            Disconnect
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            size="xs"
                            disabled={busy}
                            onClick={() =>
                              act(() =>
                                authClient.linkSocial({
                                  provider,
                                  callbackURL: "/account",
                                  errorCallbackURL: "/account",
                                }),
                              )
                            }
                          >
                            Connect
                          </Button>
                        )}
                      </li>
                    );
                  })}
                  {socialAccounts
                    .filter((a) => a.providerId !== "google" && a.providerId !== "github")
                    .map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-3 py-3">
                        <span className="flex items-center gap-2 text-sm capitalize">
                          {a.providerId}
                          <Badge tone="success">Connected</Badge>
                        </span>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            act(async () => {
                              const result = await authClient.unlinkAccount({
                                accountId: a.id,
                              });
                              if (!result.error) {
                                const updated = await authClient.listAccounts();
                                if (updated.data) setAccounts(updated.data);
                              }
                              return result;
                            })
                          }
                        >
                          Disconnect
                        </Button>
                      </li>
                    ))}
                </ul>
              </Card>
            </>
          )}

          {tab === "security" && (
            <>
              {deleteToken && (
                <Card className="border-danger-border bg-danger-soft p-6">
                  <SectionHeader
                    title="Confirm account deletion"
                    description="Your login, profile and stored integration secrets will be permanently removed. Your subscriptions will be canceled and your projects will no longer be accessible through this account."
                  />
                  <div className="mt-4 flex flex-wrap items-end gap-3">
                    <Field label="Type DELETE to confirm" htmlFor="account-delete" className="w-56">
                      <TextInput
                        id="account-delete"
                        value={deleteConfirmation}
                        onChange={(e) => setDeleteConfirmation(e.target.value)}
                      />
                    </Field>
                    <Button
                      variant="danger"
                      disabled={busy || deleteConfirmation !== "DELETE"}
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
                    </Button>
                  </div>
                </Card>
              )}

              <Card className="p-6">
                <SectionHeader title="Password" description="Changing your password signs out your other devices." />
                <form
                  className="mt-5"
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
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Current password" htmlFor="account-current-password">
                      <TextInput
                        id="account-current-password"
                        type="password"
                        autoComplete="current-password"
                        required
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                      />
                    </Field>
                    <Field label="New password" htmlFor="account-new-password" hint="At least 8 characters.">
                      <TextInput
                        id="account-new-password"
                        type="password"
                        autoComplete="new-password"
                        minLength={8}
                        maxLength={128}
                        required
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                      />
                    </Field>
                  </div>
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="-ml-3"
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
                      Email me a reset link instead
                    </Button>
                    <Button type="submit" variant="primary" disabled={busy}>
                      Update password
                    </Button>
                  </div>
                </form>
              </Card>

              <Card className="p-6">
                <SectionHeader
                  title="Active devices"
                  description="Where your account is currently signed in."
                  action={
                    sessions.length > 1 ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          act(
                            () => authClient.revokeOtherSessions(),
                            "Other devices signed out",
                          )
                        }
                      >
                        Sign out all others
                      </Button>
                    ) : undefined
                  }
                />
                <ul className="mt-4 divide-y divide-border">
                  {sessions.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm">
                          <span className="truncate">{describeDevice(s.userAgent)}</span>
                          {s.id === session.session.id && <Badge tone="accent">This device</Badge>}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-muted">
                          {s.ipAddress ? `${s.ipAddress} · ` : ""}Signed in until{" "}
                          {new Date(s.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                        </p>
                      </div>
                      {s.id !== session.session.id && (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={busy}
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
                          Sign out
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>

              <Card className="p-6">
                <SectionHeader
                  title="Delete account"
                  description="Permanently remove your account and stored integration secrets. You’ll confirm by email before anything is deleted."
                  action={
                    <Button
                      variant="danger-outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        act(
                          () => authClient.deleteUser({ callbackURL: "/" }),
                          "Check your email to confirm account deletion.",
                        )
                      }
                    >
                      Delete account
                    </Button>
                  }
                />
              </Card>
            </>
          )}

          {tab === "billing" && (
            <>
              <Card className="p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.08em] text-subtle">Current plan</p>
                    <h3 className="mt-1.5 text-xl font-semibold capitalize tracking-tight">
                      {subscription?.plan ?? "free"}
                    </h3>
                    {subscription && subscription.amount > 0 ? (
                      <p className="mt-1 text-sm text-muted">
                        ${subscription.amount / 100} / {subscription.interval}
                        <span className="mx-1.5 text-subtle">·</span>
                        {subscription.cancelAtPeriodEnd ? "Access ends" : "Renews"}{" "}
                        {new Date(subscription.periodEnd).toLocaleDateString()}
                      </p>
                    ) : (
                      <p className="mt-1 text-sm text-muted">No recurring charge</p>
                    )}
                  </div>
                  {!subscription?.migrationPending && (
                    <div className="flex flex-wrap gap-2">
                      {subscription && subscription.amount > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
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
                            : "Cancel subscription"}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={
                          subscription?.amount
                            ? () => setChangingPlan(true)
                            : () => location.assign("/pricing")
                        }
                      >
                        {subscription?.amount ? "Change plan" : "Upgrade"}
                      </Button>
                    </div>
                  )}
                </div>
                {billingDetails.upcomingPlan && (
                  <Notice tone="info" className="mt-5 flex flex-wrap items-center justify-between gap-3 text-fg">
                    <span>
                      Switching to{" "}
                      <span className="font-medium capitalize">{billingDetails.upcomingPlan.plan}</span> at $
                      {billingDetails.upcomingPlan.amount / 100}/{billingDetails.upcomingPlan.interval} on{" "}
                      {new Date(
                        billingDetails.upcomingPlan.effectiveAt * 1000,
                      ).toLocaleDateString()}
                      .
                    </span>
                    <Button
                      variant="secondary"
                      size="xs"
                      disabled={busy}
                      onClick={() => billingAction("cancel-plan-change")}
                    >
                      Keep current plan
                    </Button>
                  </Notice>
                )}
                {subscription?.migrationPending && (
                  <Notice className="mt-5 text-fg">
                    Your existing subscription is being migrated. Your current price and access are preserved.
                  </Notice>
                )}
              </Card>

              {!subscription?.migrationPending && (
                <>
                  <Card className="p-6">
                    <SectionHeader
                      title="Payment methods"
                      action={
                        !paymentSecret ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() => billingAction("setup-payment")}
                          >
                            Add payment method
                          </Button>
                        ) : undefined
                      }
                    />
                    {billingDetails.paymentMethods.length > 0 ? (
                      <ul className="mt-4 divide-y divide-border">
                        {billingDetails.paymentMethods.map((card) => (
                          <li key={card.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                            <span className="flex items-center gap-2 text-sm">
                              <span className="capitalize">{card.brand}</span>
                              <span className="font-mono text-[13px] text-muted">•••• {card.last4}</span>
                              <span className="text-xs text-muted">
                                Expires {card.expiryMonth}/{card.expiryYear}
                              </span>
                              {card.isDefault && <Badge tone="accent">Default</Badge>}
                            </span>
                            <span className="flex gap-1">
                              {!card.isDefault && (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  disabled={busy}
                                  onClick={() =>
                                    billingAction("set-default-payment", card.id)
                                  }
                                >
                                  Make default
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="xs"
                                disabled={busy}
                                onClick={() =>
                                  billingAction("remove-payment", card.id)
                                }
                              >
                                Remove
                              </Button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      !paymentSecret && <p className="mt-3 text-sm text-muted">No payment method on file.</p>
                    )}
                    {paymentSecret && (
                      <div className="mt-5 border-t border-border pt-5">
                        <PaymentMethodForm
                          clientSecret={paymentSecret}
                          onSaved={() => {
                            setPaymentSecret("");
                            refreshBilling();
                            setMessage("Payment method saved.");
                          }}
                        />
                      </div>
                    )}
                  </Card>

                  <Card className="p-6">
                    <SectionHeader
                      title="Billing history"
                      action={
                        <Link href="/pricing" className={buttonClass({ variant: "ghost", size: "sm" })}>
                          Compare plans
                        </Link>
                      }
                    />
                    {billingDetails.invoices.length > 0 ? (
                      <ul className="mt-4 divide-y divide-border">
                        {billingDetails.invoices.map((invoice) => (
                          <li key={invoice.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span>{new Date(invoice.created * 1000).toLocaleDateString()}</span>
                              <span className="tabular-nums text-muted">${invoice.amount / 100}</span>
                              <Badge tone={invoice.status === "paid" ? "success" : "neutral"} className="capitalize">
                                {invoice.status}
                              </Badge>
                            </span>
                            <a
                              href={invoice.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={buttonClass({ variant: "ghost", size: "xs" })}
                            >
                              {invoice.kind === "receipt" ? "Receipt" : "Invoice"}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-3 text-sm text-muted">No payments yet.</p>
                    )}
                  </Card>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </Frame>
  );
}

/** The /account page gets the shared app shell; the in-app dialog does not. */
function Frame({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  if (embedded) return <div className="bg-bg text-fg">{children}</div>;
  return <AppShell>{children}</AppShell>;
}

/** Turn a raw user-agent string into something a person would recognize. */
function describeDevice(userAgent?: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : null;
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  if (!browser && !os) return userAgent.length > 48 ? `${userAgent.slice(0, 48)}…` : userAgent;
  return [browser, os].filter(Boolean).join(" on ");
}
