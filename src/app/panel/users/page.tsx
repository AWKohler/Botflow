'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { TextInput } from '@/components/ui/field';
import { Tabs } from '@/components/ui/tabs';
import {
  ErrorState,
  fmtNum,
  fmtUsd,
  LoadingState,
  Meter,
  PageHeader,
  StatusPill,
  timeAgo,
  usePanelData,
} from '@/components/panel/ui';
import { tableHeadRowClass } from '@/components/ui/table';

interface UserRow {
  userId: string;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
  tier: 'free' | 'pro' | 'max';
  plan: string | null;
  isBeta: boolean;
  joinedAt: string;
  lastSignInAt: string | null;
  lastActiveAt: string | null;
  liveNow: boolean;
  projectCount: number;
  convexInstances: number;
  convexPaused: number;
  cfDeployments: number;
  vercelSandboxes: number;
  sandboxHostSandboxes: number;
  stripeLiveProjects: number;
  revenuecatProjects: number;
  managedDomains: number;
  monthCredits: number;
  monthCostUsd: number;
  monthTurns: number;
  lifetimeCredits: number;
  lifetimeCostUsd: number;
  lifetimeTurns: number;
  models: string[];
  budgetUtilPct: number;
  monthRevenueUsd: number;
  revenueBasis: 'stripe' | 'estimate';
  lifetimeRevenueUsd: number;
  stripeMonthRevenueUsd: number;
  stripeSubscription: { status: string; product: string; monthlyUsd: number } | null;
  monthMarginUsd: number;
}

interface UsersData {
  rows: UserRow[];
  totalCount: number;
  truncated: boolean;
  stripe: {
    configured: boolean;
    error: string | null;
    attributedUsers: number;
    lifetimeNetUsd: number;
  };
  generatedAt: string;
}

type SortKey =
  | 'monthMarginUsd'
  | 'monthCostUsd'
  | 'monthRevenueUsd'
  | 'lifetimeRevenueUsd'
  | 'lifetimeCostUsd'
  | 'projectCount'
  | 'convexInstances'
  | 'budgetUtilPct'
  | 'lastActiveAt'
  | 'joinedAt';

const COLUMNS: Array<{ key: SortKey; label: string; title?: string }> = [
  { key: 'monthMarginUsd', label: 'Margin/mo', title: 'Revenue − LLM cost, this month' },
  { key: 'monthRevenueUsd', label: 'Revenue/mo', title: 'Stripe subscription if linked, else plan sticker price' },
  { key: 'monthCostUsd', label: 'Cost/mo' },
  { key: 'lifetimeRevenueUsd', label: 'Lifetime rev', title: 'Real Stripe revenue, net of refunds' },
  { key: 'lifetimeCostUsd', label: 'Lifetime cost' },
  { key: 'budgetUtilPct', label: 'Budget' },
  { key: 'projectCount', label: 'Projects' },
  { key: 'convexInstances', label: 'Convex' },
  { key: 'lastActiveAt', label: 'Last active' },
  { key: 'joinedAt', label: 'Joined' },
];

/** Columns whose values are numbers — right-aligned so digits line up. */
const NUMERIC = new Set<SortKey>([
  'monthMarginUsd', 'monthRevenueUsd', 'monthCostUsd', 'lifetimeRevenueUsd', 'lifetimeCostUsd', 'projectCount', 'convexInstances',
]);

function sortValue(row: UserRow, key: SortKey): number {
  if (key === 'lastActiveAt' || key === 'joinedAt') {
    const v = row[key];
    return v ? Date.parse(v) : 0;
  }
  return row[key];
}

