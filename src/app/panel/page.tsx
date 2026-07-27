'use client';

import {
  Card,
  ErrorState,
  fmtNum,
  fmtPct,
  fmtUsd,
  HBarList,
  LoadingState,
  MiniBars,
  PageHeader,
  Section,
  StatGrid,
  StatTile,
  StatusPill,
  usePanelData,
} from '@/components/panel/ui';

interface OverviewData {
  revenue: {
    mrrUsd: number;
    estimated: boolean;
    pricesConfigured: boolean;
    paidPro: number;
    paidMax: number;
    subscribers: number;
    betaUsers: number;
    grossMarginUsd: number;
    marginBasis: 'stripe' | 'estimate';
    llmCostThisMonthUsd: number;
  };
  stripe: {
    configured: boolean;
    error: string | null;
    account: { id: string; name: string | null } | null;
    mrrUsd: number;
    subscriptions: {
      total: number;
      byStatus: Array<{ status: string; count: number }>;
      pastDue: number;
      canceledLast30d: number;
      linkedToClerk: number;
    };
    revenue: {
      lifetimeGrossUsd: number;
      lifetimeRefundedUsd: number;
      lifetimeNetUsd: number;
      last30dNetUsd: number;
      payingCustomers: number;
      unlinkedNetUsd: number;
      unlinkedPayers: number;
    };
    health: { failedChargesLast30d: number; currencies: string[] };
    products: Array<{ name: string; monthlyUsd: number; active: boolean }>;
    attributedUsers: number;
    truncated: boolean;
  };
  users: {
    total: number;
    truncated: boolean;
    free: number;
    pro: number;
    max: number;
    signups7d: number;
    signups30d: number;
    activeThisMonth: number;
    activeLastMonth: number;
    usersOver80PctBudget: number;
  };
  usage: {
    thisMonth: {
      credits: number;
      costUsd: number;
      activeUsers: number;
      turns: number;
      tokensIn: number;
      tokensOut: number;
      cachedRead: number;
      cacheHitRatePct: number;
    };
    lastMonth: { credits: number; costUsd: number; turns: number };
    momCreditsGrowthPct: number | null;
    monthlyTrend: Array<{ period: string; costUsd: number; activeUsers: number; turns: number }>;
    byModelThisMonth: Array<{
      model: string;
      costUsd: number;
      users: number;
      turns: number;
      cacheHitRatePct: number;
    }>;
    lifetimeCostUsd: number;
  };
  activity: {
    liveSessions: number;
    activeProjects: number;
    totalProjects: number;
    projectsCreatedByMonth: Array<{ month: string; created: number }>;
  };
  alerts: Array<{ severity: 'warning' | 'serious'; label: string; detail: string }>;
  generatedAt: string;
}

