'use client';

import { ExternalLink } from 'lucide-react';
import {
  Card,
  ErrorState,
  fmtNum,
  fmtUsd,
  HBarList,
  LoadingState,
  MiniBars,
  PageHeader,
  Section,
  StatusPill,
  usePanelData,
} from '@/components/panel/ui';

interface ProvidersData {
  openai: {
    configured: boolean;
    error?: string;
    totalUsd?: number;
    daily?: Array<{ date: string; usd: number }>;
    byLineItem?: Array<{ lineItem: string; usd: number }>;
  };
  anthropic: { configured: boolean; unavailable?: boolean };
  fireworks: { configured: boolean; dashboardOnly?: boolean };
  xai: { configured: boolean; dashboardOnly?: boolean };
  google: { configured: boolean; dashboardOnly?: boolean };
  neon: {
    configured: boolean;
    error?: string;
    projects?: Array<{ name: string; storageBytes: number | null; activeTimeSecs: number | null }>;
    totalStorageBytes?: number;
  };
  upstash: {
    configured: boolean;
    error?: string;
    databases?: Array<{ name: string; region: string; state: string; type: string }>;
  };
  stripe: {
    configured: boolean;
    error: string | null;
    account: { id: string; name: string | null } | null;
    mrrUsd: number;
    lifetimeNetUsd: number;
    last30dNetUsd: number;
    payingCustomers: number;
    products: Array<{ name: string; monthlyUsd: number; active: boolean }>;
  };
  meteredThisMonth: Array<{
    provider: string;
    costUsd: number;
    credits: number;
    models: string[];
  }>;
  generatedAt: string;
}

const DASHBOARDS: Record<string, string> = {
  stripe: 'https://dashboard.stripe.com',
  openai: 'https://platform.openai.com/usage',
  anthropic: 'https://console.anthropic.com/settings/usage',
  fireworks: 'https://fireworks.ai/account/billing',
  xai: 'https://console.x.ai',
  google: 'https://aistudio.google.com',
  vercel: 'https://vercel.com/bot-flow/~/usage',
  convex: 'https://dashboard.convex.dev',
  cloudflare: 'https://dash.cloudflare.com',
  neon: 'https://console.neon.tech',
  upstash: 'https://console.upstash.com',
};

function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  return `${(b / 1e3).toFixed(0)} KB`;
}

function ProviderCard({
  name,
  status,
  children,
  dashboardKey,
}: {
  name: string;
  status: React.ReactNode;
  children?: React.ReactNode;
  dashboardKey: string;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-fg">{name}</h3>
        <div className="flex items-center gap-2">
          {status}
          <a
            href={DASHBOARDS[dashboardKey]}
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-fg"
            title="Open dashboard"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
      {children}
    </Card>
  );
}

