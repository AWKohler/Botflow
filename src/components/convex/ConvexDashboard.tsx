"use client";

import { useEffect, useRef, useState } from 'react';

interface ConvexDashboardProps {
  projectId: string;
  /** projects.convexStatus — when 'paused', an interstitial replaces the
   *  embedded dashboard and explains why queries are failing. */
  convexStatus?: string | null;
  /** Whether the viewer owns the project (drives the resolution CTA). */
  isOwner?: boolean;
}

interface DashboardSession {
  deploymentUrl: string;
  deploymentName: string;
  adminKey: string;
}

export function ConvexDashboard({ projectId, convexStatus, isOwner = true }: ConvexDashboardProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paused = convexStatus === 'paused';

  // Fetch credentials once per projectId
  useEffect(() => {
    if (paused) return; // interstitial replaces the dashboard; skip the session fetch
    setSession(null);
    setError(null);
    fetch(`/api/projects/${projectId}/database-session`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<DashboardSession>;
      })
      .then(setSession)
      .catch((err) => setError(err.message));
  }, [projectId, paused]);

  // Listen for credential requests from the embedded dashboard and respond
  useEffect(() => {
    if (!session) return;

    function handleMessage(event: MessageEvent) {
      if (event.origin !== 'https://dashboard-embedded.convex.dev') return;
      if (event.data?.type !== 'dashboard-credentials-request') return;

      iframeRef.current?.contentWindow?.postMessage(
        {
          type: 'dashboard-credentials',
          adminKey: session!.adminKey,
          deploymentUrl: session!.deploymentUrl,
          deploymentName: session!.deploymentName,
        },
        'https://dashboard-embedded.convex.dev'
      );
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [session]);

  if (paused) {
    // Explain the failures the user is already seeing — without this, a
    // paused backend reads as "the platform broke my database".
    return (
      <div className="flex items-center justify-center w-full h-full p-6">
        <div className="max-w-md rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm text-red-400 space-y-2">
          <p className="font-semibold">This backend is paused</p>
          <p className="opacity-90">
            Usage exceeded platform limits, so the database and functions are
            paused — that&apos;s why queries are failing right now. Your data is
            safe and nothing has been deleted.
          </p>
          {isOwner ? (
            <p className="opacity-90">
              <a
                href="mailto:support@botflow.io?subject=Convex%20backend%20paused"
                className="underline underline-offset-2"
              >
                Contact us
              </a>{' '}
              to resolve it — including moving this backend to your own Convex
              account so it&apos;s never capped by platform limits.
            </p>
          ) : (
            <p className="opacity-90">Only the project owner can resolve this.</p>
          )}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center w-full h-full text-sm text-red-500">
        {error}
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center w-full h-full text-sm text-gray-400">
        Loading database…
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src="https://dashboard-embedded.convex.dev"
      className="w-full h-full border-none"
      allow="clipboard-write"
      title="Convex Database Dashboard"
    />
  );
}