export default function PanelOverviewPage() {
  const { data, loading, error, refresh, refreshing } =
    usePanelData<OverviewData>('/api/panel/overview');

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  const { revenue, users, usage, activity, alerts, stripe } = data;

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="Platform at a glance — revenue, usage, and health"
        onRefresh={refresh}
        refreshing={refreshing}
        generatedAt={data.generatedAt}
      />

      {alerts.length > 0 && (
        <Section title="Needs attention">
          <div className="space-y-2">
            {alerts.map((a) => (
              <Card key={a.label} className="flex items-center gap-3 py-3">
                <StatusPill kind={a.severity} label={a.severity === 'serious' ? 'Serious' : 'Warning'} />
                <div>
                  <span className="text-sm font-medium text-fg">{a.label}</span>
                  <span className="text-sm text-muted ml-2">{a.detail}</span>
                </div>
              </Card>
            ))}
          </div>
        </Section>
      )}

      {stripe.configured && !stripe.error && (
        <Section
          title="Revenue — Stripe"
          hint={`actual, from ${stripe.account?.name ?? 'the platform account'}${
            stripe.truncated ? ' (paged data truncated — figures are a lower bound)' : ''
          }`}
        >
          <StatGrid>
            <StatTile label="MRR (actual)" value={fmtUsd(stripe.mrrUsd)} accent
              sub={`${stripe.subscriptions.byStatus.find((s) => s.status === 'active')?.count ?? 0} active sub${
                (stripe.subscriptions.byStatus.find((s) => s.status === 'active')?.count ?? 0) === 1 ? '' : 's'
              }`} />
            <StatTile label="Lifetime revenue" value={fmtUsd(stripe.revenue.lifetimeNetUsd, { cents: true })}
              sub={`net of ${fmtUsd(stripe.revenue.lifetimeRefundedUsd, { cents: true })} refunded`} />
            <StatTile label="Revenue, last 30d" value={fmtUsd(stripe.revenue.last30dNetUsd, { cents: true })} />
            <StatTile label="Paying customers" value={String(stripe.revenue.payingCustomers)}
              sub={`${stripe.attributedUsers} linked to a Clerk user`} />
            <StatTile label="Past due" value={String(stripe.subscriptions.pastDue)}
              warn={stripe.subscriptions.pastDue > 0} sub="failing payments" />
            <StatTile label="Canceled, 30d" value={String(stripe.subscriptions.canceledLast30d)}
              warn={stripe.subscriptions.canceledLast30d > 0} sub="churn" />
          </StatGrid>
          {stripe.revenue.unlinkedNetUsd > 0 && (
            <p className="text-xs text-muted mt-3">
              {fmtUsd(stripe.revenue.unlinkedNetUsd)} of lifetime revenue comes from{' '}
              {stripe.revenue.unlinkedPayers} customer
              {stripe.revenue.unlinkedPayers === 1 ? '' : 's'} with no Clerk id in metadata
              (legacy products: {stripe.products.map((p) => p.name).join(', ') || 'n/a'}) — that
              revenue can&apos;t be attributed to a user in the table.
            </p>
          )}
        </Section>
      )}

      <Section
        title="Revenue — plan estimate"
        hint={
          revenue.pricesConfigured
            ? 'subscribers × configured plan price'
            : 'DEFAULT prices — set PANEL_PRICE_PRO_USD / PANEL_PRICE_MAX_USD'
        }
      >
        <StatGrid>
          <StatTile label="MRR (est.)" value={fmtUsd(revenue.mrrUsd)}
            sub={`${revenue.subscribers} paying subscriber${revenue.subscribers === 1 ? '' : 's'}`} />
          <StatTile label="Pro subscribers" value={String(revenue.paidPro)} />
          <StatTile label="Max subscribers" value={String(revenue.paidMax)} />
          <StatTile label="LLM cost this month" value={fmtUsd(revenue.llmCostThisMonthUsd)} />
          <StatTile
            label="Gross margin"
            value={fmtUsd(revenue.grossMarginUsd)}
            warn={revenue.grossMarginUsd < 0}
            sub={`${revenue.marginBasis === 'stripe' ? 'Stripe MRR' : 'est. MRR'} − LLM cost; excludes sandbox/Convex`}
          />
          <StatTile label="Lifetime LLM cost" value={fmtUsd(usage.lifetimeCostUsd)} />
        </StatGrid>
      </Section>

      <Section title="Users">
        <StatGrid>
          <StatTile
            label="Total users"
            value={fmtNum(users.total)}
            sub={users.truncated ? 'directory truncated at 5,000' : undefined}
          />
          <StatTile label="Free / Pro / Max" value={`${users.free} / ${users.pro} / ${users.max}`}
            sub={`${revenue.betaUsers} beta (pro floor, $0)`} />
          <StatTile label="Active this month" value={fmtNum(users.activeThisMonth)}
            sub={`${users.activeLastMonth} last month`} />
          <StatTile label="Signups, 7d" value={String(users.signups7d)} />
          <StatTile label="Signups, 30d" value={String(users.signups30d)} />
          <StatTile
            label="Near credit ceiling"
            value={String(users.usersOver80PctBudget)}
            warn={users.usersOver80PctBudget > 0}
            sub="≥80% of monthly budget"
          />
        </StatGrid>
      </Section>

      <Section title="Right now">
        <StatGrid>
          <StatTile label="Live sessions" value={String(activity.liveSessions)} accent
            sub="active in the last 10 min" />
          <StatTile label="Active projects" value={fmtNum(activity.activeProjects)}
            sub={`${activity.totalProjects} ever created`} />
          <StatTile label="Agent turns this month" value={fmtNum(usage.thisMonth.turns)}
            sub={`${fmtNum(usage.lastMonth.turns)} last month`} />
          <StatTile label="Cache hit rate" value={fmtPct(usage.thisMonth.cacheHitRatePct)}
            sub="this month, all models" />
          <StatTile
            label="MoM credit growth"
            value={usage.momCreditsGrowthPct == null ? '—' : fmtPct(usage.momCreditsGrowthPct)}
          />
          <StatTile label="Tokens out this month" value={fmtNum(usage.thisMonth.tokensOut)} />
        </StatGrid>
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Monthly LLM cost" hint="USD, platform-metered" className="mb-0">
          <Card>
            <MiniBars
              data={usage.monthlyTrend.map((m) => ({
                label: m.period,
                value: m.costUsd,
              }))}
              formatValue={(v) => fmtUsd(v)}
              height={120}
            />
          </Card>
        </Section>
        <Section title="Projects created per month" className="mb-0">
          <Card>
            <MiniBars
              data={activity.projectsCreatedByMonth.map((m) => ({
                label: m.month,
                value: m.created,
              }))}
              height={120}
            />
          </Card>
        </Section>
      </div>

      <Section title="Cost by model, this month" className="mt-8">
        <Card>
          {usage.byModelThisMonth.length === 0 ? (
            <p className="text-sm text-muted">No usage recorded this month yet.</p>
          ) : (
            <HBarList
              rows={usage.byModelThisMonth.map((m) => ({
                label: m.model,
                value: m.costUsd,
                sub: `${m.users} users · ${fmtPct(m.cacheHitRatePct)} cache`,
              }))}
              formatValue={(v) => fmtUsd(v)}
            />
          )}
        </Card>
      </Section>
    </div>
  );
}
