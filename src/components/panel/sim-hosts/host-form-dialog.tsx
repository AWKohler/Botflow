'use client';

import { useEffect, useId, useState } from 'react';
import { ShieldAlert, ShieldCheck, ShieldHalf } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/badge';
import { Field, Select, TextArea, TextInput } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  STOCK_VM_LIMIT,
  runtimeDescription,
  simulatorAppFor,
  usesVms,
  simulatorAppLabel,
  validateSimHostInput,
  type SimHost,
  type SimHostInput,
  type SimHostRuntime,
} from '@/lib/sim-hosts/model';

interface FormState {
  name: string;
  controllerUrl: string;
  streamUrl: string;
  agentHostId: string;
  runtime: SimHostRuntime;
  macosVersion: string;
  hardwareModel: string;
  chip: string;
  ramGb: string;
  vmCapUnlocked: boolean;
  maxSessions: string;
  scope: 'all' | 'beta';
  priority: string;
  notes: string;
  /** Text entered; empty keeps the current token (edit) or uses the env token (new). */
  platformToken: string;
  clearToken: boolean;
  serving: boolean;
}

function initial(host: SimHost | null): FormState {
  return {
    name: host?.name ?? '',
    controllerUrl: host?.controllerUrl ?? 'https://',
    streamUrl: host?.streamUrl ?? '',
    agentHostId: host?.agentHostId ?? '',
    runtime: host?.runtime ?? 'build-isolated',
    macosVersion: host?.macosVersion ?? '26',
    hardwareModel: host?.hardwareModel ?? '',
    chip: host?.chip ?? '',
    ramGb: host?.ramGb != null ? String(host.ramGb) : '',
    vmCapUnlocked: host?.vmCapUnlocked ?? false,
    maxSessions: String(host?.maxSessions ?? 2),
    scope: host?.scope ?? 'all',
    priority: String(host?.priority ?? 100),
    notes: host?.notes ?? '',
    platformToken: '',
    clearToken: false,
    serving: host?.serving ?? false,
  };
}

function toInput(f: FormState): SimHostInput {
  const int = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));
  return {
    name: f.name,
    controllerUrl: f.controllerUrl.trim(),
    streamUrl: f.streamUrl.trim() || null,
    agentHostId: f.agentHostId.trim() || null,
    runtime: f.runtime,
    macosVersion: f.macosVersion.trim(),
    hardwareModel: f.hardwareModel.trim() || null,
    chip: f.chip.trim() || null,
    ramGb: f.ramGb.trim() === '' ? null : int(f.ramGb),
    vmCapUnlocked: usesVms(f.runtime) && f.vmCapUnlocked,
    maxSessions: int(f.maxSessions),
    scope: f.scope,
    priority: int(f.priority),
    notes: f.notes.trim() || null,
  };
}