export default function PanelProvidersPage() {
  const { data, loading, error, refresh, refreshing } =
    usePanelData<ProvidersData>('/api/panel/providers');

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? 'No data'} />;

  const { openai, neon, upstash, stripe, meteredThisMonth } = data;

  return (
    <div>
      <PageHeader
        title="Providers"
        subtitle="Provider-side spend where an API allows it; our own metering everywhere else"
        onRefresh={refresh}
        refreshing={refreshing}
        generatedAt={data.generatedAt}
      />

      <Section
        title="Metered LLM spend this month"
        hint="from our usage_records settlement — the platform's source of truth"
      >
        <Card>
          {meteredThisMonth.length === 0 ? (
            <p className="text-sm text-muted">No platform-metered usage this month.</p>
          ) : (
            <HBarList
              rows={meteredThisMonth.map((m) => ({
                label: m.provider,
                value: m.costUsd,
                sub: `${m.models.length} model${m.models.length === 1 ? '' : 's'}`,
              }))}
              formatValue={(v) => fmtUsd(v)}
            />
          )}
        </Card>
      </Section>

      <Section title="Provider accounts">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Stripe — live revenue */}
          <ProviderCard
            name="Stripe"
            dashboardKey="stripe"
            status={
              !stripe.configured ? (
                <StatusPill kind="neutral" label="not configured" />
              ) : stripe.error ? (
                <StatusPill kind="warning" label="error" />
              ) : (
                <StatusPill kind="good" label="live" />
              )
            }
          >
            {!stripe.configured && (
              <p className="text-sm text-muted">
                Set <code className="font-mono text-xs">STRIPE_READ_ONLY_KEY</code> (restricted
                read key) to pull real revenue.
              </p>
            )}
            {stripe.error && <p className="text-sm text-muted break-words">{stripe.error}</p>}
            {stripe.configured && !stripe.error && (
              <>
                <div className="text-2xl font-semibold tracking-tight text-fg mb-1">
                  {fmtUsd(stripe.mrrUsd, { cents: true })}
                  <span className="text-xs font-normal text-muted ml-2">
                    MRR · {fmtUsd(stripe.lifetimeNetUsd, { cents: true })} lifetime
                  </span>
                </div>
                <div className="text-xs text-muted mb-2">
                  {stripe.account?.name ?? stripe.account?.id} · {stripe.payingCustomers} paying
                  customers · {fmtUsd(stripe.last30dNetUsd, { cents: true })} last 30d
                </div>
                <div className="space-y-1">
                  {stripe.products.map((p) => (
                    <div key={p.name} className="flex justify-between text-xs">
                      <span className="text-muted truncate mr-2">{p.name}</span>
                      <span className="tabular-nums text-fg">
                        {fmtUsd(p.monthlyUsd, { cents: true })}/mo
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </ProviderCard>

          {/* OpenAI — live Costs API */}
          <ProviderCard
            name="OpenAI"
            dashboardKey="openai"
            status={
              !openai.configured ? (
                <StatusPill kind="neutral" label="not configured" />
              ) : openai.error ? (
                <StatusPill kind="warning" label="error" />
              ) : (
                <StatusPill kind="good" label="live" />
              )
            }
          >
            {!openai.configured && (
              <p className="text-sm text-muted">
                Set <code className="font-mono text-xs">OPENAI_ADMIN_KEY</code> (org admin
                key) to pull real org spend.
              </p>
            )}
            {openai.error && <p className="text-sm text-muted break-words">{openai.error}</p>}
            {openai.totalUsd !== undefined && (
              <>
                <div className="text-2xl font-semibold tracking-tight text-fg mb-1">
                  {fmtUsd(openai.totalUsd)}
                  <span className="text-xs font-normal text-muted ml-2">last 30 days, org-wide</span>
                </div>
                {openai.daily && openai.daily.length > 0 && (
                  <div className="mt-3">
                    <MiniBars
                      data={openai.daily.map((d) => ({ label: d.date, value: d.usd }))}
                      formatValue={(v) => fmtUsd(v)}
                      height={64}
                    />
                  </div>
                )}
                {openai.byLineItem && openai.byLineItem.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {openai.byLineItem.slice(0, 6).map((li) => (
                      <div key={li.lineItem} className="flex justify-between text-xs">
                        <span className="text-muted truncate mr-2">{li.lineItem}</span>
                        <span className="tabular-nums text-fg">{fmtUsd(li.usd)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </ProviderCard>

          {/* Anthropic — admin key unavailable */}
          <ProviderCard
            name="Anthropic"
            dashboardKey="anthropic"
            status={<StatusPill kind="neutral" label="unavailable" />}
          >
            <p className="text-sm text-muted">
              Org spend needs an Anthropic <span className="font-mono text-xs">sk-ant-admin…</span>{' '}
              key, which isn&apos;t obtainable for this account yet. Platform-metered
              Anthropic spend appears in the chart above; use the console for
              provider-side truth.
            </p>
          </ProviderCard>

          {/* Neon */}
          <ProviderCard
            name="Neon"
            dashboardKey="neon"
            status={
              !neon.configured ? (
                <StatusPill kind="neutral" label="not configured" />
              ) : neon.error ? (
                <StatusPill kind="warning" label="error" />
              ) : (
                <StatusPill kind="good" label="live" />
              )
            }
          >
            {!neon.configured && (
              <p className="text-sm text-muted">
                Set <code className="font-mono text-xs">NEON_PERSONAL_ADMIN_KEY</code> to list
                projects and storage.
              </p>
            )}
            {neon.error && <p className="text-sm text-muted break-words">{neon.error}</p>}
            {neon.projects && (
              <>
                <div className="text-2xl font-semibold tracking-tight text-fg mb-2">
                  {fmtBytes(neon.totalStorageBytes ?? 0)}
                  <span className="text-xs font-normal text-muted ml-2">
                    across {neon.projects.length} project{neon.projects.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="space-y-1">
                  {neon.projects.slice(0, 6).map((p) => (
                    <div key={p.name} className="flex justify-between text-xs">
                      <span className="text-muted truncate mr-2">{p.name}</span>
                      <span className="tabular-nums text-fg">
                        {p.storageBytes != null ? fmtBytes(p.storageBytes) : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </ProviderCard>

          {/* Upstash */}
          <ProviderCard
            name="Upstash"
            dashboardKey="upstash"
            status={
              !upstash.configured ? (
                <StatusPill kind="neutral" label="not configured" />
              ) : upstash.error ? (
                <StatusPill kind="warning" label="error" />
              ) : (
                <StatusPill kind="good" label="live" />
              )
            }
          >
            {!upstash.configured && (
              <p className="text-sm text-muted">
                Set <code className="font-mono text-xs">UPSTASH_PERSONAL_ADMIN_KEY</code>{' '}
                (+ <code className="font-mono text-xs">UPSTASH_EMAIL</code> for Basic auth) to
                list databases.
              </p>
            )}
            {upstash.error && <p className="text-sm text-muted break-words">{upstash.error}</p>}
            {upstash.databases && (
              <div className="space-y-1">
                {upstash.databases.map((d) => (
                  <div key={d.name} className="flex items-center justify-between text-xs">
                    <span className="text-fg truncate mr-2">{d.name}</span>
                    <span className="text-muted">
                      {d.region} · {d.type} · {d.state}
                    </span>
                  </div>
                ))}
                {upstash.databases.length === 0 && (
                  <p className="text-sm text-muted">No databases visible to this key.</p>
                )}
              </div>
            )}
          </ProviderCard>

          {/* Dashboard-only providers */}
          <ProviderCard
            name="Fireworks"
            dashboardKey="fireworks"
            status={<StatusPill kind="neutral" label="dashboard only" />}
          >
            <p className="text-sm text-muted">
              No spend API. Metered spend:{' '}
              <span className="text-fg font-medium">
                {fmtUsd(meteredThisMonth.find((m) => m.provider === 'fireworks')?.costUsd ?? 0)}
              </span>{' '}
              this month ({fmtNum(meteredThisMonth.find((m) => m.provider === 'fireworks')?.credits ?? 0)} credits).
            </p>
          </ProviderCard>

          <ProviderCard
            name="Vercel"
            dashboardKey="vercel"
            status={<StatusPill kind="neutral" label="dashboard only" />}
          >
            <p className="text-sm text-muted">
              Vercel exposes no billing API. Sandbox compute/storage costs need the
              per-session metering instrumentation (planned) — until then, use the
              team usage dashboard.
            </p>
          </ProviderCard>

          <ProviderCard
            name="Convex"
            dashboardKey="convex"
            status={<StatusPill kind="neutral" label="dashboard only" />}
          >
            <p className="text-sm text-muted">
              Platform-team billing isn&apos;t exposed via API. Instance counts and
              per-backend call volume are on the Infrastructure tab.
            </p>
          </ProviderCard>

          <ProviderCard
            name="Cloudflare"
            dashboardKey="cloudflare"
            status={<StatusPill kind="neutral" label="dashboard only" />}
          >
            <p className="text-sm text-muted">
              Pages deploys ride the free/paid plan rather than metered billing;
              deploy counts are on the Infrastructure tab.
            </p>
          </ProviderCard>
        </div>
      </Section>
    </div>
  );
}
