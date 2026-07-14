"use client";

/**
 * RevenueCat payments tab (Swift workspace).
 *
 * One component, two states driven by the project's revenuecat_status:
 *   • 'connecting' → the BYO setup wizard (create RC project → paste keys →
 *     optional Apple key → copy webhook → verify). This replaces Stripe's OAuth
 *     modal — the whole connection flow lives here, and is resumable.
 *   • 'connected'  → a link-out page (RevenueCat's dashboard can't be iframed:
 *     X-Frame-Options: DENY), plus the webhook reminder and Disconnect.
 *
 * No data dashboard in this preliminary build — RevenueCat's own dashboard does
 * the heavy lifting.
 */
import { Input } from "@/components/ui/input";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  Loader2,
  ArrowUpRight,
  Copy,
  Check,
  CircleCheck,
  Circle,
  ExternalLink,
} from "lucide-react";

interface StatusResponse {
  ok: boolean;
  status: "none" | "connecting" | "connected";
  environment: "sandbox" | "production";
  rcProjectId: string | null;
  dashboardUrl: string;
  checklist: {
    keysProvided: boolean;
    connectionValid: boolean;
    testStoreReady: boolean;
    backendReady: boolean;
  };
  scaffold: {
    ok: boolean;
    envSet: boolean;
    routeWired: boolean;
    envError?: string;
    filesError?: string;
    at: string;
  } | null;
  connectionError: string | null;
  webhook: { url: string; authorizationHeader: string | null };
}

interface ActivityItem {
  id: string;
  type: string;
  productId: string | null;
  price: number | null;
  currency: string | null;
  environment: string | null;
  appUserId: string | null;
  delivery: { status: string; attempts: number; lastError: string | null };
  at: string;
}

const EVENT_LABELS: Record<string, string> = {
  "entitlement.granted": "Access granted",
  "entitlement.revoked": "Access ended",
  "entitlement.cancellation": "Auto-renew turned off",
  "billing.issue": "Billing issue",
};

/**
 * Fixed payment model for Swift apps (unlike web's Stripe test-mode toggle):
 * development is ALWAYS test mode, published builds are ALWAYS live. Shown in
 * both tab states so the divergence is never a surprise.
 */
function PaymentModeCard({ testStoreReady }: { testStoreReady?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-elevated/40 p-4 space-y-2">
      <h3 className="text-sm font-semibold text-fg">How payments run</h3>
      <div className="text-xs text-muted space-y-1.5">
        <p>
          <span className="font-medium text-fg">Development (simulator &amp; dev devices):</span>{" "}
          {testStoreReady ? (
            <>
              always <span className="text-amber-500 font-medium">test mode</span> — purchases are
              simulated through RevenueCat&apos;s Test Store. No Apple setup, no real money, ever.
            </>
          ) : (
            <>
              requires RevenueCat&apos;s <span className="text-amber-500 font-medium">Test Store</span>.
              Until it&apos;s ready, Botflow disables purchases in development rather than using a live key.
            </>
          )}
        </p>
        <p>
          <span className="font-medium text-fg">Published (App Store):</span> always{" "}
          <span className="text-emerald-500 font-medium">live</span> — your real App Store
          products, real money, once they pass App Review.
        </p>
        <p className="text-muted/80">
          There&apos;s no toggle: Botflow bakes the right RevenueCat key into each build kind
          automatically. A test build without Test Store setup disables purchases, and a store
          build can never ship in test mode.
        </p>
      </div>
    </div>
  );
}

interface RevenueCatTabProps {
  projectId: string;
  /** Top-level routing state from the project row. */
  status: "connecting" | "connected";
  /** Called after a successful connect/disconnect so the parent refreshes the project. */
  onChanged?: () => void;
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
      <label className="block text-xs text-muted mb-1">{label}</label>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 truncate rounded-md border border-border bg-surface px-3 py-2 text-xs text-fg font-mono">
          {value}
        </code>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded-md border border-border px-2.5 text-xs text-muted hover:text-fg bolt-hover"
          title="Copy"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}

function ChecklistRow({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {done ? (
        <CircleCheck size={16} className="text-emerald-500 shrink-0" />
      ) : (
        <Circle size={16} className="text-muted shrink-0" />
      )}
      <span className={done ? "text-fg" : "text-muted"}>{children}</span>
    </div>
  );
}