export default function PanelUsersPage() {
  const { data, loading, error, refresh, refreshing } =
    usePanelData<UsersData>('/api/panel/users');
  const [sortKey, setSortKey] = useState<SortKey>('monthMarginUsd');
  const [sortAsc, setSortAsc] = useState(true); // margin ascending = worst first
  const [query, setQuery] = useState('');
  const [tierFilter, setTierFilter] = useState<'all' | 'free' | 'pro' | 'max' | 'live'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!data) return [];
    let out = data.rows;
    if (tierFilter === 'live') out = out.filter((r) => r.liveNow);
    else if (tierFilter !== 'all') out = out.filter((r) => r.tier === tierFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      out = out.filter(
        (r) =>
          r.email?.toLowerCase().includes(q) ||
          r.name?.toLowerCase().includes(q) ||
          r.userId.toLowerCase().includes(q),
      );
    }
    return [...out].sort((a, b) => {
      const d = sortValue(a, sortKey) - sortValue(b, sortKey);
      return sortAsc ? d : -d;
    });
  }, [data, sortKey, sortAsc, query, tierFilter]);

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(key === 'monthMarginUsd'); // margin defaults worst-first
    }
  };

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle={`${fmtNum(data.totalCount)} users${data.truncated ? ' (showing first 5,000)' : ''} — sorted by ${
          COLUMNS.find((c) => c.key === sortKey)?.label
        }`}
        onRefresh={refresh}
        refreshing={refreshing}
        generatedAt={data.generatedAt}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative max-sm:w-full">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by email, name or ID"
            aria-label="Search users"
            className="w-full pl-9 sm:w-64"
          />
        </div>
        <Tabs
          options={[
            { value: 'all', text: 'All' },
            { value: 'free', text: 'Free' },
            { value: 'pro', text: 'Pro' },
            { value: 'max', text: 'Max' },
            { value: 'live', text: 'Live now' },
          ]}
          selected={tierFilter}
          onSelect={setTierFilter}
        />
      </div>

      <div className="rounded-xl border border-border bg-surface overflow-x-auto modern-scrollbar">
        <table className="w-full min-w-[1040px] text-sm">
          <thead>
            <tr className={tableHeadRowClass}>
              <th className="py-2.5 pl-4 pr-2 font-medium text-muted">User</th>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    'whitespace-nowrap px-2 py-2.5 font-medium text-muted last:pr-4',
                    NUMERIC.has(c.key) && 'text-right',
                  )}
                >
                  <button
                    onClick={() => toggleSort(c.key)}
                    className={cn('tap-44 inline-flex items-center gap-1 hover:text-fg', NUMERIC.has(c.key) && 'flex-row-reverse')}
                    title={c.title}
                  >
                    {c.label}
                    {sortKey === c.key &&
                      (sortAsc ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <UserTableRow
                key={r.userId}
                row={r}
                expanded={expanded === r.userId}
                onToggle={() => setExpanded(expanded === r.userId ? null : r.userId)}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="px-3 py-8 text-center text-muted">
                  No users match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted mt-3">
        Revenue/mo comes from the user&apos;s live Stripe subscription; a value marked
        &ldquo;est.&rdquo; has no linked subscription and uses the plan&apos;s list price. Lifetime rev is real Stripe money, net of
        refunds. Margin = revenue − platform LLM cost this month; sandbox and Convex
        costs aren&apos;t metered per-user yet, so margin is an upper bound. Revenue from
        unrelated older products on the same Stripe account is excluded entirely.
        {data.stripe.error && <> Stripe unavailable: {data.stripe.error}</>}
      </p>
    </div>
  );
}

