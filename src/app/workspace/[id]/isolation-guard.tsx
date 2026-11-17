'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { PersistentWorkspace } from '@/components/persistent-workspace';
import { SandboxedWebWorkspace } from '@/components/sandboxed-web-workspace';
import type { ProjectPlatform, BackendType } from '@/lib/project-platform';

interface Props {
  projectId: string;
  initialPrompt?: string;
  platform?: ProjectPlatform;
  backendType?: BackendType;
}

/**
 * Routes a project to its workspace runtime by platform:
 *   - swift          → PersistentWorkspace (Vercel sandbox, iOS)
 *   - sandboxed-web  → SandboxedWebWorkspace ("Web", Vercel sandbox)
 *   - web (legacy)   → migrate the WebContainer project onto a sandbox, then
 *                      render it as a sandboxed-web project
 *
 * Vercel sandboxes run server-side, so the old WebContainer cross-origin
 * isolation reload and desktop-only device gate are no longer needed.
 */
export function IsolationGuard({ projectId, initialPrompt, platform, backendType }: Props) {
  if (platform === 'swift') {
    return <PersistentWorkspace projectId={projectId} initialPrompt={initialPrompt} platform={platform} />;
  }
  if (platform === 'web') {
    return (
      <WebContainerMigrationGate
        projectId={projectId}
        initialPrompt={initialPrompt}
        backendType={backendType}
      />
    );
  }
  return <SandboxedWebWorkspace projectId={projectId} initialPrompt={initialPrompt} backendType={backendType} />;
}

/**
 * One-time, on-open migration of a legacy WebContainer project onto a Vercel
 * sandbox. Shows a loading state while the server restores the saved files into
 * a fresh sandbox, then hands off to the normal sandbox workspace. The POST is
 * idempotent, so retries (and double-opens) are safe.
 */
function WebContainerMigrationGate({
  projectId,
  initialPrompt,
  backendType,
}: {
  projectId: string;
  initialPrompt?: string;
  backendType?: BackendType;
}) {
  const [status, setStatus] = useState<'migrating' | 'done' | 'error'>('migrating');
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const run = useCallback(async () => {
    setStatus('migrating');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/migrate-to-sandbox`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Migration failed (${res.status})`);
      }
      setStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Migration failed');
      setStatus('error');
    }
  }, [projectId]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    run();
  }, [run]);

  if (status === 'done') {
    return (
      <SandboxedWebWorkspace projectId={projectId} initialPrompt={initialPrompt} backendType={backendType} />
    );
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--sand-bg)] text-[var(--sand-text)] px-4">
        <div className="max-w-md text-center space-y-5 p-8 rounded-2xl border border-border bg-white shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-warning-soft">
            <AlertTriangle className="h-7 w-7 text-warning" />
          </div>
          <h1 className="text-2xl font-semibold text-neutral-900">Upgrade didn&apos;t finish</h1>
          <p className="text-sm text-neutral-600 leading-relaxed">
            We hit a snag moving this project to the new sandbox runtime. Your files are safe — you can try again.
          </p>
          {error && <p className="text-xs text-neutral-400 break-words">{error}</p>}
          <button
            onClick={() => { startedRef.current = true; run(); }}
            className="inline-flex items-center gap-2 rounded-xl bg-black px-4 py-2 text-sm font-medium text-white shadow hover:opacity-90 transition"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--sand-bg)] text-[var(--sand-text)] px-4">
      <div className="max-w-md text-center space-y-5 p-8 rounded-2xl border border-border bg-white shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-neutral-100">
          <Loader2 className="h-7 w-7 text-neutral-500 animate-spin" />
        </div>
        <h1 className="text-2xl font-semibold text-neutral-900">Upgrading this project…</h1>
        <p className="text-sm text-neutral-600 leading-relaxed">
          We&apos;re moving this project to Botflow&apos;s faster sandbox runtime. This only happens once and takes a moment.
        </p>
      </div>
    </div>
  );
}
