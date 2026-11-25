'use client';

import { useState } from 'react';
import { Cpu, FlaskConical, Pencil, Plus, Server, ShieldAlert, ShieldCheck, ShieldHalf, Trash2 } from 'lucide-react';
import {
  Card,
  ErrorState,
  LoadingState,
  PageHeader,
  Section,
  StatGrid,
  StatTile,
  StatusPill,
  timeAgo,
  usePanelData,
  type StatusKind,
} from '@/components/panel/ui';
import { HostFormDialog } from '@/components/panel/sim-hosts/host-form-dialog';
import { HostTestDialog } from '@/components/panel/sim-hosts/host-test-dialog';
import { Badge, Notice } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  macosMajor,
  runtimeDescription,
  runtimeRank,
  scopeLabel,
  simHostWarnings,
  simulatorAppFor,
  simulatorAppLabel,
  type SimHost,
  type SimHostHealth,
} from '@/lib/sim-hosts/model';

interface HostEntry {
  host: SimHost;
  health: SimHostHealth;
}

interface SimHostsData {
  hosts: HostEntry[];
  provider: string;
  envControllerConfigured: boolean;
  envTokenConfigured: boolean;
  generatedAt: string;
}

const isUp = (h: SimHostHealth) => h.reachable && h.agentConnected;

function capacity(e: HostEntry): number {
  return Math.min(e.host.maxSessions, e.health.reportedSlots ?? e.host.maxSessions);
}

function hostStatus(e: HostEntry): { kind: StatusKind; label: string } {
  if (!e.host.serving) return { kind: 'neutral', label: isUp(e.health) ? 'Off · online' : 'Off' };
  if (!e.health.reachable) return { kind: 'serious', label: 'Serving · unreachable' };
  if (!e.health.agentConnected) return { kind: 'serious', label: 'Serving · no agent' };
  return { kind: 'good', label: 'Serving' };
}

type Pending =
  | { kind: 'serve-unsecured'; entry: HostEntry }
  | { kind: 'stop-last'; entry: HostEntry }
  | { kind: 'delete'; entry: HostEntry };

