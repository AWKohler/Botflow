"use client";

import { Input } from "@/components/ui/input";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import {
  Globe,
  Plus,
  Loader2,
  Check,
  Copy,
  RefreshCw,
  Trash2,
  AlertCircle,
  ChevronLeft,
  ExternalLink,
  Sparkles,
  Lock,
  Cog,
} from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { SettingsModal } from "@/components/settings/SettingsModal";

// ── Types ───────────────────────────────────────────────────────────────────
interface Domain {
  id: string;
  apexDomain: string;
  cfZoneId: string | null;
  status: "pending_ns" | "active" | "error";
  nameservers: string[] | null;
  createdAt: string;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied: boolean;
}

const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"] as const;

function Pill({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "ok" | "warn" | "danger" }) {
  const toneClass = {
    default: "bg-soft text-muted",
    ok: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
    warn: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
    danger: "bg-red-500/15 text-red-300 border border-red-500/30",
  }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide", toneClass)}>
      {children}
    </span>
  );
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

// ── Add Domain modal ────────────────────────────────────────────────────────
function AddDomainModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (d: Domain) => void;
}) {
  const [apex, setApex] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setApex(""); setError(null); }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apexDomain: apex.trim() }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? "Failed to add domain"); return; }
      onAdded(j.domain);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-elevated p-6 shadow-2xl">
        <div className="mb-1 flex items-center gap-2">
          <div className="rounded-lg bg-emerald-500/15 p-2">
            <Globe className="h-5 w-5 text-emerald-400" />
          </div>
          <h2 className="text-lg font-semibold text-fg">Add a managed domain</h2>
        </div>
        <p className="mb-4 text-sm text-muted">
          We&apos;ll create a Cloudflare zone and give you two nameservers to set at your registrar. Once your registrar acknowledges the change, the zone activates and you can manage DNS here.
        </p>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-medium text-muted">Apex domain</span>
          <Input
            autoFocus
            type="text"
            value={apex}
            onChange={(e) => setApex(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
            placeholder="example.com"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted/60 focus:border-emerald-500/50 focus:outline-none"
          />
          <span className="mt-1 block text-[11px] text-muted">Don&apos;t include http:// or www. — just the apex.</span>
        </label>
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg hover:bg-soft transition disabled:opacity-50">
            Cancel
          </button>
          <button onClick={submit} disabled={busy || !apex.trim()} className="inline-flex items-center gap-2 rounded-lg bg-fg px-3 py-2 text-sm font-medium text-bg shadow-md hover:opacity-90 transition disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Add domain
          </button>
        </div>
      </div>
    </div>
  );
}

