'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
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
      <div className="flex min-h-screen items-center justify-center bg-bg px-6 text-fg">
        <EmptyState
          icon={AlertTriangle}
          tone="danger"
          title="The upgrade didn’t finish"
          description={
            <>
              Something went wrong moving this project to the new sandbox runtime. Your files are safe.
              {error && <span className="mt-2 block break-words text-xs text-subtle">{error}</span>}
            </>
          }
          action={
            <button
              onClick={() => { startedRef.current = true; run(); }}
              className={buttonClass({ variant: 'primary' })}
            >
              Try again
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6 text-fg">
      <div className="flex max-w-sm flex-col items-center text-center">
        <Loader2 className="mb-4 h-5 w-5 animate-spin text-muted" />
        <h1 className="text-[15px] font-semibold">Upgrading this project…</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          We’re moving it to Botflow’s faster sandbox runtime. This happens once and only takes a moment.
        </p>
      </div>
    </div>
  );
}