export default function PanelSimulatorsPage() {
  const { data, loading, error, refresh, refreshing } = usePanelData<SimHostsData>('/api/panel/sim-hosts');
  const { toast } = useToast();
  const [form, setForm] = useState<{ open: boolean; host: SimHost | null }>({ open: false, host: null });
  const [testing, setTesting] = useState<SimHost | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  const { hosts } = data;
  const serving = hosts.filter((e) => e.host.serving);
  const servingUp = serving.filter((e) => isUp(e.health));
  const forEveryone = serving.filter((e) => e.host.scope === 'all');
  const forBeta = serving; // beta users can use every serving host
  const active = hosts.reduce((n, e) => n + (e.health.activeSessions ?? 0), 0);
  const totalCapacity = servingUp.reduce((n, e) => n + capacity(e), 0);

  async function setServing(entry: HostEntry, next: boolean, acknowledgeUnsecured = false) {
    setBusy(entry.host.id);
    try {
      const res = await fetch(`/api/panel/sim-hosts/${entry.host.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serving: next, ...(acknowledgeUnsecured ? { acknowledgeUnsecured: true } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast({ title: 'Not changed', description: body.error ?? `HTTP ${res.status}` });
        return;
      }
      toast({
        title: next ? `${entry.host.name} is serving` : `${entry.host.name} stopped serving`,
        description: next
          ? 'New simulator sessions can be placed on it now.'
          : 'No new sessions go to it; sessions already running there finish normally.',
      });
      refresh();
    } catch {
      toast({ title: 'Network error', description: 'The change was not saved.' });
    } finally {
      setBusy(null);
    }
  }

  function requestServing(entry: HostEntry, next: boolean) {
    if (next && entry.host.runtime === 'unsecure') {
      setAck(false);
      setPending({ kind: 'serve-unsecured', entry });
      return;
    }
    const leavesNobodyForEveryone =
      !next && entry.host.scope === 'all' && forEveryone.filter((e) => e.host.id !== entry.host.id).length === 0;
    if (leavesNobodyForEveryone) {
      setPending({ kind: 'stop-last', entry });
      return;
    }
    void setServing(entry, next);
  }

  async function remove(entry: HostEntry) {
    setBusy(entry.host.id);
    try {
      const res = await fetch(`/api/panel/sim-hosts/${entry.host.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast({ title: 'Not deleted', description: body.error ?? `HTTP ${res.status}` });
        return;
      }
      toast({ title: `Removed ${entry.host.name}` });
      refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Simulators"
        subtitle="The Macs that build and stream the iOS simulator. Changes apply to the next simulator a user opens."
        onRefresh={refresh}
        refreshing={refreshing}
        generatedAt={data.generatedAt}
      />

      <div className="mb-6 space-y-2">
        {data.provider !== 'cloud' && (
          <Notice tone="warning">
            SIMULATOR_PROVIDER is “{data.provider}”: the Mac cloud is switched off for every user and the Preview tab
            offers Botflow Companion instead. These hosts take no users until it is set back to “cloud”. Tests here
            still work.
          </Notice>
        )}
        {hosts.length === 0 && (
          <Notice tone="info">
            No hosts are registered, so every user goes to the controller in SIM_CONTROLLER_URL
            {data.envControllerConfigured ? '' : ' (not set in this deployment)'}. Add a host to route from here.
          </Notice>
        )}
        {hosts.length > 0 && forEveryone.length === 0 && (
          <Notice tone="danger">
            No host is serving everyone. Users without the beta flag can&apos;t open the simulator, build to a device or
            publish to the App Store.
          </Notice>
        )}
        {hosts.length > 0 && forEveryone.length > 0 && forEveryone.every((e) => !isUp(e.health)) && (
          <Notice tone="danger">Every host serving everyone is down right now.</Notice>
        )}
      </div>

      {hosts.length > 0 && (
        <Section title="Fleet">
          <StatGrid>
            <StatTile
              label="Serving"
              value={`${servingUp.length} / ${serving.length}`}
              sub={`online of ${serving.length} serving · ${hosts.length} registered`}
              tone={serving.length > 0 && servingUp.length < serving.length ? 'warning' : undefined}
            />
            <StatTile label="Simulator slots" value={String(totalCapacity)} sub="on serving hosts that are up" />
            <StatTile
              label="Active sessions"
              value={String(active)}
              sub={totalCapacity > 0 ? `${Math.round((active / totalCapacity) * 100)}% of slots` : undefined}
              tone={totalCapacity > 0 && active >= totalCapacity ? 'warning' : undefined}
            />
            <StatTile
              label="Unsecured serving"
              value={String(serving.filter((e) => e.host.runtime === 'unsecure').length)}
              tone={serving.some((e) => e.host.runtime === 'unsecure' && e.host.scope === 'all') ? 'danger' : undefined}
              sub="run user code outside a VM"
            />
          </StatGrid>
        </Section>
      )}

      {hosts.length > 0 && (
        <Section title="Routing" hint="who goes where, in the order hosts are tried">
          <Card className="space-y-3">
            <RouteRow label="Everyone" entries={forEveryone} />
            <RouteRow label="Beta users" entries={forBeta} />
            <p className="text-xs leading-relaxed text-muted">
              Each new session goes to the first host in its row that is up and has a free slot (most free slots wins a
              tie; then fully isolated, build isolated, unsecured). When all are full it queues on the first one that is up. Rebuilds,
              status checks and downloads stay on the host that took the work. App Store builds skip beta-only hosts.
            </p>
          </Card>
        </Section>
      )}

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-fg">Hosts</h2>
          <Button size="sm" onClick={() => setForm({ open: true, host: null })}>
            <Plus className="h-3.5 w-3.5" /> Add host
          </Button>
        </div>
        {hosts.length === 0 ? (
          <Card>
            <EmptyState
              icon={Server}
              title="No simulator hosts yet"
              description="Register each Mac that runs the simulator controller. New hosts start switched off so you can test them first."
              action={
                <Button size="sm" onClick={() => setForm({ open: true, host: null })}>
                  <Plus className="h-3.5 w-3.5" /> Add host
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="space-y-4">
            {hosts.map((entry) => (
              <HostCard
                key={entry.host.id}
                entry={entry}
                busy={busy === entry.host.id}
                onServing={(v) => requestServing(entry, v)}
                onEdit={() => setForm({ open: true, host: entry.host })}
                onTest={() => setTesting(entry.host)}
                onDelete={() => setPending({ kind: 'delete', entry })}
              />
            ))}
          </div>
        )}
      </section>

      <HostFormDialog
        open={form.open}
        host={form.host}
        onClose={() => setForm({ open: false, host: null })}
        onSaved={(message) => {
          setForm({ open: false, host: null });
          toast({ title: message });
          refresh();
        }}
      />

      {testing && (
        <HostTestDialog open host={testing} onClose={() => setTesting(null)} onSaved={refresh} />
      )}

      <Dialog
        open={pending?.kind === 'serve-unsecured'}
        onClose={() => setPending(null)}
        title={pending ? `Serve users from ${pending.entry.host.name}?` : ''}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!ack}
              onClick={() => {
                if (pending) void setServing(pending.entry, true, true);
                setPending(null);
              }}
            >
              Start serving
            </Button>
          </>
        }
      >
        {pending && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            <Notice tone={pending.entry.host.scope === 'all' ? 'danger' : 'warning'}>
              This host is <strong>unsecured</strong>: users&apos; apps are compiled and run directly on the Mac, with no
              Virtualization.framework VM around them. It is set to serve{' '}
              <strong>{pending.entry.host.scope === 'all' ? 'everyone' : 'beta users only'}</strong>.
            </Notice>
            {pending.entry.host.scope === 'all' && (
              <p className="text-muted">Consider editing the host to serve beta users only first.</p>
            )}
            <label className="flex items-start gap-2 text-fg">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 accent-current" />
              I understand the risk.
            </label>
          </div>
        )}
      </Dialog>

      <Dialog
        open={pending?.kind === 'stop-last'}
        onClose={() => setPending(null)}
        title={pending ? `Stop serving from ${pending.entry.host.name}?` : ''}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pending) void setServing(pending.entry, false);
                setPending(null);
              }}
            >
              Stop serving
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          It is the last host serving everyone. Afterwards only beta users (on beta-only hosts) can open the simulator;
          everyone else is told no simulator is available. Running sessions are not interrupted.
        </p>
      </Dialog>

      <Dialog
        open={pending?.kind === 'delete'}
        onClose={() => setPending(null)}
        title={pending ? `Remove ${pending.entry.host.name}?` : ''}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pending) void remove(pending.entry);
                setPending(null);
              }}
            >
              Remove host
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          The host leaves the registry and gets no new sessions. Nothing on the Mac changes, and sessions running on it
          continue. {hosts.length === 1 && 'With no hosts left, users go to the controller in SIM_CONTROLLER_URL.'}
        </p>
      </Dialog>
    </div>
  );
}

