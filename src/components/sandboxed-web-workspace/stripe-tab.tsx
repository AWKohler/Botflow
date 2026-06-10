"use client";

/**
 * StripeTab — workspace tab that renders Stripe's embedded Connect components
 * for the project's connected account. Loads Connect.js with a
 * fetchClientSecret callback pointing at our /account-session endpoint and
 * mounts the components Stripe Standard supports (payments, payouts,
 * balances, account management, onboarding).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectComponentsProvider,
  ConnectAccountManagement,
  ConnectAccountOnboarding,
  ConnectBalances,
  ConnectNotificationBanner,
  ConnectPayments,
  ConnectPayouts,
} from "@stripe/react-connect-js";
// The /pure entry skips the module-load side effect (injecting the Connect
// script), which otherwise logs an SSR warning when Next evaluates this file
// on the server. loadConnectAndInitialize injects it on first call instead.
import { loadConnectAndInitialize, type StripeConnectInstance } from "@stripe/connect-js/pure";
import { AlertTriangle, ExternalLink, Loader2, RefreshCw, Unplug } from "lucide-react";
import { cn } from "@/lib/utils";

interface StripeModeToggleProps {
  projectId: string;
  mode: "test" | "live";
  busy: boolean;
  onToggle: (next: "test" | "live") => void | Promise<void>;
}

/** Pill switch shown in the workspace toolbar when the Stripe tab is active. */
export function StripeModeToggle({ mode, busy, onToggle }: StripeModeToggleProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-full border border-border bg-elevated/60 p-0.5",
        busy && "opacity-60 pointer-events-none",
      )}
      role="group"
      aria-label="Stripe payment mode"
    >
      {(["test", "live"] as const).map((m) => (
        <button
          key={m}
          onClick={() => onToggle(m)}
          aria-pressed={mode === m}
          className={cn(
            "text-[11px] font-medium px-3 py-1 rounded-full transition-colors",
            mode === m
              ? m === "live"
                ? "bg-red-500/20 text-red-300"
                : "bg-amber-500/20 text-amber-300"
              : "text-muted hover:text-fg",
          )}
        >
          {m === "test" ? "Test mode" : "Live mode"}
        </button>
      ))}
    </div>
  );
}

type StripeSubView =
  | "payments"
  | "balances"
  | "payouts"
  | "account"
  | "onboarding";

interface StripeTabProps {
  projectId: string;
  /** Cache-busts the connect instance when the user flips test/live. */
  mode: "test" | "live";
  /** Click handler for "Open Full Stripe Dashboard ↗". */
  onOpenFullDashboard?: () => void;
  /** Called after the user disconnects the account in the current mode, so the
   *  workspace can flip stripeEnabled off and leave the tab. */
  onDisconnected?: (mode: "test" | "live") => void;
}

interface AccountSessionResponse {
  ok: boolean;
  clientSecret?: string;
  publishableKey?: string;
  mode?: string;
  accountId?: string;
  error?: string;
}

interface AccountStatus {
  connected: boolean;
  ready: boolean;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
  requirements?: {
    currentlyDue: string[];
    pastDue: string[];
    disabledReason: string | null;
  };
}

async function fetchAccountStatus(projectId: string): Promise<AccountStatus | null> {
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/stripe/account-status`,
      { cache: "no-store" },
    );
    const data = (await res.json()) as AccountStatus & { ok: boolean };
    if (!res.ok || !data.ok) return null;
    return data;
  } catch {
    return null;
  }
}

/** Map botflow's CSS vars to Stripe Connect appearance.variables. Stripe's
 *  appearance API recolors the embedded components in-place; this keeps them
 *  visually consistent with the workspace's dark sand palette (or whatever
 *  theme is active — we read the resolved CSS values, not hard-coded hex). */
function themeVariables(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const styles = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    colorPrimary: v("--sand-accent", "#d8826a"),
    colorBackground: v("--sand-surface", "#23201b"),
    colorText: v("--sand-text", "#ede6db"),
    colorSecondaryText: v("--sand-text-muted", "#b8ada1"),
    colorBorder: v("--sand-border", "#3a342e"),
    colorDanger: "#ef6961",
    colorWarning: "#e0a44a",
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    borderRadius: "8px",
    // 5px gives ~25% more padding everywhere inside the components without
    // disrupting their relative proportions. 4 was tight.
    spacingUnit: "5px",
    fontSizeBase: "14px",
    buttonPrimaryColorBackground: v("--sand-accent", "#d8826a"),
    buttonPrimaryColorText: v("--sand-accent-contrast", "#1b1713"),
  };
}

async function fetchAccountSession(projectId: string): Promise<AccountSessionResponse> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/stripe/account-session`,
    { method: "POST", cache: "no-store" },
  );
  const data = (await res.json()) as AccountSessionResponse;
  if (!res.ok || !data.clientSecret || !data.publishableKey) {
    throw new Error(data.error ?? `account-session HTTP ${res.status}`);
  }
  return data;
}

