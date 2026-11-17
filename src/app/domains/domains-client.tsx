"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  Lock,
  Pencil,
} from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/site/AppShell";
import { Badge, Notice } from "@/components/ui/badge";
import { Button, buttonClass } from "@/components/ui/button";
import { Card, PageHeader, SectionHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Select, TextInput } from "@/components/ui/field";

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

function StatusBadge({ status }: { status: Domain["status"] }) {
  return status === "active" ? (
    <Badge tone="success">
      <Check size={11} /> Active
    </Badge>
  ) : (
    <Badge tone="warning">
      <Loader2 size={11} className="animate-spin" /> Pending nameservers
    </Badge>
  );
}

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function ErrorNotice({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Notice tone="danger" className={className}>
      <span className="flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" />
        <span>{children}</span>
      </span>
    </Notice>
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
    <Dialog
      open
      onClose={onClose}
      zIndex={60}
      title="Add a domain"
      description="We create a Cloudflare zone and give you two nameservers to set at your registrar. Once the change is picked up, the zone activates and you manage DNS here."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !apex.trim()}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            Add domain
          </Button>
        </>
      }
    >
      <Field label="Domain" htmlFor="apex-domain" hint="Just the root domain — no http:// or www.">
        <TextInput
          id="apex-domain"
          autoFocus
          type="text"
          value={apex}
          onChange={(e) => setApex(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
          placeholder="example.com"
        />
      </Field>
      {error && <ErrorNotice className="mt-4">{error}</ErrorNotice>}
    </Dialog>
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

  const valueLabel =
    type === "A" || type === "AAAA"
      ? "IP address"
      : type === "CNAME"
        ? "Target hostname"
        : type === "MX"
          ? "Mail server"
          : type === "TXT"
            ? "Text content"
            : "Value";

  return (
    <Dialog
      open
      onClose={onClose}
      zIndex={60}
      title={initial ? "Edit DNS record" : "Add DNS record"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !name || !content}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {initial ? "Save record" : "Add record"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Type" htmlFor="record-type">
            <Select id="record-type" value={type} onChange={(e) => setType(e.target.value)}>
              {RECORD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Name" htmlFor="record-name" className="col-span-2">
            <TextInput id="record-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="@ or www" />
          </Field>
        </div>
        <Field label={valueLabel} htmlFor="record-content">
          <TextInput
            id="record-content"
            type="text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={type === "A" ? "192.0.2.1" : type === "CNAME" ? "example.pages.dev" : ""}
          />
        </Field>
        {type === "MX" && (
          <Field label="Priority" htmlFor="record-priority">
            <TextInput
              id="record-priority"
              type="number"
              value={priority}
              onChange={(e) => setPriority(parseInt(e.target.value, 10))}
            />
          </Field>
        )}
        {(type === "A" || type === "AAAA" || type === "CNAME") && (
          <label className="flex items-start gap-2.5 text-[13px] text-fg">
            <input
              type="checkbox"
              checked={proxied}
              onChange={(e) => setProxied(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border-strong accent-[var(--sand-accent)]"
            />
            <span>
              Proxy through Cloudflare
              <span className="block text-xs text-muted">Adds HTTPS, caching and DDoS protection.</span>
            </span>
          </label>
        )}
        {error && <ErrorNotice>{error}</ErrorNotice>}
      </div>
    </Dialog>
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
      <button onClick={onBack} className={buttonClass({ variant: "ghost", size: "sm", className: "-ml-2.5 mb-5" })}>
        <ChevronLeft size={15} /> All domains
      </button>

      <PageHeader
        title={<span className="break-words">{domain.apexDomain}</span>}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <StatusBadge status={domain.status} />
            <a
              href={`https://${domain.apexDomain}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[13px] text-muted transition-colors hover:text-fg"
            >
              Visit site
              <ExternalLink size={12} />
            </a>
          </span>
        }
        action={
          <Button variant="danger-outline" size="sm" onClick={deleteDomain}>
            <Trash2 size={13} /> Remove domain
          </Button>
        }
      />

      {domain.status !== "active" && (
        <Card className="mt-8 max-w-3xl p-6">
          <SectionHeader
            title="Point your nameservers to Botflow"
            description={
              <>
                At your registrar (Namecheap, GoDaddy and so on), open the nameserver settings for{" "}
                <span className="font-mono text-fg">{domain.apexDomain}</span> and replace the existing entries with these two.
              </>
            }
          />
          <div className="mt-5">
            {domain.nameservers && domain.nameservers.length > 0 ? (
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg">
                {domain.nameservers.map((ns) => (
                  <div key={ns} className="flex items-center justify-between gap-3 py-2 pl-4 pr-2">
                    <span className="truncate font-mono text-[13px] text-fg">{ns}</span>
                    <CopyBtn value={ns} />
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-sm text-muted">Loading nameservers…</span>
            )}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted">Changes usually take a few minutes, and can take up to 24 hours.</p>
            <Button variant="secondary" size="sm" onClick={pollStatus} disabled={refreshing}>
              {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Check status
            </Button>
          </div>
        </Card>
      )}

      {domain.status === "active" && (
        <Card className="mt-8 overflow-hidden">
          <SectionHeader
            className="p-6 pb-5"
            title="DNS records"
            description="The records in this domain’s Cloudflare zone."
            action={
              <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
                <Plus size={14} /> Add record
              </Button>
            }
          />

          {recordsErr && <ErrorNotice className="mx-6 mb-5">{recordsErr}</ErrorNotice>}
          {records === null ? (
            <div className="flex items-center gap-2 border-t border-border px-6 py-8 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading records…
            </div>
          ) : records.length === 0 ? (
            <div className="border-t border-border px-6 py-8 text-sm text-muted">
              No DNS records yet. Add one to get started.
            </div>
          ) : (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-elevated/60 text-left text-xs font-medium text-muted">
                    <th className="px-6 py-2.5 font-medium">Type</th>
                    <th className="px-3 py-2.5 font-medium">Name</th>
                    <th className="px-3 py-2.5 font-medium">Content</th>
                    <th className="px-3 py-2.5 font-medium">Proxy</th>
                    <th className="px-6 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {records.map((r) => (
                    <tr key={r.id} className="transition-colors hover:bg-elevated/50">
                      <td className="px-6 py-2.5 font-mono text-xs font-medium text-fg">{r.type}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-fg">{r.name}</td>
                      <td className="max-w-[300px] truncate px-3 py-2.5 font-mono text-xs text-muted" title={r.content}>
                        {r.content}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.proxied ? <Badge tone="success">Proxied</Badge> : <Badge>DNS only</Badge>}
                      </td>
                      <td className="px-6 py-2.5 text-right">
                        <div className="inline-flex items-center gap-0.5">
                          <button
                            onClick={() => setEditing(r)}
                            className={buttonClass({ variant: "ghost", size: "xs", className: "w-7 px-0" })}
                            title="Edit record"
                            aria-label="Edit record"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => deleteRecord(r.id)}
                            className={buttonClass({ variant: "ghost", size: "xs", className: "w-7 px-0 hover:bg-danger-soft hover:text-danger" })}
                            title="Delete record"
                            aria-label="Delete record"
                          >
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
        </Card>
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
    <AppShell>
      {!selectedDomain && (
        <>
          <PageHeader
            title="Domains"
            description="Move a domain onto Botflow’s Cloudflare account for full DNS control, then assign it to any project."
            action={
              managedDomainsEnabled === null ? (
                // Plan still loading — render a neutral placeholder so the
                // upsell CTA doesn't briefly flash for paid users.
                <div className="h-9 w-32 animate-pulse rounded-lg bg-elevated" />
              ) : managedDomainsEnabled ? (
                // With no domains yet, the empty state below carries the one action.
                domains !== null && domains.length === 0 ? undefined : (
                  <Button
                    variant="primary"
                    onClick={() => setAddOpen(true)}
                    disabled={domains !== null && domains.length >= maxManagedDomains}
                  >
                    <Plus size={15} /> Add domain
                  </Button>
                )
              ) : (
                <Link href="/pricing" className={buttonClass({ variant: "primary" })}>
                  Upgrade to Pro
                </Link>
              )
            }
          />

          <div className="mt-8 space-y-6">
            {error && <ErrorNotice>{error}</ErrorNotice>}

            {managedDomainsEnabled === false && (
              <Card className="flex items-start gap-4 p-6">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-elevated text-muted">
                  <Lock className="h-[18px] w-[18px]" strokeWidth={1.75} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[15px] font-semibold text-fg">Managed domains are a Pro feature</h3>
                  <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">
                    On Pro or Max, Botflow manages DNS and SSL for your domain and serves it through
                    Cloudflare’s CDN, so your projects live on your real domain instead of a{" "}
                    <span className="font-mono text-[13px]">.pages.dev</span> address.
                  </p>
                  <Link href="/pricing" className={buttonClass({ variant: "secondary", size: "sm", className: "mt-4" })}>
                    Compare plans
                  </Link>
                </div>
              </Card>
            )}

            {domains === null ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-[104px] animate-pulse rounded-xl border border-border bg-surface" />
                ))}
              </div>
            ) : domains.length === 0 && managedDomainsEnabled ? (
              <EmptyState
                className="rounded-xl border border-dashed border-border-strong bg-surface py-20"
                icon={Globe}
                title="No domains yet"
                description="Add a domain to give your projects a real home on the web."
                action={
                  <Button variant="primary" onClick={() => setAddOpen(true)}>
                    <Plus size={15} /> Add your first domain
                  </Button>
                }
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {domains?.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => setSelected(d.id)}
                    className="group rounded-xl border border-border bg-surface p-5 text-left shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-md"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="truncate text-[15px] font-semibold text-fg">{d.apexDomain}</div>
                      <StatusBadge status={d.status} />
                    </div>
                    <div className="mt-2 text-[13px] text-muted">
                      {d.status === "active" ? "Manage DNS records" : "Finish nameserver setup"}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
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

      <AddDomainModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(d) => {
          setDomains((prev) => (prev ? [d, ...prev] : [d]));
          setSelected(d.id);
        }}
      />
    </AppShell>
  );
}
