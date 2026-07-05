"use client";

import { Input } from "@/components/ui/input";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Globe,
  Loader2,
  ExternalLink,
  Copy,
  Check,
  AlertCircle,
  Trash2,
  Lock,
  Sparkles,
  Rocket,
  Wand2,
  X,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

type PublishState = "idle" | "building" | "published" | "error";
type DomainStatus = "pending" | "active" | "error" | null;

interface ManagedDomainOption {
  id: string;
  apexDomain: string;
  status: "pending_ns" | "active" | "error";
}

interface SandboxPublishPanelProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  cloudflareProjectName: string | null;
  cloudflareDeploymentUrl: string | null;
  isPublic: boolean;
  publicSlug: string | null;
  publicDescription: string | null;
  /** slug is passed when it was (re)generated on publish. */
  onPublicChanged: (isPublic: boolean, slug?: string | null) => void;
  onPublished: (name: string, url: string) => void;
  onUnpublished: () => void;
  canUseCustomDomain: boolean;
  managedDomainsEnabled: boolean;
  managedDomainId: string | null;
  managedDomainHostname: string | null;
  onManagedDomainChanged: (id: string | null, hostname: string | null) => void;
  customDomain: string | null;
  customDomainStatus: DomainStatus;
  onCustomDomainChanged: (domain: string | null, status: DomainStatus) => void;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-muted hover:text-fg hover:bg-soft transition"
    >
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function SandboxPublishPanel({
  projectId,
  isOpen,
  onClose,
  anchorRef,
  cloudflareProjectName,
  cloudflareDeploymentUrl,
  isPublic,
  publicSlug,
  publicDescription,
  onPublicChanged,
  onPublished,
  onUnpublished,
  canUseCustomDomain,
  managedDomainsEnabled,
  managedDomainId: _managedDomainId,
  managedDomainHostname,
  onManagedDomainChanged,
  customDomain,
  customDomainStatus,
  onCustomDomainChanged,
}: SandboxPublishPanelProps) {
  const initial: PublishState = cloudflareProjectName ? "published" : "idle";
  const [state, setState] = useState<PublishState>(initial);

  // Public/showcase opt-in for the next deploy. Off by default; mirrors the
  // project's current public state once metadata loads.
  const [listPublic, setListPublic] = useState(isPublic);
  const [publicDesc, setPublicDesc] = useState(publicDescription ?? "");
  const [currentSlug, setCurrentSlug] = useState<string | null>(publicSlug);
  useEffect(() => { setListPublic(isPublic); }, [isPublic]);
  useEffect(() => { setPublicDesc(publicDescription ?? ""); }, [publicDescription]);
  useEffect(() => { setCurrentSlug(publicSlug); }, [publicSlug]);

  // The workspace fetches project metadata asynchronously, so cloudflareProjectName
  // can flip from null → set after the panel mounts. Reflect that in the panel's
  // state so the "published" view shows up without a manual refresh.
  useEffect(() => {
    if (cloudflareProjectName && state === "idle") setState("published");
    if (!cloudflareProjectName && state === "published") setState("idle");
  }, [cloudflareProjectName, state]);
  const [logs, setLogs] = useState<string[]>([]);
  const [statusLine, setStatusLine] = useState<string>("");
  const [errorOutput, setErrorOutput] = useState<string>("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const [domainTab, setDomainTab] = useState<"managed" | "cname">(
    managedDomainHostname ? "managed" : (customDomain ? "cname" : "managed"),
  );

  // Managed domain list
  const [managedOptions, setManagedOptions] = useState<ManagedDomainOption[] | null>(null);
  const [selectedDomainId, setSelectedDomainId] = useState<string>("");
  const [selectedSubdomain, setSelectedSubdomain] = useState<string>("www");
  const [mirrorToOther, setMirrorToOther] = useState<boolean>(true);
  const [managedBusy, setManagedBusy] = useState(false);
  const [managedErr, setManagedErr] = useState<string | null>(null);

  // CNAME state (legacy)
  const [cnameInput, setCnameInput] = useState<string>(customDomain ?? "");
  const [cnameBusy, setCnameBusy] = useState(false);
  const [cnameErr, setCnameErr] = useState<string | null>(null);

  // Position panel under the anchor button
  useEffect(() => {
    if (!isOpen) return;
    const a = anchorRef.current;
    if (!a) return;
    const update = () => {
      const r = a.getBoundingClientRect();
      setPosition({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [isOpen, anchorRef]);

  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [isOpen, onClose]);

  // Auto-scroll logs
  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [logs]);

  // Load managed-domain options
  useEffect(() => {
    if (!isOpen || !managedDomainsEnabled) return;
    fetch("/api/domains").then(r => r.json()).then((j: { domains: ManagedDomainOption[] }) => {
      setManagedOptions(j.domains ?? []);
      if (!selectedDomainId && j.domains?.length) {
        setSelectedDomainId(j.domains.find(d => d.status === "active")?.id ?? j.domains[0].id);
      }
    }).catch(() => setManagedOptions([]));
  }, [isOpen, managedDomainsEnabled, selectedDomainId]);

  // Cleanup EventSource on unmount/close
  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

  const startBuild = useCallback(() => {
    setState("building");
    setLogs([]);
    setStatusLine("Connecting to sandbox...");
    setErrorOutput("");
    // POST → SSE. Browsers can't open a streaming POST with EventSource directly.
    // Workaround: use fetch() with a streaming reader.
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/sandbox/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public: listPublic, description: publicDesc.trim() || undefined }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const txt = await res.text().catch(() => "");
          setErrorOutput(txt || `HTTP ${res.status}`);
          setState("error");
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE events are separated by blank lines
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const block of parts) {
            const lines = block.split("\n");
            let event = "message";
            let data = "";
            for (const ln of lines) {
              if (ln.startsWith("event: ")) event = ln.slice(7).trim();
              else if (ln.startsWith("data: ")) data += (data ? "\n" : "") + ln.slice(6);
            }
            const decoded = data.replace(/\\n/g, "\n");
            if (event === "output") {
              setLogs((prev) => {
                const next = [...prev, stripAnsi(decoded)];
                return next.length > 500 ? next.slice(-500) : next;
              });
            } else if (event === "status") {
              setStatusLine(decoded);
            } else if (event === "build_error") {
              setErrorOutput(stripAnsi(decoded));
              setState("error");
              return;
            } else if (event === "published") {
              try {
                const j = JSON.parse(decoded) as { url: string; projectName: string };
                onPublished(j.projectName, j.url);
                setState("published");
              } catch {
                setState("error");
                setErrorOutput("Failed to parse publish response");
              }
              // Don't return — the public-visibility reconcile streams next.
            } else if (event === "public_listed") {
              try {
                const j = JSON.parse(decoded) as { isPublic: boolean; slug: string | null };
                setCurrentSlug(j.slug);
                onPublicChanged(j.isPublic, j.slug);
              } catch { /* non-fatal */ }
            } else if (event === "public_error") {
              // Deploy succeeded but bundling/visibility failed — surface softly.
              setStatusLine(`Published, but public listing failed: ${decoded}`);
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setErrorOutput(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    })();
    eventSourceRef.current = { close: () => ctrl.abort() } as unknown as EventSource;
  }, [projectId, onPublished, onPublicChanged, listPublic, publicDesc]);

  const cancelBuild = () => {
    eventSourceRef.current?.close();
    setState("idle");
  };

  const fixWithAgent = () => {
    const prompt = `Build failed:\n\n${errorOutput}\n\nPlease fix the errors, then run \`pnpm run build\` to confirm everything builds successfully.`;
    window.dispatchEvent(new CustomEvent("sandbox-build-error-delegate", {
      detail: { projectId, prompt },
    }));
    onClose();
  };

  const unpublish = async () => {
    if (!confirm("Unpublish this site? The .pages.dev URL will stop serving.")) return;
    const res = await fetch(`/api/projects/${projectId}/publish`, { method: "DELETE" });
    if (res.ok) {
      onUnpublished();
      setState("idle");
      onManagedDomainChanged(null, null);
      onCustomDomainChanged(null, null);
    }
  };

  const assignManagedDomain = async () => {
    setManagedBusy(true); setManagedErr(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/managed-domain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domainId: selectedDomainId,
          subdomain: selectedSubdomain,
          mirrorToOther,
        }),
      });
      const j = await res.json();
      if (!res.ok) { setManagedErr(j.error ?? "Failed"); return; }
      onManagedDomainChanged(selectedDomainId, j.hostname);
      onPublished(cloudflareProjectName ?? "", j.url);
    } catch (e) {
      setManagedErr(e instanceof Error ? e.message : String(e));
    } finally { setManagedBusy(false); }
  };

  const detachManagedDomain = async () => {
    if (!confirm("Detach this domain from the project?")) return;
    const res = await fetch(`/api/projects/${projectId}/managed-domain`, { method: "DELETE" });
    if (res.ok) {
      const j = (await res.json().catch(() => ({}))) as { url?: string | null };
      onManagedDomainChanged(null, null);
      // The server decides the fallback URL (white-label branded domain, or
      // .pages.dev when unconfigured) — don't reconstruct it client-side.
      const fallback = j.url ?? (cloudflareProjectName ? `https://${cloudflareProjectName}.pages.dev` : "");
      onPublished(cloudflareProjectName ?? "", fallback);
    }
  };

  const attachCname = async () => {
    setCnameBusy(true); setCnameErr(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/custom-domain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: cnameInput.trim() }),
      });
      const j = await res.json();
      if (!res.ok) { setCnameErr(j.error ?? "Failed"); return; }
      onCustomDomainChanged(j.domain ?? cnameInput.trim(), j.status ?? "pending");
    } catch (e) {
      setCnameErr(e instanceof Error ? e.message : String(e));
    } finally { setCnameBusy(false); }
  };

  const removeCname = async () => {
    if (!confirm("Remove custom CNAME domain?")) return;
    const res = await fetch(`/api/projects/${projectId}/custom-domain`, { method: "DELETE" });
    if (res.ok) {
      onCustomDomainChanged(null, null);
      setCnameInput("");
    }
  };

  if (!isOpen || typeof document === "undefined") return null;

  // Public/showcase opt-in — applied on the next Build & publish. Off by default.
  const publicToggle = (
    <div className="rounded-xl border border-border bg-bg/50 p-3 space-y-2">
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={listPublic}
          onChange={(e) => setListPublic(e.target.checked)}
          className="mt-0.5 rounded border-border"
        />
        <span className="text-xs text-fg">
          List publicly in Explore
          <span className="block text-[10px] text-muted mt-0.5">
            Saves a read-only snapshot of your code. Anyone can view the live site and source, or use it as a template. Applied when you deploy.
          </span>
        </span>
      </label>
      {listPublic && (
        <Input
          type="text"
          value={publicDesc}
          onChange={(e) => setPublicDesc(e.target.value)}
          maxLength={140}
          placeholder="Short description (optional)"
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-xs text-fg focus:border-emerald-500/50 focus:outline-none"
        />
      )}
      {listPublic && currentSlug && state === "published" && (
        <a
          href={`/p/${currentSlug}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400 hover:text-emerald-300"
        >
          <ExternalLink size={10} /> /p/{currentSlug}
        </a>
      )}
    </div>
  );

  const panel = (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 w-[420px] max-w-[calc(100vw-1rem)] rounded-2xl border border-border bg-elevated shadow-2xl overflow-hidden"
        style={position ? { top: position.top, right: position.right } : { top: 60, right: 16 }}
      >
        <div className="flex items-center justify-between border-b border-border bg-gradient-to-r from-emerald-500/10 to-emerald-500/5 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-emerald-500/15 p-1.5">
              <Globe className="h-4 w-4 text-emerald-400" />
            </div>
            <h3 className="text-sm font-semibold text-fg">Publish</h3>
            {state === "published" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300 border border-emerald-500/30">
                <Check size={10} /> Live
              </span>
            )}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-soft hover:text-fg">
            <X size={14} />
          </button>
        </div>

        <div className="max-h-[calc(100vh-120px)] overflow-y-auto">
          {state === "idle" && (
            <div className="p-5">
              <p className="mb-4 text-sm text-muted">
                Build your project in the sandbox and deploy it to Cloudflare Pages.
                We&apos;ll stream the build output here as it happens.
              </p>
              <div className="mb-4">{publicToggle}</div>
              <button
                onClick={startBuild}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-400 transition"
              >
                <Rocket size={15} /> Build &amp; publish
              </button>
            </div>
          )}

          {state === "building" && (
            <div className="p-4">
              <div className="mb-3 flex items-center gap-2 text-sm text-fg">
                <Loader2 size={14} className="animate-spin text-emerald-400" />
                <span className="font-medium">{statusLine || "Building..."}</span>
              </div>
              <div className="rounded-lg border border-border bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-emerald-200/90 max-h-[260px] overflow-y-auto">
                {logs.length === 0 && <div className="text-muted">Waiting for first line of output...</div>}
                {logs.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-words">{line}</div>
                ))}
                <div ref={logsEndRef} />
              </div>
              <div className="mt-3 flex justify-end">
                <button onClick={cancelBuild} className="rounded-lg border border-border bg-bg px-3 py-1.5 text-xs text-muted hover:text-fg hover:bg-soft transition">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {state === "error" && (
            <div className="p-4">
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold">Build failed</div>
                  <div className="text-[11px] text-red-300/70 mt-0.5">Review the output below or have the agent fix it.</div>
                </div>
              </div>
              <div className="rounded-lg border border-border bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-red-200/90 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words">
                {errorOutput || "(no output)"}
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button
                  onClick={fixWithAgent}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3 py-2 text-xs font-medium text-white hover:opacity-90 transition"
                >
                  <Wand2 size={12} /> Fix with Agent
                </button>
                <button
                  onClick={() => navigator.clipboard.writeText(errorOutput)}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-border bg-bg px-3 py-2 text-xs text-fg hover:bg-soft transition"
                >
                  <Copy size={12} /> Copy
                </button>
                <button
                  onClick={startBuild}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-border bg-bg px-3 py-2 text-xs text-fg hover:bg-soft transition"
                >
                  <RefreshCw size={12} /> Try again
                </button>
              </div>
            </div>
          )}

          {state === "published" && (
            <div className="p-4 space-y-4">
              {/* Live URL */}
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Live URL</div>
                <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2">
                  <a
                    href={cloudflareDeploymentUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 min-w-0 truncate text-sm font-mono text-emerald-300 hover:text-emerald-200 transition"
                  >
                    {cloudflareDeploymentUrl ?? "—"}
                  </a>
                  {cloudflareDeploymentUrl && (
                    <>
                      <CopyBtn value={cloudflareDeploymentUrl} />
                      <a href={cloudflareDeploymentUrl} target="_blank" rel="noreferrer" className="rounded-md p-1 text-muted hover:text-fg">
                        <ExternalLink size={12} />
                      </a>
                    </>
                  )}
                </div>
              </div>

              {/* Domain section */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Domain</div>
                  {canUseCustomDomain && (
                    <div className="inline-flex rounded-lg border border-border bg-bg p-0.5 text-[10px]">
                      <button
                        onClick={() => setDomainTab("managed")}
                        className={cn("rounded-md px-2 py-1 transition", domainTab === "managed" ? "bg-soft text-fg" : "text-muted hover:text-fg")}
                      >
                        Managed
                      </button>
                      <button
                        onClick={() => setDomainTab("cname")}
                        className={cn("rounded-md px-2 py-1 transition", domainTab === "cname" ? "bg-soft text-fg" : "text-muted hover:text-fg")}
                      >
                        CNAME
                      </button>
                    </div>
                  )}
                </div>

                {!canUseCustomDomain && (
                  <a href="/pricing" className="block rounded-lg border border-amber-500/30 bg-gradient-to-r from-amber-500/10 to-pink-500/10 p-3 text-xs text-muted hover:text-fg transition">
                    <div className="flex items-center gap-2 mb-1">
                      <Lock size={12} className="text-amber-400" />
                      <span className="font-semibold text-fg">Custom domains: Pro feature</span>
                    </div>
                    Upgrade to use your own domain (e.g. myapp.com) instead of .pages.dev →
                  </a>
                )}

                {canUseCustomDomain && domainTab === "managed" && (
                  <div className="space-y-2">
                    {managedDomainHostname ? (
                      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Check size={14} className="text-emerald-400" />
                            <span className="font-mono text-sm text-fg">{managedDomainHostname}</span>
                          </div>
                          <button onClick={detachManagedDomain} className="rounded-md p-1 text-red-300 hover:bg-red-500/10" title="Detach">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    ) : !managedOptions ? (
                      <div className="text-xs text-muted">Loading domains…</div>
                    ) : managedOptions.length === 0 ? (
                      <a href="/domains" className="block rounded-lg border border-border bg-bg p-3 text-xs text-muted hover:text-fg transition">
                        You don&apos;t have any managed domains yet.<br />
                        <span className="text-emerald-400">Add one in /domains →</span>
                      </a>
                    ) : (
                      <>
                        <div className="grid grid-cols-[1fr_auto] gap-2">
                          <select
                            value={selectedDomainId}
                            onChange={(e) => setSelectedDomainId(e.target.value)}
                            className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:border-emerald-500/50 focus:outline-none"
                          >
                            {managedOptions.map(d => (
                              <option key={d.id} value={d.id} disabled={d.status !== "active"}>
                                {d.apexDomain}{d.status !== "active" ? " (pending)" : ""}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            type="text"
                            value={selectedSubdomain}
                            onChange={(e) => setSelectedSubdomain(e.target.value)}
                            placeholder="www"
                            className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm font-mono text-fg focus:border-emerald-500/50 focus:outline-none"
                          />
                          <span className="text-sm text-muted">.{managedOptions.find(d => d.id === selectedDomainId)?.apexDomain ?? "…"}</span>
                        </div>
                        <p className="text-[10px] text-muted">Use <code>@</code> for the apex domain ({managedOptions.find(d => d.id === selectedDomainId)?.apexDomain}).</p>
                        {(() => {
                          const apex = managedOptions.find(d => d.id === selectedDomainId)?.apexDomain;
                          if (!apex) return null;
                          const sub = (selectedSubdomain ?? "").trim().toLowerCase();
                          const isApex = !sub || sub === "@" || sub === apex;
                          const otherLabel = isApex ? `www.${apex}` : apex;
                          return (
                            <label className="flex items-start gap-2 rounded-lg border border-border bg-bg/50 p-2.5 text-[11px] text-fg cursor-pointer hover:bg-soft/40 transition">
                              <input
                                type="checkbox"
                                checked={mirrorToOther}
                                onChange={(e) => setMirrorToOther(e.target.checked)}
                                className="mt-0.5 rounded border-border"
                              />
                              <span>
                                Also serve at <span className="font-mono text-emerald-300">{otherLabel}</span>
                                <span className="block text-[10px] text-muted mt-0.5">Both hostnames will load the same site.</span>
                              </span>
                            </label>
                          );
                        })()}
                        {managedErr && (
                          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">{managedErr}</div>
                        )}
                        <button
                          onClick={assignManagedDomain}
                          disabled={managedBusy || !selectedDomainId}
                          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-400 transition disabled:opacity-50"
                        >
                          {managedBusy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                          Assign domain
                        </button>
                        <a href="/domains" className="block text-center text-[10px] text-muted hover:text-fg">Manage in /domains →</a>
                      </>
                    )}
                  </div>
                )}

                {canUseCustomDomain && domainTab === "cname" && (
                  <div className="space-y-2">
                    {customDomain ? (
                      <div className="rounded-lg border border-border bg-bg p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-sm text-fg">{customDomain}</span>
                          <div className="flex items-center gap-1">
                            {customDomainStatus === "active"
                              ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300 border border-emerald-500/30"><Check size={10} /> Active</span>
                              : <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300 border border-amber-500/30"><Loader2 size={10} className="animate-spin" /> Pending</span>
                            }
                            <button onClick={removeCname} className="rounded-md p-1 text-red-300 hover:bg-red-500/10" title="Remove">
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                        <div className="rounded-md bg-soft/50 p-2 text-[10px] text-muted">
                          Add this CNAME at your registrar:
                          <div className="mt-1 font-mono text-fg">{customDomain} → {cloudflareProjectName}.pages.dev</div>
                        </div>
                      </div>
                    ) : (
                      <>
                        <Input
                          type="text"
                          value={cnameInput}
                          onChange={(e) => setCnameInput(e.target.value)}
                          placeholder="www.myapp.com"
                          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm font-mono text-fg focus:border-emerald-500/50 focus:outline-none"
                        />
                        <p className="text-[10px] text-muted">Keep your nameservers at your registrar; just point a CNAME at <span className="font-mono">{cloudflareProjectName}.pages.dev</span>.</p>
                        {cnameErr && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">{cnameErr}</div>}
                        <button
                          onClick={attachCname}
                          disabled={cnameBusy || !cnameInput.trim()}
                          className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm font-medium text-fg hover:bg-soft transition disabled:opacity-50"
                        >
                          {cnameBusy && <Loader2 size={13} className="animate-spin" />}
                          Add custom domain
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Public/showcase listing */}
              {publicToggle}

              {/* Bottom actions */}
              <div className="flex gap-2 pt-2 border-t border-border/60">
                <button
                  onClick={startBuild}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-bg px-3 py-2 text-xs font-medium text-fg hover:bg-soft transition"
                >
                  <RefreshCw size={12} /> Redeploy
                </button>
                <button
                  onClick={unpublish}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-500/20 transition"
                >
                  <Trash2 size={12} /> Unpublish
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );

  return createPortal(panel, document.body);
}
