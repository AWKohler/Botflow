"use client";

import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, X, Sparkles, KeyRound, Lock, Check } from "lucide-react";
import { cn } from "@/lib/utils";

const CLOUD_CONVEX_FOR_ALL =
  process.env.NEXT_PUBLIC_ALLOW_CLOUD_CONVEX_FOR_ALL === "true";

const CONVEX_FORK_PROMPT =
  "I just created this project from a template. Run convexDeploy to deploy the backend (schema + functions) to the new Convex instance, then give me a one-line summary of what this app does.";

/**
 * "Use as template" → runs the real project-creation flow (name + Convex backend
 * gating + provisioning) by routing to /start with a seedSlug. Mirrors the
 * landing page's creation step. Only rendered for signed-in users.
 */
export function TemplateForkModal({
  slug,
  sourceName,
  usesConvex,
  onClose,
}: {
  slug: string;
  sourceName: string;
  usesConvex: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(`${sourceName} (copy)`.slice(0, 100));
  const [loading, setLoading] = useState(usesConvex);
  const [submitting, setSubmitting] = useState(false);
  const [tier, setTier] = useState<"free" | "pro" | "max">("free");
  const [hasConvexOAuth, setHasConvexOAuth] = useState(false);
  const [backend, setBackend] = useState<"platform" | "user">("platform");

  const managedLocked = tier === "free" && !CLOUD_CONVEX_FOR_ALL;

  useEffect(() => {
    if (!usesConvex) return;
    let cancelled = false;
    (async () => {
      try {
        const [planRes, settingsRes] = await Promise.all([
          fetch("/api/user/plan"),
          fetch("/api/user-settings"),
        ]);
        const plan = planRes.ok ? await planRes.json() : {};
        const settings = settingsRes.ok ? await settingsRes.json() : {};
        if (cancelled) return;
        const t = plan.tier === "pro" || plan.tier === "max" ? plan.tier : "free";
        setTier(t);
        setHasConvexOAuth(Boolean(settings.hasConvexOAuth));
        // Free users default to BYOC (platform-managed is Pro-only).
        setBackend(t === "free" && !CLOUD_CONVEX_FOR_ALL ? "user" : "platform");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [usesConvex]);

  // Escape to close
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const connectConvex = () => {
    window.location.href = `/api/oauth/convex/start?return_to=${encodeURIComponent(`/p/${slug}?fork=1`)}`;
  };

  const needsConnect = usesConvex && backend === "user" && !hasConvexOAuth;
  const canSubmit = !submitting && !loading && name.trim().length > 0 && !needsConnect;

  const submit = () => {
    if (!canSubmit) return;
    const params = new URLSearchParams();
    params.set("seedSlug", slug);
    params.set("name", name.trim().slice(0, 100));
    params.set("platform", "sandboxed-web");
    if (usesConvex) {
      params.set("backendType", backend);
      params.set("model", "fireworks-minimax-m3"); // Minimax for the convexDeploy step
      params.set("prompt", CONVEX_FORK_PROMPT);
    } else {
      params.set("backendType", "none");
    }
    setSubmitting(true);
    router.push(`/start?${params.toString()}`);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-fg">Use as template</h2>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-elevated hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Project name</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              maxLength={100}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:ring-2 focus:ring-border"
              placeholder="My project"
            />
          </div>

          {usesConvex && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">Backend</label>
              {loading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading options…
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Botflow Managed (platform) */}
                  <button
                    type="button"
                    onClick={() => { if (!managedLocked) setBackend("platform"); }}
                    className={cn(
                      "w-full rounded-xl border p-3 text-left transition",
                      backend === "platform" && !managedLocked ? "border-accent bg-accent/10" : "border-border bg-bg hover:bg-elevated",
                      managedLocked && "opacity-70",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src="/convex-color.svg" className={cn("h-4 w-4", managedLocked && "grayscale")} alt="" />
                      <span className="text-sm font-medium text-fg">Botflow Managed</span>
                      {managedLocked && (
                        <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                          <Lock className="h-2.5 w-2.5" /> Pro
                        </span>
                      )}
                      {backend === "platform" && !managedLocked && <Check className="ml-auto h-4 w-4 text-accent" />}
                    </div>
                    <p className="mt-1 text-[11px] text-muted">
                      {managedLocked ? "A managed Convex backend, included on Pro & Max." : "We provision and manage the Convex backend for you."}
                    </p>
                    {managedLocked && (
                      <a
                        href="/pricing"
                        onClick={(e) => e.stopPropagation()}
                        className="mt-2 inline-flex items-center gap-1 rounded-lg bg-fg px-2.5 py-1 text-[11px] font-medium text-bg hover:opacity-90"
                      >
                        Upgrade to Pro
                      </a>
                    )}
                  </button>

                  {/* Bring Your Own Convex (user) */}
                  <button
                    type="button"
                    onClick={() => setBackend("user")}
                    className={cn(
                      "w-full rounded-xl border p-3 text-left transition",
                      backend === "user" ? "border-accent bg-accent/10" : "border-border bg-bg hover:bg-elevated",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <KeyRound className="h-4 w-4 text-fg" />
                      <span className="text-sm font-medium text-fg">Bring Your Own Convex</span>
                      {backend === "user" && hasConvexOAuth && <Check className="ml-auto h-4 w-4 text-accent" />}
                    </div>
                    <p className="mt-1 text-[11px] text-muted">Provision in your own Convex account — free.</p>
                    {backend === "user" && !hasConvexOAuth && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); connectConvex(); }}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 py-1 text-[11px] font-medium text-fg hover:bg-soft"
                      >
                        Connect Convex
                      </button>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <button onClick={onClose} className="rounded-lg border border-border bg-bg px-3.5 py-2 text-sm font-medium text-fg hover:bg-elevated">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-lg bg-fg px-3.5 py-2 text-sm font-medium text-bg shadow hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {needsConnect ? "Connect Convex first" : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );
}
