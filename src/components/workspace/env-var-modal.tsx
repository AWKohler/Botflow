"use client";

import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, X } from "lucide-react";

interface EnvVarModalProps {
  requestId: string;
  projectId: string;
  /** 'client' → frontend Vite .env; 'server' → Convex deployment env. */
  target: "client" | "server";
  /** Variable name chosen by the agent — read-only in this modal. */
  envKey: string;
  /** Optional agent-authored explanation. */
  message: string | null;
  isSecret: boolean;
  /** Called after a successful save OR a dismiss — clears the modal. */
  onClose: () => void;
}

/**
 * Modal shown when the agent calls requestEnvVar. The agent decides the
 * variable NAME and target; the user supplies only the VALUE. Saving writes
 * the value server-side (Vite .env or Convex deployment) — it never flows
 * through the agent. Dismissing (X / Cancel) tells the agent the user
 * declined.
 */
export function EnvVarModal({
  requestId,
  projectId,
  target,
  envKey,
  message,
  isSecret,
  onClose,
}: EnvVarModalProps) {
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(!isSecret);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetLabel =
    target === "server" ? "Backend · Convex deployment" : "Frontend · Vite .env";

  const handleDismiss = () => {
    // Fire-and-forget — the agent's poll sees status='dismissed' within ~2.5s.
    fetch(`/api/projects/${projectId}/env/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, dismissed: true }),
    }).catch(() => {});
    onClose();
  };

  const handleSave = async () => {
    if (!value.trim()) {
      setError("A value is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/env/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, value }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        agentWaiting?: boolean;
      };
      if (!data.ok) {
        setError(data.error ?? "Failed to save. Please try again.");
        return;
      }
      // Agent no longer waiting on this request → send it a system-note so
      // it learns the value arrived (see AgentPanel's listener).
      if (data.agentWaiting === false) {
        window.dispatchEvent(
          new CustomEvent("agent-modal-completed", {
            detail: { projectId, kind: "env-var", subject: envKey },
          }),
        );
      }
      onClose();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-lg bg-surface border border-border rounded-2xl shadow-2xl mx-4 overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b border-border">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-accent/15 text-accent shrink-0">
            <KeyRound size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-fg">Set an environment variable</h2>
            <p className="text-xs text-muted mt-0.5">
              The assistant needs a value from you to continue.
            </p>
          </div>
          <button
            onClick={handleDismiss}
            className="shrink-0 text-muted hover:text-fg hover:bg-elevated rounded-lg p-1.5 transition-colors"
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {message && (
            <p className="text-sm text-fg/90 leading-relaxed bg-elevated border border-border rounded-lg px-3 py-2.5">
              {message}
            </p>
          )}

          {/* Name (read-only) + target badge */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted">Variable</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-fg font-mono break-all">
                {envKey}
              </code>
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted bg-elevated border border-border rounded-md px-2 py-1.5">
                {targetLabel}
              </span>
            </div>
          </div>

          {/* Value input */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted">Value</label>
            <div className="relative">
              <Input
                type={revealed ? "text" : "password"}
                value={value}
                onChange={(e) => { setValue(e.target.value); setError(null); }}
                placeholder="Paste the value here"
                className="w-full bg-elevated border border-border rounded-lg pl-3 pr-9 py-2 text-sm text-fg placeholder:text-muted outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/50 transition-colors font-mono"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setRevealed((r) => !r)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-fg transition-colors"
                aria-label={revealed ? "Hide value" : "Show value"}
              >
                {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <p className="text-[11px] text-muted leading-relaxed">
              {target === "client"
                ? "Heads up: frontend variables are bundled into your app and visible to anyone who uses it (and readable by the assistant). Don't enter a real secret here — for API keys or tokens, ask for a backend (server) variable instead."
                : isSecret
                  ? "Stored as a secret on your Convex backend — never exposed to the frontend, the sandbox, or the assistant."
                  : "Saved on your Convex backend — never exposed to the frontend, the sandbox, or the assistant."}
            </p>
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 pb-6">
          <button
            onClick={handleDismiss}
            className="text-sm text-muted hover:text-fg transition-colors"
          >
            Cancel — do this later
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !value.trim()}
            className="flex items-center gap-2 bg-accent text-accent-foreground text-sm font-medium rounded-lg px-4 py-2 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Saving…
              </>
            ) : (
              "Save Variable"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
