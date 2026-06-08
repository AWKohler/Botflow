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
    appleKeyProvided: boolean;
  };
  connectionError: string | null;
  webhook: { url: string; authorizationHeader: string | null };
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
  const [verifying, setVerifying] = useState(false);

  // Wizard form fields.
  const [rcSecretKey, setRcSecretKey] = useState("");
  const [rcPublicSdkKey, setRcPublicSdkKey] = useState("");
  const [rcProjectId, setRcProjectId] = useState("");
  const [showApple, setShowApple] = useState(false);
  const [ascIssuerId, setAscIssuerId] = useState("");
  const [ascKeyId, setAscKeyId] = useState("");
  const [ascPrivateKeyP8, setAscPrivateKeyP8] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/revenuecat/status`, {
        cache: "no-store",
      });
      if (res.ok) setData((await res.json()) as StatusResponse);
    } catch {
      /* network blip */
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
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/revenuecat/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rcSecretKey: rcSecretKey.trim(),
          rcPublicSdkKey: rcPublicSdkKey.trim(),
          rcProjectId: rcProjectId.trim(),
          ...(ascIssuerId.trim() ? { ascIssuerId: ascIssuerId.trim() } : {}),
          ...(ascKeyId.trim() ? { ascKeyId: ascKeyId.trim() } : {}),
          ...(ascPrivateKeyP8.trim() ? { ascPrivateKeyP8: ascPrivateKeyP8.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      toast({ title: "RevenueCat connected", description: `Linked project "${body.projectName ?? rcProjectId.trim()}".` });
      setRcSecretKey("");
      onChanged?.();
      await loadStatus();
    } catch (e) {
      toast({ title: "Couldn't connect", description: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setSubmitting(false);
    }
  }, [projectId, rcSecretKey, rcPublicSdkKey, rcProjectId, ascIssuerId, ascKeyId, ascPrivateKeyP8, toast, onChanged, loadStatus]);

  const handleVerify = useCallback(async () => {
    setVerifying(true);
    await loadStatus();
    setVerifying(false);
  }, [loadStatus]);

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
          </div>

          <Button onClick={openDashboard} className="w-full font-semibold">
            <ExternalLink size={16} className="mr-1.5" />
            Open RevenueCat Dashboard
          </Button>

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

        {/* Step checklist */}
        <div className="rounded-xl border border-border bg-elevated/60 p-4 space-y-2">
          <ChecklistRow done={Boolean(cl?.keysProvided)}>RevenueCat keys provided</ChecklistRow>
          <ChecklistRow done={Boolean(cl?.connectionValid)}>Connection verified</ChecklistRow>
          <ChecklistRow done={Boolean(cl?.appleKeyProvided)}>Apple App Store Connect key (optional, for product automation)</ChecklistRow>
        </div>

        {/* Step 1 */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-fg">1. Create a RevenueCat project</h3>
          <p className="text-xs text-muted">
            Sign in to RevenueCat and create a project with an App Store app. Then open
            its API keys.
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
          <Field label="Secret key (sk_…)" value={rcSecretKey} onChange={setRcSecretKey} placeholder="sk_xxxxxxxx" mono type="password" />
          <Field label="Public SDK key (appl_…)" value={rcPublicSdkKey} onChange={setRcPublicSdkKey} placeholder="appl_xxxxxxxx" mono />
          <Field label="Project id (proj…)" value={rcProjectId} onChange={setRcProjectId} placeholder="proj1a2b3c4d" mono />

          <button
            onClick={() => setShowApple((s) => !s)}
            className="text-xs text-muted hover:text-fg"
          >
            {showApple ? "− Hide" : "+ Add"} Apple App Store Connect key (optional)
          </button>
          {showApple && (
            <div className="space-y-3 border-l-2 border-border pl-3">
              <p className="text-xs text-muted">
                Lets Botflow create your in-app products in App Store Connect for you.
                You can also add this later in RevenueCat directly.
              </p>
              <Field label="Issuer ID" value={ascIssuerId} onChange={setAscIssuerId} placeholder="69a6de7e-…" mono />
              <Field label="Key ID" value={ascKeyId} onChange={setAscKeyId} placeholder="ABC123DEFG" mono />
              <div>
                <label className="block text-xs text-muted mb-1">Private key (.p8 contents)</label>
                <textarea
                  value={ascPrivateKeyP8}
                  onChange={(e) => setAscPrivateKeyP8(e.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----"
                  rows={4}
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-xs text-fg font-mono modern-scrollbar"
                />
              </div>
            </div>
          )}

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
          {data?.connectionError && (
            <p className="text-xs text-amber-500">{data.connectionError}</p>
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
      <input
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg ${mono ? "font-mono text-xs" : ""}`}
      />
    </div>
  );
}