export function RevenueCatTab({ projectId, status, onChanged }: RevenueCatTabProps) {
  const { toast } = useToast();
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Wizard form fields.
  const [rcSecretKey, setRcSecretKey] = useState("");
  const [rcPublicSdkKey, setRcPublicSdkKey] = useState("");
  const [rcProjectId, setRcProjectId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Activity feed (connected state): recent entitlement events routed to this
  // project, from the platform's delivery log — no RevenueCat API calls.
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const loadActivity = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/revenuecat/activity`, { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { ok: boolean; items?: ActivityItem[] };
        if (body.ok && body.items) setActivity(body.items);
      }
    } catch {
      /* network blip */
    }
  }, [projectId]);
  useEffect(() => {
    if (status !== "connected") return;
    void loadActivity();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void loadActivity();
    }, 12_000);
    return () => clearInterval(interval);
  }, [status, loadActivity]);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/revenuecat/status`, {
        cache: "no-store",
      });
      const body = (await res.json().catch(() => null)) as StatusResponse | { error?: string } | null;
      if (res.ok && body) {
        setData(body as StatusResponse);
        setLoadError(null);
      } else {
        setLoadError(
          (body && "error" in body && body.error) ||
            `Payments status could not be loaded (HTTP ${res.status}).`,
        );
      }
    } catch {
      setLoadError("Payments status could not be loaded. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus, status]);

  const handleConnect = useCallback(async () => {
    if (!rcSecretKey.trim() || !rcPublicSdkKey.trim() || !rcProjectId.trim()) {
      toast({ title: "Missing keys", description: "Secret key, public SDK key, and project id are all required." });
      return;
    }
    setConnectError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/revenuecat/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rcSecretKey: rcSecretKey.trim(),
          rcPublicSdkKey: rcPublicSdkKey.trim(),
          rcProjectId: rcProjectId.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      toast({ title: "RevenueCat connected", description: `Linked project "${body.projectName ?? rcProjectId.trim()}".` });
      if (body.warning) {
        toast({ title: "Heads up", description: body.warning });
      }
      // Drop all pasted credentials from client state once stored server-side.
      setRcSecretKey("");
      setRcPublicSdkKey("");
      setConnectError(null);
      onChanged?.();
      await loadStatus();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setConnectError(message);
      toast({ title: "Couldn't connect", description: message });
    } finally {
      setSubmitting(false);
    }
  }, [projectId, rcSecretKey, rcPublicSdkKey, rcProjectId, toast, onChanged, loadStatus]);

  const handleVerify = useCallback(async () => {
    setVerifying(true);
    await loadStatus();
    setVerifying(false);
  }, [loadStatus]);

  // Re-run the Convex-side scaffold (receiver files + env + http route) when a
  // previous background attempt failed. initialize re-scaffolds for connected
  // projects; the scaffold write happens after the response, so re-check late.
  const [repairing, setRepairing] = useState(false);
  const handleRepairBackend = useCallback(async () => {
    setRepairing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/revenuecat/initialize`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Backend setup re-run", description: "Re-checking in a few seconds…" });
      setTimeout(() => void loadStatus(), 4000);
    } catch (e) {
      toast({ title: "Couldn't re-run setup", description: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setRepairing(false);
    }
  }, [projectId, toast, loadStatus]);

  const handleDisconnect = useCallback(async () => {
    if (!window.confirm("Turn off in-app purchases for this project? Your RevenueCat account stays linked for your other apps.")) {
      return;
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/revenuecat/disconnect`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      toast({ title: "Disconnected", description: "In-app purchases turned off for this project." });
      onChanged?.();
    } catch (e) {
      toast({ title: "Disconnect failed", description: e instanceof Error ? e.message : "Unknown error" });
    }
  }, [projectId, toast, onChanged]);

  const openDashboard = useCallback(() => {
    window.open(data?.dashboardUrl ?? "https://app.revenuecat.com", "_blank", "noopener,noreferrer");
  }, [data]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm gap-2">
        <Loader2 size={16} className="animate-spin" />
        Loading payments…
      </div>
    );
  }

  const webhookUrl = data?.webhook.url ?? "";
  const webhookSecret = data?.webhook.authorizationHeader ?? "";

  // ── Connected state ──────────────────────────────────────────────────────
  if (status === "connected") {
    return (
      <div className="h-full overflow-auto modern-scrollbar p-8">
        <div className="max-w-xl mx-auto space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-fg">In-app purchases</h2>
            <p className="text-sm text-muted mt-1">
              Your app is wired to RevenueCat. Revenue, customers, and subscription
              analytics live in the RevenueCat dashboard.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-elevated/60 p-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">RevenueCat project</span>
              <code className="text-fg font-mono text-xs">{data?.rcProjectId ?? "—"}</code>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Environment</span>
              <span className="text-fg capitalize">{data?.environment ?? "sandbox"}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Connection</span>
              {data?.checklist.connectionValid ? (
                <span className="flex items-center gap-1 text-emerald-500"><CircleCheck size={14} /> Verified</span>
              ) : (
                <span className="text-amber-500">{data?.connectionError ?? "Unverified"}</span>
              )}
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Backend receiver</span>
              {data?.checklist.backendReady ? (
                <span className="flex items-center gap-1 text-emerald-500"><CircleCheck size={14} /> Ready</span>
              ) : (
                <span className="text-amber-500">Not set up</span>
              )}
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Test Store (simulator purchases)</span>
              {data?.checklist.testStoreReady ? (
                <span className="flex items-center gap-1 text-emerald-500"><CircleCheck size={14} /> Ready</span>
              ) : (
                <span className="text-amber-500">Enable in RevenueCat</span>
              )}
            </div>
          </div>

          <PaymentModeCard testStoreReady={data?.checklist.testStoreReady} />

          {data && !data.checklist.testStoreReady && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-1">
              <p className="text-xs text-amber-500">
                Your RevenueCat project has no Test Store, so the simulator can&apos;t make
                test purchases yet. Botflow keeps purchases disabled in development until
                it&apos;s ready. Enable it in RevenueCat (Project settings → Apps → Test Store),
                then re-run setup below.
              </p>
              <Button variant="outline" size="sm" onClick={handleRepairBackend} disabled={repairing}>
                {repairing ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
                Re-run setup
              </Button>
            </div>
          )}

          {data && !data.checklist.backendReady && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
              <p className="text-xs text-amber-500">
                The webhook receiver isn&apos;t fully set up on your app&apos;s backend, so
                purchase events can&apos;t update entitlements yet
                {data.scaffold?.envError ? ` (${data.scaffold.envError})` : ""}
                {data.scaffold?.filesError ? ` (${data.scaffold.filesError})` : ""}.
              </p>
              <Button variant="outline" size="sm" onClick={handleRepairBackend} disabled={repairing}>
                {repairing ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
                Re-run backend setup
              </Button>
            </div>
          )}

          <Button onClick={openDashboard} className="w-full font-semibold">
            <ExternalLink size={16} className="mr-1.5" />
            Open RevenueCat Dashboard
          </Button>

          {/* Activity feed — the platform's own delivery log, not the RC API. */}
          <div className="rounded-xl border border-border bg-elevated/40 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-fg">Activity</h3>
              <button onClick={() => void loadActivity()} className="text-xs text-muted hover:text-fg">
                Refresh
              </button>
            </div>
            <p className="text-xs text-muted">
              Purchase and entitlement events routed to this app&apos;s backend.{" "}
              <span className="text-amber-500">
                Test-mode events are simulated — no real money changes hands.
              </span>
            </p>
            {activity === null ? (
              <div className="flex items-center gap-2 text-xs text-muted py-2">
                <Loader2 size={13} className="animate-spin" /> Loading…
              </div>
            ) : activity.length === 0 ? (
              <p className="text-xs text-muted py-2">
                No events yet. Make a test purchase in the simulator preview — it shows
                up here within seconds, along with whether it reached your backend.
              </p>
            ) : (
              <div className="space-y-1.5">
                {activity.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 rounded-md border border-border/60 bg-surface px-2.5 py-1.5 text-xs"
                  >
                    <span
                      className={
                        item.environment === "PRODUCTION"
                          ? "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-500/10 text-emerald-500"
                          : "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/10 text-amber-500"
                      }
                    >
                      {item.environment === "PRODUCTION" ? "LIVE" : "TEST"}
                    </span>
                    <span className="text-fg font-medium shrink-0">
                      {EVENT_LABELS[item.type] ?? item.type}
                    </span>
                    <span className="text-muted truncate">{item.productId ?? ""}</span>
                    {typeof item.price === "number" && item.price > 0 && (
                      <span className="text-muted shrink-0">
                        {item.price.toFixed(2)} {item.currency ?? ""}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-muted/80" title={`Delivery: ${item.delivery.status}${item.delivery.lastError ? ` — ${item.delivery.lastError}` : ""}`}>
                      {item.delivery.status === "delivered" ? (
                        <CircleCheck size={13} className="text-emerald-500" />
                      ) : item.delivery.status === "exhausted" ? (
                        <span className="text-red-400">failed</span>
                      ) : (
                        <span className="text-amber-500">retrying…</span>
                      )}
                    </span>
                    <span className="shrink-0 text-muted/70">
                      {new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {webhookUrl && webhookSecret && (
            <div className="rounded-xl border border-border bg-elevated/40 p-4 space-y-3">
              <p className="text-xs text-muted">
                Webhook (set under RevenueCat → Integrations → Webhooks so entitlement
                changes reach your backend):
              </p>
              <CopyField label="Webhook URL" value={webhookUrl} />
              <CopyField label="Authorization header" value={webhookSecret} />
            </div>
          )}

          <button
            onClick={handleDisconnect}
            className="text-xs text-muted hover:text-red-400"
          >
            Disconnect RevenueCat from this project
          </button>
        </div>
      </div>
    );
  }

  // ── Connecting state (setup wizard) ──────────────────────────────────────
  const cl = data?.checklist;
  return (
    <div className="h-full overflow-auto modern-scrollbar p-8">
      <div className="max-w-xl mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-fg">Set up in-app purchases</h2>
          <p className="text-sm text-muted mt-1">
            Botflow uses RevenueCat for iOS payments. Connect your own RevenueCat
            account below — you can leave and come back; this picks up where you left off.
          </p>
        </div>

        {loadError && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs text-amber-500">
            {loadError}
          </div>
        )}

        {/* Step checklist */}
        <div className="rounded-xl border border-border bg-elevated/60 p-4 space-y-2">
          <ChecklistRow done={Boolean(cl?.keysProvided)}>RevenueCat keys provided</ChecklistRow>
          <ChecklistRow done={Boolean(cl?.connectionValid)}>Connection verified</ChecklistRow>
          <ChecklistRow done={Boolean(cl?.testStoreReady)}>Test Store found (simulator test purchases)</ChecklistRow>
        </div>

        <PaymentModeCard testStoreReady={cl?.testStoreReady} />

        <div className="rounded-xl border border-accent/30 bg-accent/5 p-4 space-y-2.5">
          <div className="flex items-center gap-2">
            <ExternalLink size={15} className="text-accent shrink-0" />
            <h3 className="text-sm font-semibold text-fg">Start with RevenueCat Test Store</h3>
          </div>
          <p className="text-xs text-muted leading-relaxed">
            For a simulator or development build, you do not need App Store Connect first.
            RevenueCat creates a Test Store for every project. In <span className="text-fg">Project settings → API keys</span>,
            create a secret key, then copy the Test Store SDK key that starts with <code className="text-fg">test_</code>.
            Use the project ID from the RevenueCat dashboard URL below.
          </p>
          <a
            href="https://production-docs.revenuecat.com/docs/getting-started/configuring-sdk"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
          >
            <ArrowUpRight size={14} /> Follow RevenueCat&apos;s Test Store setup guide
          </a>
        </div>

        {/* Step 1 */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-fg">1. Create a RevenueCat project</h3>
          <p className="text-xs text-muted">
            Sign in to RevenueCat and create a project. For test purchases, use its built-in
            Test Store — an App Store app and <code className="text-fg">appl_</code> key are only needed when you prepare a release.
          </p>
          <button
            onClick={() => window.open("https://app.revenuecat.com", "_blank", "noopener,noreferrer")}
            className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
          >
            <ArrowUpRight size={14} /> Open RevenueCat
          </button>
        </div>

        {/* Step 2 */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-fg">2. Paste your keys</h3>
          <p className="text-xs text-muted">
            Use a <code className="text-fg">sk_</code> secret key and the <code className="text-fg">test_</code> Test Store key for simulator testing.
            Botflow keeps the test key out of App Store builds.
          </p>
          <Field label="Secret key (sk_…)" value={rcSecretKey} onChange={setRcSecretKey} placeholder="sk_xxxxxxxx" mono type="password" />
          <Field label="SDK key (appl_… or test_…)" value={rcPublicSdkKey} onChange={setRcPublicSdkKey} placeholder="appl_xxxxxxxx or test_xxxxxxxx" mono />
          <Field label="Project ID (from the RevenueCat dashboard URL)" value={rcProjectId} onChange={setRcProjectId} placeholder="820f9fc3" mono />

          <div className="flex items-center gap-2 pt-1">
            <Button onClick={handleConnect} disabled={submitting} className="font-semibold">
              {submitting ? <Loader2 size={16} className="mr-1.5 animate-spin" /> : null}
              {submitting ? "Connecting…" : "Connect RevenueCat"}
            </Button>
            <Button variant="outline" onClick={handleVerify} disabled={verifying}>
              {verifying ? <Loader2 size={16} className="mr-1.5 animate-spin" /> : null}
              Verify
            </Button>
          </div>
          {(connectError || data?.connectionError) && (
            <p className="text-xs text-amber-500">{connectError || data?.connectionError}</p>
          )}
        </div>

        {/* Step 3 */}
        {webhookUrl && webhookSecret && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-fg">3. Add the webhook in RevenueCat</h3>
            <p className="text-xs text-muted">
              RevenueCat → Integrations → Webhooks. Paste these so entitlement changes
              reach your Convex backend.
            </p>
            <CopyField label="Webhook URL" value={webhookUrl} />
            <CopyField label="Authorization header" value={webhookSecret} />
          </div>
        )}

        <button
          onClick={handleDisconnect}
          className="text-xs text-muted hover:text-red-400"
        >
          Cancel setup
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-muted mb-1">{label}</label>
      <Input
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg ${mono ? "font-mono text-xs" : ""}`}
      />
    </div>
  );
}