// ── DNS record editor ───────────────────────────────────────────────────────
function RecordEditor({
  domainId,
  initial,
  onClose,
  onSaved,
}: {
  domainId: string;
  initial?: DnsRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState(initial?.type ?? "A");
  const [name, setName] = useState(initial?.name ?? "@");
  const [content, setContent] = useState(initial?.content ?? "");
  const [priority, setPriority] = useState(initial?.priority ?? 10);
  const [proxied, setProxied] = useState(initial?.proxied ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = { type, name, content, ttl: 1, proxied };
      if (type === "MX") body.priority = priority;
      const url = initial
        ? `/api/domains/${domainId}/records/${initial.id}`
        : `/api/domains/${domainId}/records`;
      const res = await fetch(url, {
        method: initial ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? "Failed"); return; }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-elevated p-6 shadow-2xl">
        <h2 className="mb-4 text-lg font-semibold text-fg">
          {initial ? "Edit DNS record" : "Add DNS record"}
        </h2>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <label>
              <span className="mb-1 block text-xs font-medium text-muted">Type</span>
              <select value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:border-emerald-500/50 focus:outline-none">
                {RECORD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="col-span-2">
              <span className="mb-1 block text-xs font-medium text-muted">Name</span>
              <Input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="@ or www" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:border-emerald-500/50 focus:outline-none" />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {type === "A" || type === "AAAA" ? "IP address" : type === "CNAME" ? "Target hostname" : type === "MX" ? "Mail server" : type === "TXT" ? "Text content" : "Value"}
            </span>
            <Input type="text" value={content} onChange={(e) => setContent(e.target.value)} placeholder={type === "A" ? "192.0.2.1" : type === "CNAME" ? "example.pages.dev" : ""} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:border-emerald-500/50 focus:outline-none" />
          </label>
          {type === "MX" && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Priority</span>
              <Input type="number" value={priority} onChange={(e) => setPriority(parseInt(e.target.value, 10))} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:border-emerald-500/50 focus:outline-none" />
            </label>
          )}
          {(type === "A" || type === "AAAA" || type === "CNAME") && (
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={proxied} onChange={(e) => setProxied(e.target.checked)} className="rounded border-border" />
              Proxy through Cloudflare (HTTPS, caching, DDoS protection)
            </label>
          )}
        </div>
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg hover:bg-soft transition disabled:opacity-50">Cancel</button>
          <button onClick={submit} disabled={busy || !name || !content} className="inline-flex items-center gap-2 rounded-lg bg-fg px-3 py-2 text-sm font-medium text-bg shadow-md hover:opacity-90 transition disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />}
            {initial ? "Save" : "Add record"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Domain detail view ──────────────────────────────────────────────────────
function DomainDetail({
  domain,
  onBack,
  onChanged,
  onDeleted,
}: {
  domain: Domain;
  onBack: () => void;
  onChanged: (d: Domain) => void;
  onDeleted: () => void;
}) {
  const [records, setRecords] = useState<DnsRecord[] | null>(null);
  const [recordsErr, setRecordsErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<DnsRecord | null | "new">(null);

  const loadRecords = useCallback(async () => {
    setRecordsErr(null);
    try {
      const res = await fetch(`/api/domains/${domain.id}/records`);
      const j = await res.json();
      if (!res.ok) { setRecordsErr(j.error ?? "Failed"); return; }
      setRecords(j.records ?? []);
    } catch (e) {
      setRecordsErr(e instanceof Error ? e.message : String(e));
    }
  }, [domain.id]);

  useEffect(() => {
    if (domain.status === "active") loadRecords();
  }, [domain.status, loadRecords]);

  const pollStatus = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/domains/${domain.id}/status`);
      const j = await res.json();
      if (res.ok && j.domain) onChanged(j.domain);
    } finally { setRefreshing(false); }
  }, [domain.id, onChanged]);

  const deleteRecord = async (id: string) => {
    if (!confirm("Delete this DNS record?")) return;
    await fetch(`/api/domains/${domain.id}/records/${id}`, { method: "DELETE" });
    loadRecords();
  };

  const deleteDomain = async () => {
    if (!confirm(`Delete ${domain.apexDomain} and its Cloudflare zone? This cannot be undone.`)) return;
    const res = await fetch(`/api/domains/${domain.id}`, { method: "DELETE" });
    if (res.ok) onDeleted();
  };

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <button onClick={onBack} className="inline-flex items-center gap-1 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm text-muted hover:text-fg hover:bg-soft transition">
          <ChevronLeft size={14} /> All domains
        </button>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="rounded-xl bg-emerald-500/15 p-2.5">
          <Globe className="h-6 w-6 text-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-semibold text-fg break-words">{domain.apexDomain}</h1>
          <div className="mt-1 flex items-center gap-2">
            {domain.status === "active"
              ? <Pill tone="ok"><Check size={10} /> Active</Pill>
              : <Pill tone="warn"><Loader2 size={10} className="animate-spin" /> Pending nameservers</Pill>
            }
            <a href={`https://${domain.apexDomain}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
              <ExternalLink size={11} />
              {domain.apexDomain}
            </a>
          </div>
        </div>
        <button onClick={deleteDomain} className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 transition">
          <Trash2 size={12} /> Remove domain
        </button>
      </div>

      {domain.status !== "active" && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
          <div className="mb-3 flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-400" />
            <h3 className="font-semibold text-fg">Nameserver setup required</h3>
          </div>
          <p className="mb-4 text-sm text-muted">
            At your registrar (Namecheap, GoDaddy, etc.), find the &ldquo;Custom DNS&rdquo; or &ldquo;Nameservers&rdquo; setting for <span className="font-mono text-fg">{domain.apexDomain}</span> and replace the existing nameservers with these two:
          </p>
          {domain.nameservers && domain.nameservers.length > 0 ? (
            <div className="space-y-2">
              {domain.nameservers.map((ns) => (
                <div key={ns} className="flex items-center justify-between rounded-lg border border-border bg-bg px-4 py-2.5">
                  <span className="font-mono text-sm text-fg">{ns}</span>
                  <CopyBtn value={ns} />
                </div>
              ))}
            </div>
          ) : <span className="text-sm text-muted">Loading nameservers…</span>}
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted">DNS changes typically propagate within a few minutes, but can take up to 24 hours.</p>
            <button onClick={pollStatus} disabled={refreshing} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg px-3 py-1.5 text-xs text-fg hover:bg-soft transition disabled:opacity-50">
              {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Check status
            </button>
          </div>
        </div>
      )}

      {domain.status === "active" && (
        <div className="rounded-xl border border-border bg-elevated p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-fg">DNS records</h3>
              <p className="text-xs text-muted">Manage the records in your Cloudflare zone.</p>
            </div>
            <button onClick={() => setEditing("new")} className="inline-flex items-center gap-1 rounded-lg bg-fg px-3 py-1.5 text-xs font-medium text-bg shadow-sm hover:opacity-90 transition">
              <Plus size={12} /> Add record
            </button>
          </div>

          {recordsErr && (
            <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{recordsErr}</div>
          )}
          {records === null ? (
            <div className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading records…</div>
          ) : records.length === 0 ? (
            <div className="text-sm text-muted">No DNS records yet. Click &ldquo;Add record&rdquo; to get started.</div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-soft/50">
                  <tr className="text-left text-xs text-muted">
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Content</th>
                    <th className="px-3 py-2">Proxy</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {records.map((r) => (
                    <tr key={r.id} className="hover:bg-soft/30">
                      <td className="px-3 py-2 font-mono text-xs font-semibold text-emerald-400">{r.type}</td>
                      <td className="px-3 py-2 font-mono text-xs text-fg">{r.name}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted truncate max-w-[300px]" title={r.content}>{r.content}</td>
                      <td className="px-3 py-2 text-xs">{r.proxied ? <Pill tone="ok">Proxied</Pill> : <Pill>DNS only</Pill>}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button onClick={() => setEditing(r)} className="rounded p-1 text-muted hover:text-fg hover:bg-soft" title="Edit">
                            <Cog size={13} />
                          </button>
                          <button onClick={() => deleteRecord(r.id)} className="rounded p-1 text-red-300 hover:bg-red-500/10" title="Delete">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {editing !== null && (
        <RecordEditor
          domainId={domain.id}
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={loadRecords}
        />
      )}
    </div>
  );
}

// ── Main client component ───────────────────────────────────────────────────
export default function DomainsClient() {
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [, setTier] = useState<string>("free");
  // Tri-state: null = still loading the plan. Avoids the upgrade-CTA flash for
  // paid users while /api/domains is in flight.
  const [managedDomainsEnabled, setManagedDomainsEnabled] = useState<boolean | null>(null);
  const [maxManagedDomains, setMaxManagedDomains] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/domains");
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? "Failed"); return; }
      setDomains(j.domains ?? []);
      setTier(j.tier ?? "free");
      setManagedDomainsEnabled(Boolean(j.managedDomainsEnabled));
      setMaxManagedDomains(j.maxManagedDomains ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const selectedDomain = useMemo(
    () => (selected && domains ? domains.find((d) => d.id === selected) ?? null : null),
    [selected, domains],
  );

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur">
        <div className="mx-auto max-w-7xl px-6 py-5">
          <div className="grid grid-cols-3 items-center">
            <Link className="flex items-center gap-3" href="/">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/botflow-glyph.svg" alt="" className="h-8 w-8" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/botflow-wordmark.svg"
                alt="Botflow"
                className="h-5 w-auto botflow-wordmark-invert"
              />
            </Link>
            <nav className="hidden md:flex items-center justify-center gap-7 text-sm text-muted">
              <a href="/projects" className="hover:text-fg transition">My Projects</a>
              <a href="/explore" className="hover:text-fg transition">Explore</a>
              <a href="/domains" className="text-fg font-medium">Domains</a>
              <a href="/pricing" className="hover:text-fg transition">Pricing</a>
              <a href="/docs" className="hover:text-fg transition">Docs</a>
            </nav>
            <div className="flex items-center justify-end gap-2">
              <SignedOut>
                <SignInButton>
                  <button className="inline-flex items-center rounded-xl border border-border bg-elevated px-3.5 py-2 text-sm font-medium text-fg shadow-sm hover:bg-soft transition">Log in</button>
                </SignInButton>
              </SignedOut>
              <SignedIn>
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="inline-flex items-center justify-center rounded-xl border border-border bg-elevated px-2.5 py-2 text-sm text-fg shadow-sm hover:bg-soft transition"
                  title="Settings"
                  aria-label="Settings"
                >
                  <Cog className="h-4 w-4" />
                </button>
                <UserButton afterSignOutUrl="/" />
              </SignedIn>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        {!selectedDomain && (
          <>
            <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-3xl font-semibold tracking-tight">Domains</h1>
                <p className="mt-1 text-sm text-muted">
                  Transfer your domain to Botflow&apos;s Cloudflare account for full DNS control, then assign it to any project.
                </p>
              </div>
              {managedDomainsEnabled === null ? (
                // Plan still loading — render a neutral placeholder so the
                // upsell CTA doesn't briefly flash for paid users.
                <div className="h-10 w-32 rounded-xl bg-elevated animate-pulse" />
              ) : managedDomainsEnabled ? (
                <button
                  onClick={() => setAddOpen(true)}
                  disabled={domains !== null && domains.length >= maxManagedDomains}
                  className="inline-flex items-center gap-2 rounded-xl bg-fg px-4 py-2.5 text-sm font-medium text-bg shadow-md hover:opacity-90 transition disabled:opacity-50"
                >
                  <Plus size={15} /> Add domain
                </button>
              ) : (
                <Link
                  href="/pricing"
                  className="inline-flex items-center gap-2 rounded-xl bg-fg px-4 py-2.5 text-sm font-medium text-bg shadow-md hover:opacity-90 transition"
                >
                  <Sparkles size={15} /> Upgrade to Pro
                </Link>
              )}
            </div>

            {error && (
              <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>
            )}

            {managedDomainsEnabled === false && (
              <div className="mb-8 rounded-2xl border border-border bg-surface p-6">
                <div className="flex items-start gap-4">
                  <div className="rounded-xl border border-border bg-elevated p-3">
                    <Lock className="h-6 w-6 text-muted" />
                  </div>
                  <div className="flex-1">
                    <h3 className="mb-1 text-lg font-semibold text-fg">Managed domains are a Pro feature</h3>
                    <p className="text-sm text-muted">
                      Upgrade to Pro or Max to transfer your domains to Botflow&apos;s Cloudflare account.
                      We&apos;ll manage DNS, SSL certificates, and proxy your traffic through Cloudflare&apos;s CDN.
                      Your projects can then use your real domain — no <span className="font-mono">.pages.dev</span> suffix.
                    </p>
                    <Link
                      href="/pricing"
                      className="mt-4 inline-flex items-center gap-2 rounded-xl bg-fg px-3.5 py-2 text-sm font-medium text-bg shadow-md hover:opacity-90 transition"
                    >
                      View pricing →
                    </Link>
                  </div>
                </div>
              </div>
            )}

            {domains === null ? (
              <div className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</div>
            ) : domains.length === 0 && managedDomainsEnabled ? (
              <div className="rounded-2xl border border-dashed border-border bg-elevated/40 p-12 text-center">
                <Globe className="mx-auto mb-3 h-10 w-10 text-muted/60" />
                <h3 className="mb-1 text-lg font-semibold text-fg">No domains yet</h3>
                <p className="mb-5 text-sm text-muted">Add your first domain to give your projects a real home on the web.</p>
                <button onClick={() => setAddOpen(true)} className="inline-flex items-center gap-2 rounded-xl bg-fg px-4 py-2 text-sm font-medium text-bg shadow-md hover:opacity-90 transition">
                  <Plus size={14} /> Add your first domain
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {domains?.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => setSelected(d.id)}
                    className="group rounded-xl border border-border bg-elevated p-5 text-left transition hover:border-emerald-500/50 hover:bg-soft/50"
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <div className="rounded-lg bg-emerald-500/15 p-2">
                        <Globe className="h-5 w-5 text-emerald-400" />
                      </div>
                      {d.status === "active"
                        ? <Pill tone="ok"><Check size={10} /> Active</Pill>
                        : <Pill tone="warn"><Loader2 size={10} className="animate-spin" /> Pending</Pill>
                      }
                    </div>
                    <div className="text-base font-semibold text-fg group-hover:text-emerald-300 transition">{d.apexDomain}</div>
                    <div className="mt-1 text-xs text-muted">
                      {d.status === "active" ? "Manage DNS records →" : "Set nameservers at your registrar →"}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {selectedDomain && (
          <DomainDetail
            domain={selectedDomain}
            onBack={() => setSelected(null)}
            onChanged={(d) => setDomains((prev) => prev?.map((x) => x.id === d.id ? d : x) ?? null)}
            onDeleted={() => { setSelected(null); load(); }}
          />
        )}
      </main>

      <AddDomainModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(d) => {
          setDomains((prev) => (prev ? [d, ...prev] : [d]));
          setSelected(d.id);
        }}
      />

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