function UserTableRow({
  row,
  expanded,
  onToggle,
}: {
  row: UserRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const marginNegative = row.monthMarginUsd < -0.005;
  return (
    <>
      <tr
        onClick={onToggle}
        className="border-b border-border/60 last:border-0 hover:bg-elevated/50 cursor-pointer"
      >
        <td className="py-2.5 pl-4 pr-2">
          <div className="flex min-w-[200px] items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {row.imageUrl && (
              <img src={row.imageUrl} alt="" className="w-6 h-6 rounded-full shrink-0" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-fg truncate">
                  {row.name ?? row.email ?? row.userId}
                </span>
                {row.liveNow && <StatusPill kind="good" label="live" />}
              </div>
              <div className="text-xs text-muted truncate">
                {row.email ?? row.userId}
                {' · '}
                <span className="capitalize">{row.tier}</span>
                {row.isBeta && !row.plan ? ' (beta)' : ''}
              </div>
            </div>
          </div>
        </td>
        <td className={cn('px-2 py-2.5 text-right tabular-nums font-medium whitespace-nowrap',
          marginNegative ? 'text-danger' : 'text-fg')}>
          {fmtUsd(row.monthMarginUsd, { cents: true })}
        </td>
        <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-fg">
          {fmtUsd(row.monthRevenueUsd, { cents: true })}
          {/* Stripe-backed is the norm and goes unmarked; only estimates are flagged. */}
          {row.revenueBasis !== 'stripe' && row.monthRevenueUsd > 0 && (
            <span className="text-xs text-muted ml-1" title="Estimated from the plan's list price: no Stripe subscription is linked">
              est.
            </span>
          )}
        </td>
        <td className="px-2 py-2.5 text-right tabular-nums text-fg">{fmtUsd(row.monthCostUsd, { cents: true })}</td>
        <td className={cn('px-2 py-2.5 text-right tabular-nums', row.lifetimeRevenueUsd > 0 ? 'text-fg font-medium' : 'text-muted')}>
          {fmtUsd(row.lifetimeRevenueUsd, { cents: true })}
        </td>
        <td className="px-2 py-2.5 text-right tabular-nums text-fg">{fmtUsd(row.lifetimeCostUsd, { cents: true })}</td>
        <td className="px-2 py-2.5"><Meter pct={row.budgetUtilPct} /></td>
        <td className="px-2 py-2.5 text-right tabular-nums text-fg">{row.projectCount}</td>
        <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-fg">
          {row.convexInstances}
          {row.convexPaused > 0 && (
            <span className="text-warning text-xs ml-1">
              ({row.convexPaused} paused)
            </span>
          )}
        </td>
        <td className="px-2 py-2.5 text-muted whitespace-nowrap">{timeAgo(row.lastActiveAt)}</td>
        <td className="whitespace-nowrap py-2.5 pl-2 pr-4 text-muted">{timeAgo(row.joinedAt)}</td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/60 bg-elevated/30">
          <td colSpan={COLUMNS.length + 1} className="px-3 py-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-6 gap-y-2 text-xs">
              <Detail label="User ID" value={row.userId} mono />
              <Detail label="Turns this month" value={fmtNum(row.monthTurns)} />
              <Detail label="Lifetime turns" value={fmtNum(row.lifetimeTurns)} />
              <Detail label="Credits this month" value={fmtNum(row.monthCredits)} />
              <Detail label="Vercel sandboxes" value={String(row.vercelSandboxes)} />
              <Detail label="Sandbox-host" value={String(row.sandboxHostSandboxes)} />
              <Detail label="CF deployments" value={String(row.cfDeployments)} />
              <Detail label="Stripe live" value={String(row.stripeLiveProjects)} />
              <Detail label="RevenueCat" value={String(row.revenuecatProjects)} />
              <Detail label="Managed domains" value={String(row.managedDomains)} />
              <Detail label="Last sign-in" value={timeAgo(row.lastSignInAt)} />
              <Detail label="Stripe rev, this month" value={fmtUsd(row.stripeMonthRevenueUsd, { cents: true })} />
              <Detail
                label="Stripe subscription"
                value={
                  row.stripeSubscription
                    ? `${row.stripeSubscription.product} · ${fmtUsd(row.stripeSubscription.monthlyUsd, { cents: true })}/mo · ${row.stripeSubscription.status}`
                    : '—'
                }
              />
              <Detail
                label="Models used"
                value={row.models.length ? row.models.join(', ') : '—'}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className={cn('text-fg', mono && 'font-mono text-[11px]')}>{value}</div>
    </div>
  );
}
