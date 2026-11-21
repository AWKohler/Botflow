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
  modelName,
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
    proPriceUsd: number;
    maxPriceUsd: number;
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
    revenue: { lifetimeNetUsd: number; last30dNetUsd: number; payingCustomers: number };
    legacy: {
      mrrUsd: number;
      lifetimeNetUsd: number;
      payingCustomers: number;
      productNames: string[];
    };
    accountTotals: {
      lifetimeGrossUsd: number;
      lifetimeRefundedUsd: number;
      lifetimeNetUsd: number;
    };
    health: { failedChargesLast30d: number; currencies: string[] };
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
              // Phone: the pill sits above the text, and the detail takes its own line.
              <Card key={a.label} className="flex flex-col items-start gap-2 py-3 sm:flex-row sm:items-center sm:gap-3">
                <StatusPill kind={a.severity} label={a.severity === 'serious' ? 'Serious' : 'Warning'} />
                <div>
                  <span className="block text-sm font-medium text-fg sm:inline">{a.label}</span>
                  <span className="block text-sm text-muted sm:ml-2 sm:inline">{a.detail}</span>
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
            <StatTile label="MRR (actual)" value={fmtUsd(stripe.mrrUsd)}
              sub={`${stripe.subscriptions.linkedToClerk} platform subscription${
                stripe.subscriptions.linkedToClerk === 1 ? '' : 's'
              }`} />
            <StatTile label="Lifetime revenue" value={fmtUsd(stripe.revenue.lifetimeNetUsd)}
              sub="net of refunds" />
            <StatTile label="Revenue, last 30d" value={fmtUsd(stripe.revenue.last30dNetUsd)} />
            <StatTile label="Paying customers" value={fmtNum(stripe.revenue.payingCustomers)}
              sub={`${stripe.attributedUsers} linked to a Botflow account`} />
            <StatTile label="Past due" value={String(stripe.subscriptions.pastDue)}
              tone={stripe.subscriptions.pastDue > 0 ? 'warning' : undefined} sub="failing payments" />
            <StatTile label="Canceled, 30d" value={String(stripe.subscriptions.canceledLast30d)}
              sub="churn" />
          </StatGrid>
          {(stripe.legacy.lifetimeNetUsd > 0 || stripe.legacy.mrrUsd > 0) && (
            <p className="text-xs text-muted mt-3">
              Excluded from the figures above: {fmtUsd(stripe.legacy.mrrUsd)}/mo and{' '}
              {fmtUsd(stripe.legacy.lifetimeNetUsd)} lifetime from{' '}
              {stripe.legacy.payingCustomers} customer
              {stripe.legacy.payingCustomers === 1 ? '' : 's'} on unrelated older products
              {stripe.legacy.productNames.length > 0 && `: ${stripe.legacy.productNames.join(', ')}`}.
              They share this Stripe account. Whole-account lifetime net is{' '}
              {fmtUsd(stripe.accountTotals.lifetimeNetUsd)}.
            </p>
          )}
        </Section>
      )}

      <Section
        title="Revenue — plan estimate"
        hint={`subscribers × plan price (${fmtUsd(revenue.proPriceUsd)} Pro / ${fmtUsd(
          revenue.maxPriceUsd,
        )} Max)`}
      >
        <StatGrid>
          <StatTile label="MRR (est.)" value={fmtUsd(revenue.mrrUsd)}
            sub={`${revenue.subscribers} paying subscriber${revenue.subscribers === 1 ? '' : 's'}`} />
          <StatTile label="Pro subscribers" value={fmtNum(revenue.paidPro)} />
          <StatTile label="Max subscribers" value={fmtNum(revenue.paidMax)} />
          <StatTile label="LLM cost this month" value={fmtUsd(revenue.llmCostThisMonthUsd)} />
          <StatTile
            label="Gross margin"
            value={fmtUsd(revenue.grossMarginUsd)}
            tone={revenue.grossMarginUsd < 0 ? 'danger' : undefined}
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
            sub={
              users.truncated
                ? 'directory truncated at 5,000'
                : `${fmtNum(revenue.betaUsers)} in the beta (Pro, $0)`
            }
          />
          <StatTile
            label="Users by plan"
            value={
              // Three exact counts as label/value rows: nothing to wrap or clip.
              <dl className="space-y-0.5 pt-0.5 text-[13px] font-medium leading-5 tracking-normal">
                {(
                  [
                    ['Free', users.free],
                    ['Pro', users.pro],
                    ['Max', users.max],
                  ] as const
                ).map(([plan, count]) => (
                  <div key={plan} className="flex items-baseline justify-between gap-3">
                    <dt className="font-normal text-muted">{plan}</dt>
                    <dd>{count.toLocaleString('en-US')}</dd>
                  </div>
                ))}
              </dl>
            }
          />
          <StatTile label="Active this month" value={fmtNum(users.activeThisMonth)}
            sub={`${fmtNum(users.activeLastMonth)} last month`} />
          <StatTile label="Signups, 7d" value={fmtNum(users.signups7d)} />
          <StatTile label="Signups, 30d" value={fmtNum(users.signups30d)} />
          <StatTile
            label="Near credit ceiling"
            value={fmtNum(users.usersOver80PctBudget)}
            tone={users.usersOver80PctBudget > 0 ? 'warning' : undefined}
            sub="≥80% of monthly budget"
          />
        </StatGrid>
      </Section>

      <Section title="Right now">
        <StatGrid>
          <StatTile label="Live sessions" value={fmtNum(activity.liveSessions)}
            sub="active in the last 10 min" />
          <StatTile label="Active projects" value={fmtNum(activity.activeProjects)}
            sub={`${fmtNum(activity.totalProjects)} ever created`} />
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
                label: modelName(m.model),
                value: m.costUsd,
                sub: `${fmtNum(m.users)} users · ${fmtPct(m.cacheHitRatePct)} cache`,
              }))}
              formatValue={(v) => fmtUsd(v)}
            />
          )}
        </Card>
      </Section>
    </div>
  );
}