export function StripeTab({ projectId, mode, onOpenFullDashboard, onDisconnected }: StripeTabProps) {
  const [view, setView] = useState<StripeSubView>("payments");
  const [connectInstance, setConnectInstance] = useState<StripeConnectInstance | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryTick, setRetryTick] = useState(0);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Pin projectId in a ref so the SDK's fetchClientSecret callback always
  // hits the right URL even if the tab is re-keyed mid-flight.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const fetchClientSecret = useCallback(async (): Promise<string> => {
    const data = await fetchAccountSession(projectIdRef.current);
    return data.clientSecret!;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setConnectInstance(null);

    (async () => {
      try {
        // Pull live readiness in parallel — gates whether we render the full
        // dashboard or an onboarding-completion panel.
        void fetchAccountStatus(projectIdRef.current).then((s) => {
          if (!cancelled) setStatus(s);
        });
        // Initial pre-fetch lands the publishable key + account id. The SDK
        // will call fetchClientSecret again on its own as needed (~1h TTL).
        const initial = await fetchAccountSession(projectIdRef.current);
        if (cancelled) return;
        setAccountId(initial.accountId ?? null);
        const instance = loadConnectAndInitialize({
          publishableKey: initial.publishableKey!,
          fetchClientSecret,
          appearance: {
            overlays: "drawer",
            variables: themeVariables(),
          },
        });
        if (!cancelled) {
          setConnectInstance(instance);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, mode, fetchClientSecret, retryTick]);

  const subViews: Array<{ id: StripeSubView; label: string }> = useMemo(
    () => [
      { id: "payments", label: "Payments" },
      { id: "balances", label: "Balances" },
      { id: "payouts", label: "Payouts" },
      { id: "account", label: "Account" },
      { id: "onboarding", label: "Onboarding" },
    ],
    [],
  );

  const refreshStatus = useCallback(async () => {
    const s = await fetchAccountStatus(projectIdRef.current);
    setStatus(s);
  }, []);

  const handleDisconnect = useCallback(async () => {
    if (disconnecting) return;
    const confirmed = window.confirm(
      `Disconnect your Stripe account from ${mode} mode? You can reconnect (or link a different account) afterwards.`,
    );
    if (!confirmed) return;
    setDisconnecting(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectIdRef.current)}/stripe/disconnect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        },
      );
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Disconnect failed (HTTP ${res.status})`);
        return;
      }
      onDisconnected?.(mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDisconnecting(false);
    }
  }, [disconnecting, mode, onDisconnected]);

  // Connected but not finished onboarding → don't render the dashboard (it
  // would falsely imply the account is live). Show a completion panel instead.
  const needsOnboarding = status?.connected === true && status.ready === false;

  return (
    <div className="flex flex-col h-full bg-bolt-bg">
      <div className="flex items-center justify-between px-6 py-3 border-b border-border">
        <div className="flex items-center gap-1.5">
          {/* Hide the dashboard sub-views until onboarding is actually
              complete — they'd misrepresent a half-onboarded account as live. */}
          {!needsOnboarding &&
            subViews.map((v) => (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={cn(
                  "text-xs font-medium px-3 py-1.5 rounded-md transition-colors",
                  view === v.id
                    ? "bg-elevated text-fg"
                    : "text-muted hover:text-fg hover:bg-elevated/50",
                )}
              >
                {v.label}
              </button>
            ))}
          {needsOnboarding && (
            <span className="text-xs font-medium text-amber-300">
              Finish activating your Stripe account
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {accountId && (
            <span className="text-[10px] text-muted font-mono">
              {accountId.slice(0, 14)}…
            </span>
          )}
          {accountId && (
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="flex items-center gap-1 text-xs font-medium text-muted hover:text-red-400 transition-colors disabled:opacity-50"
              title={`Disconnect your Stripe account from ${mode} mode`}
            >
              {disconnecting ? <Loader2 size={12} className="animate-spin" /> : <Unplug size={12} />}
              Disconnect
            </button>
          )}
          {onOpenFullDashboard && (
            <button
              onClick={onOpenFullDashboard}
              className="flex items-center gap-1 text-xs font-medium text-fg hover:text-accent transition-colors"
              title="Open the full Stripe Dashboard in a new tab"
            >
              Open Full Stripe Dashboard
              <ExternalLink size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center h-full text-muted gap-2">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-sm">Loading Stripe components…</span>
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <p className="text-sm text-red-400 max-w-md">{error}</p>
            <button
              onClick={() => setRetryTick((t) => t + 1)}
              className="flex items-center gap-2 text-sm font-medium bg-elevated px-3 py-1.5 rounded-md hover:bg-elevated/70 transition-colors"
            >
              <RefreshCw size={14} />
              Retry
            </button>
          </div>
        )}
        {!loading && !error && connectInstance && (
          <ConnectComponentsProvider connectInstance={connectInstance}>
            {/* Stripe components render their own bordered cards; we just
                provide the outer page padding + vertical rhythm between
                the notification banner row and the active sub-view. */}
            <div className="px-6 py-5 space-y-5">
              {needsOnboarding ? (
                <>
                  <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                    <AlertTriangle size={18} className="text-amber-300 mt-0.5 shrink-0" />
                    <div className="text-sm text-amber-100/90 space-y-1">
                      <p className="font-medium text-amber-200">
                        Your Stripe account isn&apos;t fully activated yet
                      </p>
                      <p className="text-[13px] leading-relaxed">
                        Until activation is complete, your live app can&apos;t take
                        payments — checkout will fail with &quot;no valid payment
                        method types&quot;. Finish the steps below to go live. If you
                        linked the wrong account, use Disconnect above.
                      </p>
                    </div>
                  </div>
                  <ConnectNotificationBanner />
                  <div className="min-h-[500px]">
                    <ConnectAccountOnboarding onExit={() => void refreshStatus()} />
                  </div>
                </>
              ) : (
                <>
                  <ConnectNotificationBanner />
                  <div className="min-h-[500px]">
                    {view === "payments" && <ConnectPayments />}
                    {view === "balances" && <ConnectBalances />}
                    {view === "payouts" && <ConnectPayouts />}
                    {view === "account" && <ConnectAccountManagement />}
                    {view === "onboarding" && (
                      <ConnectAccountOnboarding
                        onExit={() => {
                          setView("account");
                          void refreshStatus();
                        }}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
          </ConnectComponentsProvider>
        )}
      </div>
    </div>
  );
}
