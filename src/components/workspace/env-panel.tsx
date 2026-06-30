'use client';

import { Input } from "@/components/ui/input";
import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Plus, Trash2, Eye, EyeOff, Lock, RefreshCw, Globe, Server, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FrontendVar {
  id?: string;
  key: string;
  value: string;
  isSecret: boolean;
}

interface SystemVar {
  key: string;
  value: string;
}

interface BackendVar {
  key: string;
  value: string;
  reserved: boolean;
}

interface EnvPanelProps {
  projectId: string;
  onEnvVarsChange?: () => void;
}

type Scope = 'frontend' | 'backend';

export function EnvPanel({ projectId, onEnvVarsChange }: EnvPanelProps) {
  // Frontend (DB-backed) state
  const [frontendVars, setFrontendVars] = useState<FrontendVar[]>([]);
  const [systemVars, setSystemVars] = useState<SystemVar[]>([]);

  // Backend (live Convex) state
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [backendVars, setBackendVars] = useState<BackendVar[]>([]);
  const [backendError, setBackendError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [showValues, setShowValues] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Add-new form state, one per scope
  const [newKey, setNewKey] = useState<Record<Scope, string>>({ frontend: '', backend: '' });
  const [newValue, setNewValue] = useState<Record<Scope, string>>({ frontend: '', backend: '' });
  const [newSecret, setNewSecret] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchAll = useCallback(async () => {
    setError(null);
    try {
      const [feRes, beRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/env`),
        fetch(`/api/projects/${projectId}/env/backend`),
      ]);

      if (feRes.ok) {
        const data = await feRes.json();
        setFrontendVars(data.envVars || []);
        setSystemVars(data.systemEnvVars || []);
      } else {
        setError('Failed to load frontend variables');
      }

      if (beRes.ok) {
        const data = await beRes.json();
        setBackendAvailable(Boolean(data.available));
        setBackendVars(data.vars || []);
        setBackendError(data.error || null);
      } else if (beRes.status === 502) {
        const data = await beRes.json().catch(() => ({}));
        setBackendAvailable(true);
        setBackendError(data.error || 'Could not reach the Convex backend');
      }
    } catch (e) {
      console.error('Failed to fetch env vars:', e);
      setError('Failed to load environment variables');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleAdd = async (scope: Scope) => {
    const key = newKey[scope].trim();
    if (!key) return;
    setError(null);
    setSaving(true);
    try {
      const url =
        scope === 'frontend'
          ? `/api/projects/${projectId}/env`
          : `/api/projects/${projectId}/env/backend`;
      const body =
        scope === 'frontend'
          ? { key: key.toUpperCase(), value: newValue[scope], isSecret: newSecret }
          : { key: key.toUpperCase(), value: newValue[scope] };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setNewKey((p) => ({ ...p, [scope]: '' }));
        setNewValue((p) => ({ ...p, [scope]: '' }));
        setNewSecret(false);
        await fetchAll();
        onEnvVarsChange?.();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to add variable');
      }
    } catch (e) {
      console.error('Failed to add env var:', e);
      setError('Failed to add variable');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (scope: Scope, key: string) => {
    setError(null);
    try {
      const url =
        scope === 'frontend'
          ? `/api/projects/${projectId}/env`
          : `/api/projects/${projectId}/env/backend`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to delete variable');
        return;
      }
      await fetchAll();
      onEnvVarsChange?.();
    } catch (e) {
      console.error('Failed to delete env var:', e);
      setError('Failed to delete variable');
    }
  };

  const toggleShowValue = (key: string) => {
    setShowValues((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="p-4 text-muted flex items-center gap-2">
        <RefreshCw size={14} className="animate-spin" />
        Loading...
      </div>
    );
  }

  const renderAddForm = (scope: Scope) => (
    <div className="space-y-2 pt-2">
      <div className="flex gap-2">
        <Input
          value={newKey[scope]}
          onChange={(e) =>
            setNewKey((p) => ({ ...p, [scope]: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') }))
          }
          placeholder="KEY_NAME"
          className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <div className="flex gap-2">
        <Input
          value={newValue[scope]}
          onChange={(e) => setNewValue((p) => ({ ...p, [scope]: e.target.value }))}
          placeholder="value"
          type={scope === 'frontend' && newSecret ? 'password' : 'text'}
          className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent"
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(scope); }}
        />
      </div>
      <div className="flex items-center justify-between">
        {scope === 'frontend' ? (
          <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={newSecret}
              onChange={(e) => setNewSecret(e.target.checked)}
              className="rounded border-border bg-surface"
            />
            Mask in this list
          </label>
        ) : <span />}
        <Button
          size="sm"
          onClick={() => handleAdd(scope)}
          disabled={!newKey[scope].trim() || saving}
          className="h-7 text-xs"
        >
          <Plus size={14} className="mr-1" />
          Add
        </Button>
      </div>
    </div>
  );

  const renderRow = (
    key: string,
    value: string,
    opts: { scope: Scope; locked?: boolean; lockLabel?: string; secret?: boolean },
  ) => {
    const masked = opts.secret && !showValues.has(key);
    return (
      <div
        key={key}
        className={cn(
          'flex items-center gap-2 p-2 rounded-md border',
          opts.locked
            ? 'bg-elevated/50 border-border/50'
            : 'bg-elevated border-border hover:border-accent/30 transition-colors',
        )}
      >
        {opts.locked && <Lock size={12} className="text-muted flex-shrink-0" />}
        <span className={cn('font-mono text-xs flex-shrink-0', opts.locked ? 'text-muted' : 'text-fg')}>{key}</span>
        <span className="text-muted flex-shrink-0">=</span>
        <span
          className={cn('font-mono text-xs truncate flex-1', opts.locked ? 'text-muted' : 'text-fg')}
          title={masked ? undefined : value}
        >
          {masked ? '••••••••' : value || <span className="italic text-muted">(empty)</span>}
        </span>
        {opts.locked && opts.lockLabel && (
          <span className="text-[10px] text-muted bg-soft/60 rounded px-1.5 py-0.5 flex-shrink-0">
            {opts.lockLabel}
          </span>
        )}
        {opts.secret && (
          <button
            onClick={() => toggleShowValue(key)}
            className="text-muted hover:text-fg transition-colors flex-shrink-0"
            title={showValues.has(key) ? 'Hide value' : 'Show value'}
          >
            {showValues.has(key) ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
        {!opts.locked && (
          <button
            onClick={() => handleDelete(opts.scope, key)}
            className="text-muted hover:text-red-400 transition-colors flex-shrink-0"
            title="Delete variable"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="p-3 text-sm space-y-5 overflow-y-auto modern-scrollbar">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-fg text-xs uppercase tracking-wide">Environment Variables</h3>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={fetchAll} title="Refresh">
          <RefreshCw size={14} />
        </Button>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-400/10 rounded px-2 py-1.5 border border-red-400/20">
          {error}
        </div>
      )}

      {/* ───────── Frontend section ───────── */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Globe size={13} className="text-accent" />
          <span className="text-xs font-semibold text-fg">Frontend</span>
        </div>
        <p className="text-[11px] text-muted leading-snug">
          Visible to anyone who uses your app — these are bundled into the site. Don’t put secrets here.
        </p>

        {systemVars.map((v) => renderRow(v.key, v.value, { scope: 'frontend', locked: true, lockLabel: 'Managed' }))}
        {frontendVars.map((v) =>
          renderRow(v.key, v.value, { scope: 'frontend', secret: v.isSecret }),
        )}
        {frontendVars.length === 0 && systemVars.length === 0 && (
          <p className="text-xs text-muted italic py-1">No frontend variables yet.</p>
        )}

        {renderAddForm('frontend')}
      </section>

      {/* ───────── Backend section ───────── */}
      {backendAvailable && (
        <section className="space-y-2 pt-3 border-t border-border">
          <div className="flex items-center gap-2">
            <Server size={13} className="text-emerald-400" />
            <span className="text-xs font-semibold text-fg">Backend</span>
          </div>
          <p className="text-[11px] text-muted leading-snug">
            Secret, server-only values used by your Convex backend. Synced live with the Convex dashboard.
          </p>

          {backendError ? (
            <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-400/10 rounded px-2 py-1.5 border border-amber-400/20">
              <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
              <span>{backendError}</span>
            </div>
          ) : (
            <>
              {backendVars.map((v) =>
                renderRow(v.key, v.value, {
                  scope: 'backend',
                  locked: v.reserved,
                  lockLabel: v.reserved ? 'Managed' : undefined,
                  secret: !v.reserved,
                }),
              )}
              {backendVars.length === 0 && (
                <p className="text-xs text-muted italic py-1">No backend variables yet.</p>
              )}
              {renderAddForm('backend')}
            </>
          )}
        </section>
      )}
    </div>
  );
}