/** Add a host (host = null) or edit one. */
export function HostFormDialog({
  open,
  host,
  onClose,
  onSaved,
}: {
  open: boolean;
  host: SimHost | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState<FormState>(() => initial(host));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const formId = useId();

  useEffect(() => {
    if (open) {
      setForm(initial(host));
      setErrors({});
      setSubmitError(null);
      setAcknowledged(false);
    }
  }, [open, host]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => {
      if (!(key in e)) return e;
      const next = { ...e };
      delete next[key as string];
      return next;
    });
  };

  const unsecured = form.runtime === 'unsecure';
  const app = simulatorAppFor(form.macosVersion);
  // Edit: the serving switch lives on the card; only a new host is put into
  // service from here.
  const willServe = host ? host.serving : form.serving;
  // Same rule as the API: confirm when this edit puts an unsecured host into
  // service or widens who it serves.
  const needsAck =
    unsecured &&
    willServe &&
    (!host || host.runtime !== 'unsecure' || (host.scope === 'beta' && form.scope === 'all'));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const input = toInput(form);
    const found = validateSimHostInput(input);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    if (needsAck && !acknowledged) {
      setSubmitError('Confirm the unsecured runtime warning first.');
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      const tokenField = form.clearToken
        ? { platformToken: null }
        : form.platformToken.trim()
          ? { platformToken: form.platformToken.trim() }
          : {};
      const res = await fetch(host ? `/api/panel/sim-hosts/${host.id}` : '/api/panel/sim-hosts', {
        method: host ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input,
          ...tokenField,
          ...(host ? {} : { serving: form.serving }),
          acknowledgeUnsecured: needsAck ? acknowledged : undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> };
      if (!res.ok) {
        if (body.fields) setErrors(body.fields);
        setSubmitError(body.error ?? `Couldn't save (HTTP ${res.status}).`);
        return;
      }
      onSaved(host ? `Saved ${input.name}.` : `Added ${input.name}.`);
    } catch {
      setSubmitError('Network error. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const id = (name: string) => `${formId}-${name}`;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={host ? `Edit ${host.name}` : 'Add simulator host'}
      description="A Mac running the simulator controller and host agent. Botflow reaches it at its controller URL."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving ? 'Saving…' : host ? 'Save changes' : 'Add host'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-6">
        <fieldset className="space-y-4">
          <legend className="mb-3 text-[13px] font-semibold text-fg">Connection</legend>
          <Field label="Name" htmlFor={id('name')} error={errors.name}>
            <TextInput id={id('name')} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Mac mini (M4 Pro) #2" />
          </Field>
          <Field
            label="Controller URL"
            htmlFor={id('controllerUrl')}
            error={errors.controllerUrl}
            hint="The controller's public HTTPS address (tunnel or Funnel)."
          >
            <TextInput id={id('controllerUrl')} value={form.controllerUrl} onChange={(e) => set('controllerUrl', e.target.value)} inputMode="url" autoComplete="off" spellCheck={false} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Stream URL (optional)"
              htmlFor={id('streamUrl')}
              error={errors.streamUrl}
              hint="Leave blank to use the controller URL as wss://."
            >
              <TextInput id={id('streamUrl')} value={form.streamUrl} onChange={(e) => set('streamUrl', e.target.value)} placeholder="wss://…" autoComplete="off" spellCheck={false} />
            </Field>
            <Field
              label="Agent host id (optional)"
              htmlFor={id('agentHostId')}
              error={errors.agentHostId}
              hint="The id the agent reports, to match it in /health."
            >
              <TextInput id={id('agentHostId')} value={form.agentHostId} onChange={(e) => set('agentHostId', e.target.value)} placeholder="botflow-mba-26" autoComplete="off" spellCheck={false} />
            </Field>
          </div>
          <Field
            label="Platform token"
            htmlFor={id('platformToken')}
            hint={
              host?.hasOwnToken
                ? 'This host has its own token. Leave blank to keep it.'
                : "Leave blank to use this deployment's SIM_PLATFORM_TOKEN."
            }
          >
            <TextInput
              id={id('platformToken')}
              type="password"
              value={form.platformToken}
              onChange={(e) => set('platformToken', e.target.value)}
              autoComplete="new-password"
              disabled={form.clearToken}
              placeholder={host?.hasOwnToken ? '•••••••• (saved)' : ''}
            />
          </Field>
          {host?.hasOwnToken && (
            <label className="flex items-center gap-2 text-[13px] text-fg">
              <input type="checkbox" checked={form.clearToken} onChange={(e) => set('clearToken', e.target.checked)} className="accent-accent" />
              Remove the saved token and use SIM_PLATFORM_TOKEN
            </label>
          )}
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="mb-3 text-[13px] font-semibold text-fg">Runtime</legend>
          <div role="radiogroup" aria-label="Runtime" className="grid gap-2 sm:grid-cols-3">
            {(
              [
                { value: 'isolated', icon: ShieldCheck, tone: 'text-success', title: 'Fully isolated', text: 'Build and simulator both in VMs.' },
                { value: 'build-isolated', icon: ShieldHalf, tone: 'text-success', title: 'Build isolated', text: 'Builds in a VM; the simulator runs on the Mac.' },
                { value: 'unsecure', icon: ShieldAlert, tone: 'text-warning', title: 'Unsecured', text: 'Build and simulator directly on the Mac.' },
              ] as const
            ).map((opt) => {
              const selected = form.runtime === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => set('runtime', opt.value)}
                  className={cn(
                    'flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors',
                    selected ? 'border-accent bg-accent-soft' : 'border-border hover:border-border-strong',
                  )}
                >
                  <opt.icon className={cn('mt-0.5 h-4 w-4 shrink-0', opt.tone)} strokeWidth={1.75} />
                  <span>
                    <span className="block text-[13px] font-medium text-fg">{opt.title}</span>
                    <span className="block text-xs leading-relaxed text-muted">{opt.text}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {form.runtime === 'isolated' && <p className="text-xs leading-relaxed text-muted">{runtimeDescription(form.runtime)}</p>}
          {form.runtime === 'build-isolated' && (
            <Notice tone="info">
              The riskiest step, compiling (package plugins, build scripts and the compiler all run on user input), is
              contained in a throwaway VM. The finished app is then run by the simulator on the Mac, held back only by the
              restricted user&apos;s permissions.
            </Notice>
          )}
          {unsecured && (
            <Notice tone="warning">
              Users&apos; code will be compiled and run with this Mac&apos;s own privileges. Anyone routed here
              can read what else is on the machine. Keep unsecured hosts to <strong>beta users only</strong>,
              on a Mac that holds nothing else.
            </Notice>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="macOS version"
              htmlFor={id('macosVersion')}
              error={errors.macosVersion}
              hint={`Runs ${simulatorAppLabel(app)}${app === 'device-hub' ? ' (macOS 27 and later)' : ' (macOS 26)'}.`}
            >
              <TextInput id={id('macosVersion')} value={form.macosVersion} onChange={(e) => set('macosVersion', e.target.value)} placeholder="26.1" inputMode="decimal" />
            </Field>
            <Field
              label="Concurrent simulators"
              htmlFor={id('maxSessions')}
              error={errors.maxSessions}
              hint={
                form.runtime === 'isolated' && !form.vmCapUnlocked
                  ? `Up to ${STOCK_VM_LIMIT} on a stock Mac (one VM each).`
                  : 'The agent’s own slot count also applies.'
              }
            >
              <TextInput id={id('maxSessions')} value={form.maxSessions} onChange={(e) => set('maxSessions', e.target.value)} inputMode="numeric" />
            </Field>
          </div>
          {usesVms(form.runtime) && (
            <label className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <span>
                <span className="block text-[13px] font-medium text-fg">VM cap unlocked</span>
                <span className="block text-xs leading-relaxed text-muted">
                  The stock limit of {STOCK_VM_LIMIT} concurrent Virtualization.framework VMs has been removed on this Mac
                  {form.runtime === 'build-isolated' ? ' (it limits build VMs here, not simulators).' : '.'}
                </span>
              </span>
              <Switch checked={form.vmCapUnlocked} onChange={(v) => set('vmCapUnlocked', v)} aria-label="VM cap unlocked" />
            </label>
          )}
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="mb-3 text-[13px] font-semibold text-fg">Hardware</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Model" htmlFor={id('hardwareModel')}>
              <TextInput id={id('hardwareModel')} value={form.hardwareModel} onChange={(e) => set('hardwareModel', e.target.value)} placeholder="MacBook Air" />
            </Field>
            <Field label="Chip" htmlFor={id('chip')}>
              <TextInput id={id('chip')} value={form.chip} onChange={(e) => set('chip', e.target.value)} placeholder="Apple M2" />
            </Field>
            <Field label="Memory (GB)" htmlFor={id('ramGb')} error={errors.ramGb}>
              <TextInput id={id('ramGb')} value={form.ramGb} onChange={(e) => set('ramGb', e.target.value)} inputMode="numeric" placeholder="16" />
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="mb-3 text-[13px] font-semibold text-fg">Routing</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Serves" htmlFor={id('scope')} hint="Beta users have the beta flag on their account.">
              <Select id={id('scope')} value={form.scope} onChange={(e) => set('scope', e.target.value as 'all' | 'beta')}>
                <option value="all">Everyone</option>
                <option value="beta">Beta users only</option>
              </Select>
            </Field>
            <Field label="Priority" htmlFor={id('priority')} error={errors.priority} hint="Lower numbers are tried first.">
              <TextInput id={id('priority')} value={form.priority} onChange={(e) => set('priority', e.target.value)} inputMode="numeric" />
            </Field>
          </div>
          {!host && (
            <label className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <span>
                <span className="block text-[13px] font-medium text-fg">Start serving now</span>
                <span className="block text-xs leading-relaxed text-muted">
                  Off: the host is saved but gets no users until you switch it on. Test it first.
                </span>
              </span>
              <Switch checked={form.serving} onChange={(v) => set('serving', v)} aria-label="Start serving now" />
            </label>
          )}
          <Field label="Notes" htmlFor={id('notes')} error={errors.notes}>
            <TextArea id={id('notes')} value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} />
          </Field>
        </fieldset>

        {needsAck && (
          <label className="flex items-start gap-2.5 rounded-lg border border-danger-border bg-danger-soft p-3 text-[13px] leading-relaxed text-danger">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-1 accent-current" />
            <span>
              I understand this unsecured host runs {form.scope === 'all' ? 'every user’s' : 'beta users’'} code directly on the
              Mac, with no VM between it and the machine.
            </span>
          </label>
        )}
        {submitError && <p className="text-[13px] text-danger">{submitError}</p>}
      </form>
    </Dialog>
  );
}
