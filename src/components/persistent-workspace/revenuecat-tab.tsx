"use client";

/**
 * Payments tab (Swift workspace): RevenueCat in-app purchases.
 *
 * Two states, driven by the project's revenuecat_status:
 *   • not connected → a three-step setup that ends with pasting ONE value, the
 *     RevenueCat secret key. Botflow works out everything else from it.
 *   • connected → what is set up and what is not (key, test purchases, purchase
 *     events, the app's backend), what the app sells and whether the paywall
 *     will work, how to try a purchase, recent purchase events, and the steps
 *     to sell for real on the App Store.
 *
 * RevenueCat's dashboard cannot be embedded (X-Frame-Options: DENY), so the
 * tab links out to the exact page for each task instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Copy,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { Catalog } from "@/lib/revenuecat-catalog";

interface StatusResponse {
  ok: boolean;
  status: "none" | "connecting" | "connected";
  role: "owner" | "editor";
  environment: "sandbox" | "production";
  connection: { rcProjectId: string; rcProjectName: string | null; connectedAt: string } | null;
  links: Record<"overview" | "apiKeys" | "products" | "apps" | "integrations" | "customers", string>;
  checks: {
    key: { ok: boolean; error: string | null };
    testStore: { ok: boolean };
    appStore: { ok: boolean };
    webhook: { mode: "automatic" | "manual"; ok: boolean; error: string | null; lastEventAt: string | null };
    backend: { state: "live" | "not-deployed" | "not-configured" | "no-backend" | "unknown" };
  };
  manualWebhook: { url: string; authorizationHeader: string } | null;
}

interface ActivityItem {
  id: string;
  type: string;
  productId: string | null;
  price: number | null;
  currency: string | null;
  environment: string | null;
  appUserId: string | null;
  rcEventType: string | null;
  delivery: { status: string; attempts: number; lastError: string | null };
  at: string;
}

/** What happened, in the buyer's terms. Keyed by RevenueCat's event type. */
const RC_EVENT_LABELS: Record<string, string> = {
  INITIAL_PURCHASE: "Purchased",
  NON_RENEWING_PURCHASE: "Purchased",
  RENEWAL: "Renewed",
  UNCANCELLATION: "Auto-renew turned back on",
  PRODUCT_CHANGE: "Changed plan",
  SUBSCRIPTION_EXTENDED: "Subscription extended",
  TEMPORARY_ENTITLEMENT_GRANT: "Temporary access granted",
  EXPIRATION: "Expired",
  CANCELLATION: "Auto-renew turned off",
  BILLING_ISSUE: "Payment failed",
};

/** Fallback when the RevenueCat type is unknown: our normalized type. */
const EVENT_LABELS: Record<string, string> = {
  "entitlement.granted": "Access granted",
  "entitlement.revoked": "Access ended",
  "entitlement.cancellation": "Auto-renew turned off",
  "billing.issue": "Payment failed",
};

const PRODUCT_TYPE_LABELS: Record<string, string> = {
  subscription: "Subscription",
  non_consumable: "One-time unlock",
  consumable: "Consumable",
  non_renewing_subscription: "Fixed-term pass",
  one_time: "One-time purchase",
};

const DURATION_LABELS: Record<string, string> = {
  P1W: "weekly",
  P1M: "monthly",
  P2M: "every 2 months",
  P3M: "every 3 months",
  P6M: "every 6 months",
  P1Y: "yearly",
};

const REVENUECAT_HOME = "https://app.revenuecat.com";

