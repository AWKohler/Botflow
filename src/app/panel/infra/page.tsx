'use client';

import {
  Card,
  ErrorState,
  fmtNum,
  HBarList,
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

interface InfraData {
  projects: {
    total: number;
    active: number;
    deleted: number;
    byPlatform: Array<{ platform: string; count: number }>;
    bySandboxProvider: Array<{ provider: string; count: number }>;
    byReapStage: Array<{ stage: string; count: number }>;
    publicProjects: number;
    githubLinked: number;
    stripeEnabled: number;
    stripeLiveMode: number;
    revenuecatConnected: number;
    customDomains: number;
    liveSessionCount: number;
  };
  convex: {
    platformInstances: number;
    byStatus: Array<{ status: string; count: number }>;
    byocInstances: number;
    totalCallsLast30d: number;
    orphanedInstances: number;
    topByCalls: Array<{
      projectId: string;
      projectName: string;
      userId: string;
      calls: number;
      status: string;
    }>;
  };
  webhooks: {
    stripe: Array<{ status: string; mode: string; count: number }>;
    revenuecat: Array<{ status: string; count: number }>;
    recentFailures: Array<{
      source: string;
      projectId: string;
      canonicalType: string;
      attempts: number;
      lastStatus: number | null;
      lastError: string | null;
      updatedAt: string;
    }>;
  };
  ops: {
    convexUsageCronLastRun: string | null;
    stripeDeliveryLastActivity: string | null;
    revenuecatDeliveryLastActivity: string | null;
    pendingOauthRequests: number;
    pendingEnvVarRequests: number;
    pendingChatQuestions: number;
  };
  sandboxes: {
    byProvider: Array<{ provider: string; count: number }>;
    snapshotStorageUsd: number | null;
    snapshotPolicy: string;
  };
  generatedAt: string;
}

function deliveryStatusKind(status: string): StatusKind {
  if (status === 'delivered') return 'good';
  if (status === 'pending') return 'neutral';
  if (status === 'failed') return 'warning';
  return 'serious'; // exhausted
}

function convexStatusKind(status: string): StatusKind {
  if (status === 'active') return 'good';
  if (status === 'warned' || status === 'migrating') return 'warning';
  if (status === 'paused') return 'serious';
  return 'neutral';
}

export default function PanelInfraPage() {
  const { data, loading, error, refresh, refreshing } =
    usePanelData<InfraData>('/api/panel/infra');

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  const { projects, convex, webhooks, ops, sandboxes } = data;

  return (
    <div>
      <PageHeader
        title="Infrastructure"
        subtitle="Sandboxes, Convex backends, webhook pipelines, lifecycle"
        onRefresh={refresh}
        refreshing={refreshing}
        generatedAt={data.generatedAt}
      />

      <Section title="Projects & sandboxes">
        <StatGrid>
          <StatTile label="Active projects" value={fmtNum(projects.active)}
            sub={`${projects.deleted} soft-deleted`} />
          <StatTile label="Live sessions" value={String(projects.liveSessionCount)} accent />
          {sandboxes.byProvider.map((p) => (
            <StatTile key={p.provider} label={`${p.provider} sandboxes`} value={fmtNum(p.count)} />
          ))}
          <StatTile label="Public projects" value={String(projects.publicProjects)} />
          <StatTile label="GitHub linked" value={String(projects.githubLinked)} />
        </StatGrid>
        <p className="text-xs text-muted mt-3">
          Snapshot storage: {sandboxes.snapshotPolicy}. Per-sandbox sizes aren&apos;t
          metered yet, so storage cost isn&apos;t computable — needs the
          sandbox-session instrumentation.
        </p>
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <Section title="By platform" className="mb-0">
          <Card>
            <HBarList
              rows={projects.byPlatform.map((p) => ({ label: p.platform, value: p.count }))}
            />
          </Card>
        </Section>
        <Section title="Reaper pipeline" hint="free-tier lifecycle stages" className="mb-0">
          <Card>
            <HBarList
              rows={projects.byReapStage.map((s) => ({ label: s.stage, value: s.count }))}
            />
          </Card>
        </Section>
      </div>

      <Section title="Convex backends">
        <StatGrid>
          <StatTile label="Platform instances" value={fmtNum(convex.platformInstances)} accent
            sub="on the Botflow Convex team" />
          <StatTile label="BYOC instances" value={fmtNum(convex.byocInstances)}
            sub="user-billed" />
          <StatTile label="Calls, last 30d" value={fmtNum(convex.totalCallsLast30d)} />
          <StatTile label="Orphaned" value={String(convex.orphanedInstances)}
            warn={convex.orphanedInstances > 0}
            sub="backends on deleted projects" />
        </StatGrid>
        <div className="flex flex-wrap gap-2 mt-3">
          {convex.byStatus.map((s) => (
            <span key={s.status} className="flex items-center gap-1.5 text-sm text-fg">
              <StatusPill kind={convexStatusKind(s.status)} label={s.status} />
              <span className="tabular-nums">{s.count}</span>
            </span>
          ))}
        </div>
        {convex.topByCalls.length > 0 && (
          <Card className="mt-4 overflow-x-auto modern-scrollbar">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted mb-3">
              Top backends by calls (30d)
            </h3>
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="text-left text-muted border-b border-border">
                  <th className="py-1.5 pr-3 font-medium">Project</th>
                  <th className="py-1.5 pr-3 font-medium">Owner</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 font-medium text-right">Calls</th>
                </tr>
              </thead>
              <tbody>
                {convex.topByCalls.map((t) => (
                  <tr key={t.projectId} className="border-b border-border/60 last:border-0">
                    <td className="py-1.5 pr-3 text-fg truncate max-w-[200px]" title={t.projectId}>
                      {t.projectName}
                    </td>
                    <td className="py-1.5 pr-3 text-muted font-mono text-xs truncate max-w-[180px]">
                      {t.userId}
                    </td>
                    <td className="py-1.5 pr-3">
                      <StatusPill kind={convexStatusKind(t.status)} label={t.status} />
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-fg">{fmtNum(t.calls)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      <Section title="Payment webhook pipelines" hint="durable outbox delivery to project backends">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted mb-3">Stripe</h3>
            {webhooks.stripe.length === 0 ? (
              <p className="text-sm text-muted">No deliveries yet.</p>
            ) : (
              <div className="space-y-1.5">
                {webhooks.stripe.map((s) => (
                  <div key={`${s.status}-${s.mode}`} className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <StatusPill kind={deliveryStatusKind(s.status)} label={s.status} />
                      <span className="text-xs text-muted">{s.mode}</span>
                    </span>
                    <span className="text-sm tabular-nums text-fg">{fmtNum(s.count)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted mb-3">RevenueCat</h3>
            {webhooks.revenuecat.length === 0 ? (
              <p className="text-sm text-muted">No deliveries yet.</p>
            ) : (
              <div className="space-y-1.5">
                {webhooks.revenuecat.map((s) => (
                  <div key={s.status} className="flex items-center justify-between">
                    <StatusPill kind={deliveryStatusKind(s.status)} label={s.status} />
                    <span className="text-sm tabular-nums text-fg">{fmtNum(s.count)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
        {webhooks.recentFailures.length > 0 && (
          <Card className="mt-4 overflow-x-auto modern-scrollbar">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted mb-3">
              Recent delivery failures
            </h3>
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-left text-muted border-b border-border">
                  <th className="py-1.5 pr-3 font-medium">Source</th>
                  <th className="py-1.5 pr-3 font-medium">Event</th>
                  <th className="py-1.5 pr-3 font-medium">Attempts</th>
                  <th className="py-1.5 pr-3 font-medium">Last error</th>
                  <th className="py-1.5 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {webhooks.recentFailures.map((f, i) => (
                  <tr key={i} className="border-b border-border/60 last:border-0">
                    <td className="py-1.5 pr-3 text-fg capitalize">{f.source}</td>
                    <td className="py-1.5 pr-3 text-fg">{f.canonicalType}</td>
                    <td className="py-1.5 pr-3 tabular-nums text-fg">
                      {f.attempts}
                      {f.lastStatus != null && (
                        <span className="text-muted text-xs ml-1">(HTTP {f.lastStatus})</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-muted text-xs truncate max-w-[240px]" title={f.lastError ?? ''}>
                      {f.lastError ?? '—'}
                    </td>
                    <td className="py-1.5 text-muted whitespace-nowrap">{timeAgo(f.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      <Section title="Ops signals" hint="cron liveness + pending human-in-the-loop items">
        <StatGrid>
          <StatTile label="Convex usage cron" value={timeAgo(ops.convexUsageCronLastRun)}
            sub="last poll" />
          <StatTile label="Stripe delivery activity" value={timeAgo(ops.stripeDeliveryLastActivity)} />
          <StatTile label="RC delivery activity" value={timeAgo(ops.revenuecatDeliveryLastActivity)} />
          <StatTile label="Pending OAuth modals" value={String(ops.pendingOauthRequests)} />
          <StatTile label="Pending env-var modals" value={String(ops.pendingEnvVarRequests)} />
          <StatTile label="Pending agent questions" value={String(ops.pendingChatQuestions)} />
        </StatGrid>
      </Section>
    </div>
  );
}