function RouteRow({ label, entries }: { label: string; entries: HostEntry[] }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <span className="w-24 shrink-0 text-[13px] font-medium text-fg">{label}</span>
      {entries.length === 0 ? (
        <span className="text-[13px] text-danger">No host</span>
      ) : (
        <ol className="flex flex-wrap items-center gap-1.5">
          {[...entries]
            .sort((a, b) => a.host.priority - b.host.priority || runtimeRank(a.host.runtime) - runtimeRank(b.host.runtime))
            .map((e, i) => (
              <li key={e.host.id} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-xs text-subtle">→</span>}
                <Badge tone={!isUp(e.health) ? 'danger' : e.host.runtime === 'unsecure' ? 'warning' : 'neutral'}>
                  {e.host.name}
                  {!isUp(e.health) && ' (down)'}
                </Badge>
              </li>
            ))}
        </ol>
      )}
    </div>
  );
}

function HostCard({
  entry,
  busy,
  onServing,
  onEdit,
  onTest,
  onDelete,
}: {
  entry: HostEntry;
  busy: boolean;
  onServing: (next: boolean) => void;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const { host, health } = entry;
  const status = hostStatus(entry);
  const app = simulatorAppFor(host.macosVersion);
  const major = macosMajor(host.macosVersion);
  const warnings = simHostWarnings(host, health);
  const t = host.lastTest;
  const hardware = [host.hardwareModel, host.chip, host.ramGb != null ? `${host.ramGb} GB RAM` : null].filter(Boolean).join(' · ');

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold text-fg">{host.name}</h3>
            <StatusPill kind={status.kind} label={status.label} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {host.runtime === 'isolated' ? (
              <Badge tone="success" title={runtimeDescription(host.runtime)}>
                <ShieldCheck className="h-3 w-3" /> Fully isolated · build + simulator in VMs
              </Badge>
            ) : host.runtime === 'build-isolated' ? (
              <Badge tone="success" title={runtimeDescription(host.runtime)}>
                <ShieldHalf className="h-3 w-3" /> Build isolated · build in VM, simulator on bare metal
              </Badge>
            ) : (
              <Badge tone="warning">
                <ShieldAlert className="h-3 w-3" /> Unsecured · bare metal
              </Badge>
            )}
            <Badge tone="info">
              macOS {Number.isFinite(major) ? host.macosVersion : '?'} · {simulatorAppLabel(app)}
            </Badge>
            <Badge tone={host.scope === 'beta' ? 'accent' : 'neutral'}>{scopeLabel(host.scope)}</Badge>
            {host.runtime !== 'unsecure' && host.vmCapUnlocked && <Badge>VM cap unlocked</Badge>}
          </div>
        </div>
        <label className="flex items-center gap-2.5 text-[13px] text-fg">
          Serving
          <Switch checked={host.serving} disabled={busy} onChange={onServing} aria-label={`Serving: ${host.name}`} />
        </label>
      </div>

      <dl className="grid gap-x-6 gap-y-3 px-4 py-3.5 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
        <Spec label="Hardware" value={hardware || '—'} icon={Cpu} />
        <Spec
          label="Sessions"
          value={
            health.agentConnected
              ? `${health.activeSessions ?? 0} active of ${capacity(entry)}`
              : `limit ${host.maxSessions}`
          }
          sub={
            health.reportedSlots != null
              ? `agent offers ${health.reportedSlots} · limit here ${host.maxSessions}`
              : host.runtime === 'isolated'
                ? host.vmCapUnlocked
                  ? 'one VM per session, no VM cap'
                  : 'one VM per session, stock cap of 2'
                : host.runtime === 'build-isolated'
                  ? 'builds queue for the build VMs'
                  : undefined
          }
        />
        <Spec
          label="Host agent"
          value={health.agentConnected ? host.agentHostId ?? 'Connected' : health.error ?? 'Not connected'}
          sub={health.lastHeartbeatAt ? `heartbeat ${timeAgo(health.lastHeartbeatAt)}` : undefined}
          tone={!health.agentConnected ? 'danger' : undefined}
        />
        <Spec
          label="Controller"
          value={host.controllerUrl.replace(/^https?:\/\//, '')}
          sub={health.reachable ? `responding in ${health.latencyMs ?? '?'} ms` : health.error ?? 'unreachable'}
          mono
          tone={!health.reachable ? 'danger' : undefined}
        />
        <Spec
          label="Token"
          value={host.hasOwnToken ? 'Own token (encrypted)' : 'Deployment SIM_PLATFORM_TOKEN'}
          sub={`priority ${host.priority}`}
        />
        <Spec
          label="Last test"
          value={
            t
              ? t.ok
                ? `${t.startupMs != null ? `${(t.startupMs / 1000).toFixed(1)} s startup` : 'ok'} · ${t.avgFps ?? '—'} fps`
                : 'Failed'
              : 'Never tested'
          }
          sub={
            t
              ? t.ok
                ? `${timeAgo(t.at)}${t.minFps != null ? ` · worst second ${t.minFps} fps` : ''}${t.resolution ? ` · ${t.resolution}` : ''}`
                : `${timeAgo(t.at)} · ${t.error ?? 'no detail'}`
              : undefined
          }
          tone={t && !t.ok ? 'danger' : undefined}
        />
      </dl>

      {(warnings.length > 0 || host.notes) && (
        <div className="space-y-2 px-4 pb-3.5">
          {warnings.map((w) => (
            <Notice key={w.text} tone={w.tone}>
              {w.text}
            </Notice>
          ))}
          {host.notes && <p className="text-xs leading-relaxed text-muted">{host.notes}</p>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        <Button size="sm" variant="secondary" onClick={onTest}>
          <FlaskConical className="h-3.5 w-3.5" /> Test
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto text-danger hover:text-danger" onClick={onDelete} disabled={busy}>
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </Button>
      </div>
    </Card>
  );
}

function Spec({
  label,
  value,
  sub,
  icon: Icon,
  mono,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: typeof Cpu;
  mono?: boolean;
  tone?: 'danger';
}) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 flex items-center gap-1 text-xs text-muted">
        {Icon && <Icon className="h-3 w-3" strokeWidth={1.75} />}
        {label}
      </dt>
      <dd className={cn('truncate text-fg', mono && 'font-mono text-xs', tone === 'danger' && 'text-danger')} title={value}>
        {value}
      </dd>
      {sub && <dd className="truncate text-xs text-muted" title={sub}>{sub}</dd>}
    </div>
  );
}