interface RevenueCatTabProps {
  projectId: string;
  /** The project's revenuecat_status. 'connecting' = the agent opened setup. */
  status: "none" | "connecting" | "connected";
  /** Whether the tab is the one on screen (pauses background refreshes). */
  active?: boolean;
  /** Called after connect/disconnect so the parent re-reads the project. */
  onChanged?: () => void;
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
    >
      {children}
      <ArrowUpRight size={13} aria-hidden />
    </a>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <div>
      <div className="mb-1 text-xs text-muted">{label}</div>
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-fg">
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="flex items-center gap-1 rounded-md border border-border px-2.5 text-xs text-muted hover:text-fg"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

type RowState = "ok" | "attention" | "pending";

/** One line of the setup health list: state icon, what it is, what to do. */
function HealthRow({
  state,
  title,
  children,
  action,
}: {
  state: RowState;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 py-3">
      <div className="pt-0.5">
        {state === "ok" ? (
          <CircleCheck size={16} className="text-success" aria-label="Ready" />
        ) : state === "attention" ? (
          <CircleAlert size={16} className="text-warning" aria-label="Needs attention" />
        ) : (
          <CircleDashed size={16} className="text-muted" aria-label="Not yet" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg">{title}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted">{children}</div>
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-elevated/40">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {aside}
      </div>
      <div className="px-4">{children}</div>
    </section>
  );
}

export function RevenueCatTab({ projectId, status, active = true, onChanged }: RevenueCatTabProps) {
  const { toast } = useToast();
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);

  // Setup form.
  const [secretKey, setSecretKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  // Disconnect could not remove Botflow's webhook from RevenueCat (usually
  // because the key was revoked): where the user can delete it by hand.
  const [leftoverWebhookUrl, setLeftoverWebhookUrl] = useState<string | null>(null);
  const [replacingKey, setReplacingKey] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  // After handing work to the agent, how many of its turns must still finish
  // before what this tab shows is the agent's result. A note sent while the
  // agent is busy is queued behind the running turn, so that is two finishes.
  const [agentTurnsPending, setAgentTurnsPending] = useState(0);
  const agentBusyRef = useRef(false);
  const askedAgent = agentTurnsPending > 0;
  // If the note never reaches the agent (a failed request, a closed chat), do
  // not show "the agent is finishing" forever.
  useEffect(() => {
    if (agentTurnsPending === 0) return;
    const timer = setTimeout(() => setAgentTurnsPending(0), 15 * 60_000);
    return () => clearTimeout(timer);
  }, [agentTurnsPending]);

  const connected = status === "connected";

  const loadStatus = useCallback(
    async (recheck = false) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/revenuecat/status`, {
          method: recheck ? "POST" : "GET",
          cache: "no-store",
        });
        const body = (await res.json().catch(() => null)) as StatusResponse | { error?: string } | null;
        if (res.ok && body && "status" in body) {
          setData(body);
          setLoadError(null);
        } else {
          setLoadError(
            (body && "error" in body && body.error) || `Payments could not be loaded (HTTP ${res.status}).`,
          );
        }
      } catch {
        setLoadError("Payments could not be loaded. Check your connection and try again.");
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  const loadCatalog = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/revenuecat/products`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; catalog?: Catalog; error?: string } | null;
      if (res.ok && body?.catalog) {
        setCatalog(body.catalog);
        setCatalogError(null);
      } else {
        setCatalogError(body?.error || `Products could not be loaded (HTTP ${res.status}).`);
      }
    } catch {
      setCatalogError("Products could not be loaded. Check your connection and try again.");
    }
  }, [projectId]);

