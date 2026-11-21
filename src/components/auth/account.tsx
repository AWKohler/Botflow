"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { authClient } from "@/lib/auth/client";
import { ChangePlanModal } from "./change-plan";
import { ProviderLogo } from "./sign-in";
import { PaymentMethodForm } from "./payment-method";
import dynamic from "next/dynamic";
import { CreditCard, ExternalLink, Gauge, Plug, ShieldCheck, UserRound } from "lucide-react";
import { UsageTab } from "@/components/settings/UsageTab";
import { AppShell } from "@/components/site/AppShell";
import { Badge, Notice } from "@/components/ui/badge";
import { Button, buttonClass } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Field, TextInput } from "@/components/ui/field";
import { cn } from "@/lib/utils";
// Loaded lazily: the connections code imports this module's siblings.
const ConnectionsSection = dynamic(
  () => import("@/components/settings/SettingsModal").then((m) => m.SettingsModal),
  { ssr: false },
);

const TAB_IDS = ["profile", "security", "usage", "connections", "billing"] as const;
type TabId = (typeof TAB_IDS)[number];

interface Session {
  id: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  expiresAt: Date;
  createdAt: Date;
}
export function AccountPanel() {
  const { data: session, isPending } = authClient.useSession();
  const [tab, setTab] = useState<TabId>("profile");
  // On a phone the section tabs are one scrolling row: keep the current one in view.
  const tabsRef = useRef<HTMLElement>(null);
  const tabsShown = !isPending && !!session;
  useEffect(() => {
    const nav = tabsRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
    // Only when it is not already fully in view (so the row does not move under
    // a finger): the current tab starts at the page gutter, or the row ends flush right.
    const left = current.offsetLeft - nav.scrollLeft;
    if (left >= 20 && left + current.offsetWidth <= nav.clientWidth - 20) return;
    nav.scrollTo({ left: current.offsetLeft - 24 });
    // Also when the page first renders its tabs (they are absent while the session loads).
  }, [tab, tabsShown]);
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
  // "stale": the server only lists devices for a recent sign-in.
  const [sessionsState, setSessionsState] = useState<"loading" | "ready" | "stale" | "error">("loading");
  const [accounts, setAccounts] = useState<
    { id: string; providerId: string; accountId: string }[]
  >([]);
  // The tier the account actually has. It can be above the paid plan (access
  // granted to the account), and the Usage tab reports allowances by tier, so
  // the plan card says so instead of a bare "Free".
  const [accessTier, setAccessTier] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/plan")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { tier?: string } | null) => {
        if (!cancelled && d?.tier) setAccessTier(d.tier);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
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
    const requested = new URLSearchParams(location.search).get("tab");
    if (requested && (TAB_IDS as readonly string[]).includes(requested)) setTab(requested as TabId);
  }, []);
  useEffect(() => {
    if (!session) return;
    refreshEmails();
    setName(session.user.name);
    setUsername(session.user.username ?? "");
    authClient
      .listSessions()
      .then((r) => {
        if (r.data) setSessions(r.data as Session[]);
        const notFresh = r.error?.code === "SESSION_NOT_FRESH" || r.error?.status === 403;
        setSessionsState(r.data ? "ready" : notFresh ? "stale" : "error");
      })
      .catch(() => setSessionsState("error"));
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
      <AppShell>
        <p className="py-16 text-center text-sm text-muted">Loading your settings…</p>
      </AppShell>
    );
  if (!session)
    return (
      <AppShell>
        <div className="py-16 text-center">
          <Link href="/sign-in?redirect_url=%2Faccount" className={buttonClass({ variant: "primary" })}>
            Sign in to manage your settings
          </Link>
        </div>
      </AppShell>
    );

  const tabs: { id: TabId; label: string; icon: typeof UserRound }[] = [
    { id: "profile", label: "Profile", icon: UserRound },
    { id: "security", label: "Security", icon: ShieldCheck },
    { id: "usage", label: "Usage", icon: Gauge },
    { id: "connections", label: "Connections", icon: Plug },
    { id: "billing", label: "Plan and billing", icon: CreditCard },
  ];
  const PLAN_RANK: Record<string, number> = { free: 0, pro: 1, max: 2 };
  const paidPlan = subscription?.plan ?? "free";
  const grantedTier =
    accessTier && (PLAN_RANK[accessTier] ?? 0) > (PLAN_RANK[paidPlan] ?? 0) ? accessTier : null;
  const socialAccounts = accounts.filter((a) => a.providerId !== "credential");
  const thisDevice = session.session as unknown as Session;
  const deviceRows: Session[] = sessions.length ? sessions : [thisDevice];
  const initial = (session.user.name?.[0] ?? session.user.email?.[0] ?? "U").toUpperCase();
  const profileDirty =
    name.trim() !== (session.user.name ?? "") ||
    username.trim() !== ((session.user as { username?: string | null }).username ?? "");

  return (
    <AppShell>
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

      {/* minmax(0,…) on the phone column too: a bare track grows to fit the
          tab row and pushes the whole page wider than the screen. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[200px_minmax(0,760px)] md:gap-12">
        <aside className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1.5 text-sm text-muted">Your account, usage, connections and plan.</p>
          {/* Phone: one row that scrolls sideways, bled to the screen edges and
              faded where it runs on, so it reads as "there is more". */}
          <nav
            ref={tabsRef}
            aria-label="Settings sections"
            className={cn(
              "relative mt-5 flex gap-1 md:mt-6 md:flex-col",
              "max-md:-mx-6 max-md:overflow-x-auto max-md:px-6 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden",
              "max-md:[mask-image:linear-gradient(to_right,transparent,black_2rem,black_calc(100%-2.5rem),transparent)]",
            )}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={tab === t.id ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
                  "pointer-coarse:min-h-11 pointer-coarse:text-[15px]",
                  tab === t.id ? "bg-elevated text-fg" : "text-muted hover:bg-elevated/60 hover:text-fg",
                )}
                onClick={() => {
                  setTab(t.id);
                  setMessage("");
                  // Keep the address in step, so a section can be linked to and reloaded.
                  history.replaceState(null, "", `/account?tab=${t.id}`);
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
              <Card className="p-5 sm:p-6">
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
                    {/* Quiet until something has changed, like every other form here. */}
                    <Button type="submit" variant={profileDirty ? "primary" : "secondary"} disabled={busy || !profileDirty}>
                      Save changes
                    </Button>
                  </div>
                </form>
              </Card>

              <Card className="p-5 sm:p-6">
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
                              size="sm"
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
                            size="sm"
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

              <Card className="p-5 sm:p-6">
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
                      className="-ml-3 underline decoration-border-strong underline-offset-4"
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
                    <Button
                      type="submit"
                      variant={currentPassword && newPassword ? "primary" : "secondary"}
                      disabled={busy || !currentPassword || !newPassword}
                    >
                      Update password
                    </Button>
                  </div>
                </form>
              </Card>

              <Card className="p-5 sm:p-6">
                <SectionHeader title="Sign-in methods" description="Other ways to sign in to this account, besides your password." />
                <ul className="mt-4 divide-y divide-border">
                  {(["google", "github"] as const).map((provider) => {
                    const linked = socialAccounts.find((a) => a.providerId === provider);
                    return (
                      <li key={provider} className="flex items-center justify-between gap-3 py-3">
                        <span className="flex items-center gap-2.5 text-sm">
                          <ProviderLogo provider={provider} />
                          {provider === "google" ? "Google" : "GitHub"}
                          {linked && <Badge tone="success">Connected</Badge>}
                        </span>
                        {linked ? (
                          <Button
                            variant="ghost"
                            size="sm"
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
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              act(() =>
                                authClient.linkSocial({
                                  provider,
                                  callbackURL: "/account?tab=security",
                                  errorCallbackURL: "/account?tab=security",
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
                          size="sm"
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

              <Card className="p-5 sm:p-6">
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
                  {/* This device is always known from the session itself, so the
                      list is never empty while the others load (or fail to). */}
                  {deviceRows.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm">
                          <span className="truncate">{describeDevice(s.userAgent)}</span>
                          {s.id === session.session.id && <Badge tone="accent">This device</Badge>}
                        </p>
                        <p className="mt-0.5 text-xs text-muted sm:truncate">
                          {s.ipAddress ? `${s.ipAddress} · ` : ""}Signed in until{" "}
                          {new Date(s.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                        </p>
                      </div>
                      {s.id !== session.session.id && (
                        <Button
                          variant="secondary"
                          size="sm"
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
                {sessionsState === "loading" && (
                  <p className="mt-2 text-xs text-muted">Checking for other devices…</p>
                )}
                {sessionsState === "stale" && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                    <p className="text-[13px] text-muted">
                      To see and sign out your other devices, confirm it’s you by signing in again.
                    </p>
                    <Link
                      href="/sign-in?redirect_url=%2Faccount%3Ftab%3Dsecurity"
                      className={buttonClass({ variant: "secondary", size: "sm" })}
                    >
                      Sign in again
                    </Link>
                  </div>
                )}
                {sessionsState === "error" && (
                  <p className="mt-2 text-xs text-muted">
                    Other devices couldn’t be loaded. Reload the page to try again.
                  </p>
                )}
                {sessionsState === "ready" && sessions.length <= 1 && (
                  <p className="mt-2 text-xs text-muted">You’re not signed in anywhere else.</p>
                )}
              </Card>

              <Card className="p-5 sm:p-6">
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

          {tab === "usage" && (
            <Card className="p-5 sm:p-6">
              <SectionHeader title="Usage" description="How much of your plan's model credits you have used." />
              <div className="mt-5">
                <UsageTab />
              </div>
            </Card>
          )}

          {tab === "connections" && (
            <Card className="p-5 sm:p-6">
              <SectionHeader
                title="Connections"
                description="Subscriptions, accounts and API keys that Botflow can use on your behalf."
              />
              <div className="mt-6">
                <ConnectionsSection variant="section" defaultTab="connections" open onClose={() => {}} />
              </div>
            </Card>
          )}

          {tab === "billing" && (
            <>
              <Card className="p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-[13px] text-muted">Current plan</p>
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
                    {grantedTier && (
                      <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted">
                        Your account has <span className="font-medium capitalize text-fg">{grantedTier}</span> access
                        at no charge, so your models and credit allowance are {grantedTier === "max" ? "Max" : "Pro"}&apos;s.
                      </p>
                    )}
                  </div>
                  {!subscription?.migrationPending && (
                    // Phone: the main action leads, at the card's left edge.
                    <div className="flex flex-wrap gap-2 max-sm:w-full max-sm:flex-row-reverse max-sm:justify-end">
                      <Link href="/pricing" className={buttonClass({ variant: "ghost", size: "sm" })}>
                        Compare plans
                      </Link>
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
                        // On Free, upgrading is the one thing this card is for.
                        variant={subscription?.amount ? "secondary" : "primary"}
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
                      size="sm"
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
                  <Card className="p-5 sm:p-6">
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
                                  size="sm"
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
                                size="sm"
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

                  <Card className="p-5 sm:p-6">
                    <SectionHeader title="Billing history" />
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
                              className={buttonClass({ variant: "ghost", size: "sm" })}
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
    </AppShell>
  );
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
  // Scripts and API clients send bare tokens like "node" or "curl/8.4".
  if (!browser && !os) return "Another app or script";
  return [browser, os].filter(Boolean).join(" on ");
}