  const loadActivity = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/revenuecat/activity`, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { ok: boolean; items?: ActivityItem[] };
      if (body.ok && body.items) setActivity(body.items);
    } catch {
      /* transient; the next refresh retries */
    }
  }, [projectId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus, status]);

  // The catalog and the event log only exist once connected. The event log is
  // our own table, so it is polled while the tab is on screen (test purchases
  // land within seconds). The catalog costs several RevenueCat API calls per
  // read and RevenueCat rate-limits per project, so it is read when the tab
  // opens, on "Check again", and whenever the agent finishes a turn (that is
  // when products get created).
  useEffect(() => {
    if (!connected || !active) return;
    void loadCatalog();
    void loadActivity();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void loadActivity();
    }, 15_000);
    return () => clearInterval(interval);
  }, [connected, active, loadCatalog, loadActivity]);

  useEffect(() => {
    const onBusy = (e: Event) => {
      agentBusyRef.current = Boolean((e as CustomEvent<{ isBusy?: boolean }>).detail?.isBusy);
    };
    const onTurnFinished = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId && detail.projectId !== projectId) return;
      setAgentTurnsPending((n) => Math.max(0, n - 1));
      if (connected) {
        void loadStatus();
        void loadCatalog();
      }
    };
    window.addEventListener("agent-busy-change", onBusy);
    window.addEventListener("agent-turn-finished", onTurnFinished);
    return () => {
      window.removeEventListener("agent-busy-change", onBusy);
      window.removeEventListener("agent-turn-finished", onTurnFinished);
    };
  }, [connected, projectId, loadStatus, loadCatalog]);

  // Hand the rest of the work to the agent through the chat's system-note
  // queue (same channel the OAuth / env-var / Stripe modals use).
  const notifyAgent = useCallback(
    (subject: "connected" | "finish-setup", threadId: string | null) => {
      setAgentTurnsPending(agentBusyRef.current ? 2 : 1);
      window.dispatchEvent(
        new CustomEvent("agent-modal-completed", {
          detail: { projectId, kind: "revenuecat", subject, threadId },
        }),
      );
    },
    [projectId],
  );

  const handleConnect = useCallback(async () => {
    const key = secretKey.trim();
    if (!key) {
      setConnectError("Paste the secret key from RevenueCat first. It starts with sk_.");
      return;
    }
    // A ref, not state: two Enter presses in one frame both see stale state.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setConnectError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/revenuecat/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rcSecretKey: key }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        setConnectError(body.error || `Connecting failed (HTTP ${res.status}). Try again.`);
        return;
      }
      // The key is stored server-side now; drop it from the page.
      setSecretKey("");
      setReplacingKey(false);
      setLeftoverWebhookUrl(null);
      toast({
        title: "RevenueCat connected",
        description: body.testStoreReady
          ? `Linked to "${body.projectName}". Test purchases are ready.`
          : `Linked to "${body.projectName}".`,
      });
      if (body.agentThread) {
        notifyAgent("connected", body.agentThread === "current" ? null : body.agentThread);
      }
      onChanged?.();
      await loadStatus();
    } catch {
      setConnectError("Could not reach Botflow. Check your connection and try again.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [projectId, secretKey, toast, notifyAgent, onChanged, loadStatus]);

  const handleCheckAgain = useCallback(async () => {
    setChecking(true);
    await Promise.all([loadStatus(true), loadCatalog(), loadActivity()]);
    setChecking(false);
  }, [loadStatus, loadCatalog, loadActivity]);

  const handleDisconnect = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/revenuecat/disconnect`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as {
        hadWebhook?: boolean;
        webhookRemoved?: boolean;
        integrationsUrl?: string | null;
      };
      setConfirmingDisconnect(false);
      setCatalog(null);
      setActivity(null);
      setAgentTurnsPending(0);
      const leftover = body.hadWebhook && !body.webhookRemoved;
      setLeftoverWebhookUrl(leftover ? (body.integrationsUrl ?? REVENUECAT_HOME) : null);
      toast({
        title: connected ? "RevenueCat disconnected" : "Setup cancelled",
        description: !connected
          ? undefined
          : leftover
            ? "The stored key was removed. The webhook in RevenueCat could not be removed; see the note on this page."
            : body.hadWebhook
              ? "The stored key and the webhook were removed."
              : "The stored key was removed.",
      });
      onChanged?.();
      await loadStatus();
    } catch (e) {
      toast({
        title: "Could not disconnect",
        description: e instanceof Error ? e.message : "Try again.",
      });
    }
  }, [projectId, connected, toast, onChanged, loadStatus]);

  const keyInputRef = useRef<HTMLInputElement>(null);

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        Loading payments…
      </div>
    );
  }

  const isOwner = data?.role !== "editor";

  const keyForm = (
    <div className="space-y-2">
      <label htmlFor="rc-secret-key" className="block text-xs font-medium text-fg">
        RevenueCat secret key
      </label>
      {/* Stacked, button on the left: the floating simulator window sits over
          the right edge of this tab while a build is running. */}
      <div className="flex flex-col items-start gap-2">
        <Input
          id="rc-secret-key"
          ref={keyInputRef}
          type="password"
          value={secretKey}
          onChange={(e) => {
            setSecretKey(e.target.value);
            if (connectError) setConnectError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !submitting) void handleConnect();
          }}
          placeholder="sk_…"
          aria-invalid={Boolean(connectError)}
          aria-describedby={connectError ? "rc-secret-key-error" : undefined}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-fg"
        />
        <Button onClick={() => void handleConnect()} disabled={submitting || !isOwner}>
          {submitting ? <Loader2 size={16} className="mr-1.5 animate-spin" /> : null}
          {submitting ? "Checking key…" : "Connect"}
        </Button>
      </div>
      {connectError ? (
        <div
          id="rc-secret-key-error"
          role="alert"
          className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning"
        >
          {connectError}
        </div>
      ) : null}
    </div>
  );

  // ── Not connected: setup ─────────────────────────────────────────────────
  if (!connected) {
    return (
      <div className="modern-scrollbar h-full overflow-auto p-4 sm:p-8">
        <div className="mx-auto max-w-xl space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-fg">Set up in-app purchases</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Botflow uses RevenueCat for subscriptions and purchases in iOS apps. Setup takes about two
              minutes, and you can try purchases in the simulator right away: no Apple account and no
              real money.
            </p>
          </div>

          {loadError ? (
            <div role="alert" className="rounded-xl border border-warning-border bg-warning-soft p-4 text-xs text-warning">
              {loadError}
            </div>
          ) : null}

          {leftoverWebhookUrl ? (
            <div role="alert" className="rounded-xl border border-warning-border bg-warning-soft p-4 text-xs leading-relaxed text-warning">
              RevenueCat is disconnected here, but Botflow could not remove its webhook from your RevenueCat
              project. RevenueCat will keep trying to send purchase events and report them as failing.
              Delete the webhook named &quot;Botflow: …&quot; under Integrations, Webhooks.{" "}
              <ExternalLink href={leftoverWebhookUrl}>Open Integrations</ExternalLink>
            </div>
          ) : null}

          {!isOwner ? (
            <div className="rounded-xl border border-border bg-elevated/40 p-4 text-sm text-muted">
              Only the project owner can connect RevenueCat.
            </div>
          ) : (
            <ol className="space-y-5">
              <li className="flex gap-3">
                <StepNumber n={1} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <h3 className="text-sm font-semibold text-fg">Create a RevenueCat project for this app</h3>
                  <p className="text-xs leading-relaxed text-muted">
                    Sign in to RevenueCat (free to start), open the project menu at the top left and
                    choose <Strong>Create new project</Strong> (platform: <Strong>Native Apple</Strong>).
                    Use one RevenueCat project per app, so each app has its own products.
                  </p>
                  <div className="text-xs">
                    <ExternalLink href={REVENUECAT_HOME}>Open RevenueCat</ExternalLink>
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <StepNumber n={2} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <h3 className="text-sm font-semibold text-fg">Create a secret key</h3>
                  <p className="text-xs leading-relaxed text-muted">
                    In that project, open <Strong>API keys</Strong> in the left sidebar and choose{" "}
                    <Strong>New secret API key</Strong>. Then set:
                  </p>
                  <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted">
                    <li>
                      <Strong>API version</Strong> to <Strong>V2</Strong>
                    </li>
                    <li>
                      <Strong>Project configuration permissions</Strong> to <Strong>Read &amp; write</Strong>
                    </li>
                  </ul>
                  <p className="text-xs leading-relaxed text-muted">
                    Leave the other permissions at <Strong>No access</Strong>, choose <Strong>Generate</Strong>{" "}
                    and copy the key with the copy button beside it.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <StepNumber n={3} />
                <div className="min-w-0 flex-1 space-y-2">
                  <h3 className="text-sm font-semibold text-fg">Paste the key here</h3>
                  {keyForm}
                  <p className="text-xs leading-relaxed text-muted">
                    That is the only value Botflow needs. It finds your project, switches on test
                    purchases and adds the purchase-event webhook for you. The key is stored encrypted
                    and never reaches your app or the agent.
                  </p>
                </div>
              </li>
            </ol>
          )}

          <div className="rounded-xl border border-border bg-elevated/40 p-4 text-xs leading-relaxed text-muted">
            <span className="font-medium text-fg">While you build,</span> purchases are simulated through
            RevenueCat&apos;s Test Store. <span className="font-medium text-fg">Once published,</span> the App
            Store build sells your real products. Botflow puts the right key in each build, so a test
            build can never charge anyone.
          </div>

          {status === "connecting" && isOwner ? (
            <button type="button" onClick={handleDisconnect} className="text-xs text-muted hover:text-danger">
              Cancel setup
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  // ── Connected ────────────────────────────────────────────────────────────
  const checks = data?.checks;
  const links = data?.links;
  const blockers = catalog?.issues.filter((i) => i.severity === "blocker") ?? [];
  const warnings = catalog?.issues.filter((i) => i.severity === "warning") ?? [];
  const currentOffering = catalog?.offerings.find((o) => o.isCurrent) ?? null;
  const onPaywall = catalog?.products.filter((p) => p.onPaywall) ?? [];
  const offPaywall = catalog?.products.filter((p) => !p.onPaywall) ?? [];
  const backendState = checks?.backend.state ?? "unknown";
  const backendNeedsAgent =
    backendState === "not-deployed" || backendState === "not-configured" || backendState === "no-backend";
  const readyToTest = Boolean(
    checks?.key.ok && checks.testStore.ok && catalog?.readyForTestPurchases,
  );

  // The one thing left to do, if any, with a single way to hand it to the agent.
  const nextStep: { title: string; body: string } | null = !checks?.key.ok
    ? null
    : catalog && catalog.products.length === 0
      ? {
          title: "Next: add something to sell",
          body: "The agent creates the products, their test prices and the paywall, then deploys the backend. If the chat does not already say what to sell, it will ask.",
        }
      : blockers.length > 0
        ? {
            title: "Next: finish the paywall setup",
            body:
              blockers.length === 1
                ? "One thing stops purchases from working (listed under What your app sells). The agent can fix it."
                : `${blockers.length} things stop purchases from working (listed under What your app sells). The agent can fix them.`,
          }
        : backendNeedsAgent
          ? {
              title: "Next: deploy your app's backend",
              body: "Purchases already unlock in the app. Deploying the backend lets it record them as well.",
            }
          : null;

  return (
    <div className="modern-scrollbar h-full overflow-auto p-4 sm:p-8">
      <div className="mx-auto max-w-2xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-fg">In-app purchases</h2>
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px] font-semibold",
                  data?.environment === "production" ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
                )}
              >
                {data?.environment === "production" ? "Live purchases seen" : "Test mode"}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted">
              Connected to the RevenueCat project{" "}
              <span className="font-medium text-fg">
                {data?.connection?.rcProjectName ?? data?.connection?.rcProjectId ?? "—"}
              </span>
              .
            </p>
          </div>
          <a
            href={links?.overview ?? REVENUECAT_HOME}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-3 text-xs font-medium text-fg hover:bg-soft/60"
          >
            Open RevenueCat
            <ArrowUpRight size={13} aria-hidden />
          </a>
        </div>

        {loadError ? (
          <div role="alert" className="rounded-xl border border-warning-border bg-warning-soft p-4 text-xs text-warning">
            {loadError}
          </div>
        ) : null}

        {askedAgent ? (
          <div className="flex items-start gap-3 rounded-xl border border-info-border bg-info-soft p-4">
            <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-info" aria-hidden />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-fg">The agent is finishing the setup</div>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                It is creating what your app sells and deploying the backend. This page updates when it is
                done; you can follow along in the chat.
              </p>
            </div>
          </div>
        ) : nextStep ? (
          <div className="rounded-xl border border-info-border bg-info-soft p-4">
            <div className="text-sm font-semibold text-fg">{nextStep.title}</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">{nextStep.body}</p>
            {isOwner ? (
              <Button size="sm" className="mt-3" onClick={() => notifyAgent("finish-setup", null)}>
                <Sparkles size={13} className="mr-1.5" aria-hidden />
                Ask the agent to finish
              </Button>
            ) : null}
          </div>
        ) : null}

        {readyToTest && !nextStep && !askedAgent ? (
          <div className="rounded-xl border border-success-border bg-success-soft p-4">
            <div className="text-sm font-semibold text-fg">Ready for a test purchase</div>
            <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted">
              <li>
                Open <Strong>Preview</Strong> and start the simulator.
              </li>
              <li>Open the paywall in your app and tap a purchase button.</li>
              <li>
                In RevenueCat&apos;s test dialog, choose <Strong>Test valid purchase</Strong>. Nothing is
                charged.
              </li>
            </ol>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              The purchase shows up under Activity below within a few seconds. A test subscription renews
              every few minutes and ends by itself after about half an hour.
            </p>
          </div>
        ) : null}

        <Section
          title="Setup"
          aside={
            <button
              type="button"
              onClick={handleCheckAgain}
              disabled={checking}
              className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg disabled:opacity-60"
            >
              <RefreshCw size={12} className={checking ? "animate-spin" : undefined} aria-hidden />
              {checking ? "Checking…" : "Check again"}
            </button>
          }
        >
          <div className="divide-y divide-border">
            <HealthRow
              state={checks?.key.ok ? "ok" : "attention"}
              title="RevenueCat key"
              action={
                !checks?.key.ok || replacingKey ? (
                  isOwner ? keyForm : null
                ) : null
              }
            >
              {checks?.key.ok ? (
                <>
                  Working.{" "}
                  {isOwner && !replacingKey ? (
                    <button
                      type="button"
                      className="text-muted underline hover:text-fg"
                      onClick={() => {
                        setReplacingKey(true);
                        setTimeout(() => keyInputRef.current?.focus(), 0);
                      }}
                    >
                      Replace key
                    </button>
                  ) : null}
                </>
              ) : (
                (checks?.key.error ?? "The stored key could not be checked.")
              )}
            </HealthRow>

            <HealthRow state={checks?.testStore.ok ? "ok" : "attention"} title="Test purchases">
              {checks?.testStore.ok ? (
                "Simulator and development builds use RevenueCat's Test Store: simulated purchases, no Apple account, no real money."
              ) : (
                <>
                  This RevenueCat project has no Test Store, so purchases are switched off in the simulator.
                  In RevenueCat, open Apps and add a Test Store, then choose Check again.{" "}
                  {links ? <ExternalLink href={links.apps}>Open Apps</ExternalLink> : null}
                </>
              )}
            </HealthRow>

            <HealthRow
              state={checks?.webhook.ok ? "ok" : "attention"}
              title="Purchase events"
              action={
                data?.manualWebhook ? (
                  <div className="space-y-2">
                    <CopyField label="Webhook URL" value={data.manualWebhook.url} />
                    <CopyField label="Authorization header value" value={data.manualWebhook.authorizationHeader} />
                  </div>
                ) : null
              }
            >
              {checks?.webhook.mode === "automatic" ? (
                <>
                  Botflow added a webhook to your RevenueCat project, so purchases reach your app&apos;s
                  backend.
                  {checks.webhook.lastEventAt ? ` Last event ${timeAgo(checks.webhook.lastEventAt)}.` : ""}
                </>
              ) : checks?.webhook.ok ? (
                <>
                  Your webhook is delivering events.
                  {checks.webhook.lastEventAt ? ` Last event ${timeAgo(checks.webhook.lastEventAt)}.` : ""}
                </>
              ) : (
                <>
                  Botflow could not add the webhook itself
                  {checks?.webhook.error ? ` (${checks.webhook.error})` : ""}. Add it in RevenueCat under
                  Integrations, Webhooks, with the two values below, then choose Check again.{" "}
                  {links ? <ExternalLink href={links.integrations}>Open Integrations</ExternalLink> : null}
                </>
              )}
            </HealthRow>

            <HealthRow
              state={backendState === "live" ? "ok" : backendState === "unknown" ? "pending" : "attention"}
              title="Your app's backend"
            >
              {backendState === "live"
                ? "Listening for purchase events."
                : backendState === "not-deployed"
                  ? "The code that receives purchase events is in your project but not deployed yet. Purchases still unlock in the app; the backend just does not hear about them."
                  : backendState === "not-configured"
                    ? "The receiver is deployed but its secret is missing. Choose Check again to set it."
                    : backendState === "no-backend"
                      ? "This project has no backend deployed yet. Purchases still unlock in the app, but nothing records them on the server. If the agent cannot deploy it, check in Settings that your Convex account is connected and has room for another project."
                      : "Could not reach the backend just now. Choose Check again in a moment."}
            </HealthRow>
          </div>
        </Section>

        <Section
          title="What your app sells"
          aside={links ? <span className="text-xs"><ExternalLink href={links.products}>Edit in RevenueCat</ExternalLink></span> : null}
        >
          {catalogError ? (
            <p role="alert" className="py-3 text-xs text-warning">{catalogError}</p>
          ) : !catalog ? (
            <div className="flex items-center gap-2 py-3 text-xs text-muted">
              <Loader2 size={13} className="animate-spin" /> Loading products…
            </div>
          ) : catalog.products.length === 0 ? (
            <p className="py-3 text-xs leading-relaxed text-muted">
              Nothing yet. Tell the agent what to sell, for example &quot;add a Pro subscription for $4.99
              a month&quot;, and it creates the product, its price and the paywall.
            </p>
          ) : (
            <div className="space-y-3 py-3">
              {onPaywall.length === 0 ? (
                <p className="text-xs leading-relaxed text-muted">None of the products is on the paywall yet.</p>
              ) : null}
              <ul className={cn("divide-y divide-border rounded-lg border border-border bg-surface", onPaywall.length === 0 && "hidden")}>
                {onPaywall.map((product) => (
                  <li key={product.identifier} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-fg">
                        {product.displayName || product.identifier}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted">{product.identifier}</div>
                    </div>
                    <div className="text-xs text-muted">
                      {PRODUCT_TYPE_LABELS[product.type] ?? product.type}
                      {product.duration && DURATION_LABELS[product.duration] ? `, ${DURATION_LABELS[product.duration]}` : ""}
                    </div>
                    <div className="text-xs tabular-nums text-fg">
                      {product.testPrice
                        ? `${product.testPrice.currency === "USD" ? "$" : ""}${product.testPrice.amount.toFixed(2)}${product.testPrice.currency === "USD" ? "" : ` ${product.testPrice.currency}`} test`
                        : "No test price"}
                    </div>
                    <div className="text-xs text-muted">
                      {product.entitlements.length > 0 ? `Unlocks ${product.entitlements.join(", ")}` : "Unlocks nothing"}
                    </div>
                  </li>
                ))}
              </ul>
              {currentOffering ? (
                <p className="text-xs leading-relaxed text-muted">
                  These are the products in <Strong>{currentOffering.identifier}</Strong>, the offering your
                  paywall shows.
                </p>
              ) : null}
              {offPaywall.length > 0 ? (
                <p className="text-xs leading-relaxed text-muted">
                  Also in RevenueCat but not for sale in the app:{" "}
                  {offPaywall.map((p, i) => (
                    <span key={p.identifier}>
                      {i > 0 ? ", " : ""}
                      <code className="font-mono text-[11px]">{p.identifier}</code>
                    </span>
                  ))}
                  .
                </p>
              ) : null}
              {blockers.length > 0 ? (
                <div role="alert" className="space-y-1.5 rounded-lg border border-warning-border bg-warning-soft p-3">
                  <div className="text-xs font-semibold text-warning">
                    {blockers.length === 1 ? "One thing stops purchases from working" : `${blockers.length} things stop purchases from working`}
                  </div>
                  <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-warning">
                    {blockers.map((issue, i) => (
                      <li key={`${issue.code}-${i}`}>{issue.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {warnings.length > 0 ? (
                <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted">
                  {warnings.map((issue, i) => (
                    <li key={`${issue.code}-${i}`}>{issue.message}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </Section>

        <Section
          title="Activity"
          aside={
            links ? <span className="text-xs"><ExternalLink href={links.customers}>Customers in RevenueCat</ExternalLink></span> : null
          }
        >
          {activity === null ? (
            <div className="flex items-center gap-2 py-3 text-xs text-muted">
              <Loader2 size={13} className="animate-spin" /> Loading…
            </div>
          ) : activity.length === 0 ? (
            <p className="py-3 text-xs leading-relaxed text-muted">
              No purchases yet. A test purchase in the simulator appears here within a few seconds.
            </p>
          ) : (
            <ul className="space-y-1.5 py-3">
              {activity.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs"
                >
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold",
                      item.environment === "PRODUCTION" ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
                    )}
                  >
                    {item.environment === "PRODUCTION" ? "LIVE" : "TEST"}
                  </span>
                  <span className="shrink-0 font-medium text-fg">
                    {(item.rcEventType ? RC_EVENT_LABELS[item.rcEventType] : undefined) ?? EVENT_LABELS[item.type] ?? item.type}
                  </span>
                  <span className="min-w-0 truncate text-muted">{item.productId ?? ""}</span>
                  {typeof item.price === "number" && item.price > 0 ? (
                    <span className="shrink-0 tabular-nums text-muted">
                      {item.price.toFixed(2)} {item.currency ?? ""}
                    </span>
                  ) : null}
                  <span className="ml-auto shrink-0">
                    {item.delivery.status === "delivered" ? (
                      <span className="inline-flex items-center gap-1 text-success">
                        <CircleCheck size={13} aria-hidden /> Reached your backend
                      </span>
                    ) : item.delivery.status === "exhausted" ? (
                      <span className="text-danger" title={item.delivery.lastError ?? undefined}>
                        Backend never accepted it
                      </span>
                    ) : item.delivery.lastError === "no_convex_site" ? (
                      <span className="text-warning">No backend to deliver to yet</span>
                    ) : (
                      <span className="text-warning" title={item.delivery.lastError ?? undefined}>
                        Retrying delivery to your backend
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-muted">{timeAgo(item.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <details className="group rounded-xl border border-border bg-elevated/40">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-sm font-semibold text-fg">Selling for real on the App Store</span>
            <span className="text-xs text-muted">
              {checks?.appStore.ok ? "App Store key found" : "Not needed until you publish"}
            </span>
          </summary>
          <div className="space-y-2 border-t border-border px-4 py-3 text-xs leading-relaxed text-muted">
            <p>
              Test mode needs none of this. Before your first App Store release, with a paid Apple
              Developer account:
            </p>
            <ol className="list-decimal space-y-1.5 pl-4">
              <li>
                In RevenueCat, open Apps and add an App Store app with your app&apos;s bundle ID, then add
                the in-app purchase key it asks for.{" "}
                {links ? <ExternalLink href={links.apps}>Open Apps</ExternalLink> : null}
              </li>
              <li>
                In App Store Connect, create each product with the same ID
                {onPaywall.length > 0 ? (
                  <>
                    {" "}
                    (
                    {onPaywall.map((p, i) => (
                      <span key={p.identifier}>
                        {i > 0 ? ", " : ""}
                        <code className="font-mono text-fg">{p.identifier}</code>
                      </span>
                    ))}
                    )
                  </>
                ) : null}{" "}
                and set its real price.
              </li>
              <li>
                Come back and choose <Strong>Check again</Strong>, then ask the agent to register the
                products for the App Store.
              </li>
            </ol>
            <p>
              {checks?.appStore.ok
                ? "Botflow found your App Store app. Published builds use its key and sell the live products."
                : "Until Botflow finds an App Store app in this RevenueCat project, published builds ship with purchases switched off rather than in test mode."}
            </p>
          </div>
        </details>

        {isOwner ? (
          confirmingDisconnect ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>
                Disconnect? Botflow deletes the stored key and its webhook. Your RevenueCat products and
                customers stay as they are.
              </span>
              <Button variant="outline" size="sm" onClick={handleDisconnect}>
                Disconnect
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingDisconnect(false)}>
                Keep connected
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDisconnect(true)}
              className="text-xs text-muted hover:text-danger"
            >
              Disconnect RevenueCat from this project
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-xs font-semibold text-fg"
    >
      {n}
    </span>
  );
}

function Strong({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-fg">{children}</span>;
}
