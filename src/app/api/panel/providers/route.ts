import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAdmin } from '@/lib/panel/auth';
import { panelCached } from '@/lib/panel/cache';
import { getUsageOverview } from '@/lib/panel/queries';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ─── OpenAI org Costs API (requires an ADMIN key, not an inference key) ──────

interface OpenAICostsResult {
  configured: boolean;
  error?: string;
  totalUsd?: number;
  daily?: Array<{ date: string; usd: number }>;
  byLineItem?: Array<{ lineItem: string; usd: number }>;
}

async function fetchOpenAICosts(): Promise<OpenAICostsResult> {
  const key = process.env.OPENAI_ADMIN_KEY;
  if (!key) return { configured: false };

  const startTime = Math.floor(Date.now() / 1000) - 30 * 86400;
  const daily = new Map<string, number>();
  const byLineItem = new Map<string, number>();
  let total = 0;
  let page: string | null = null;

  try {
    // ≤31 daily buckets per page; paginate defensively anyway.
    for (let i = 0; i < 5; i++) {
      const params = new URLSearchParams({
        start_time: String(startTime),
        bucket_width: '1d',
        limit: '31',
      });
      params.append('group_by', 'line_item');
      if (page) params.set('page', page);

      const res = await fetch(
        `https://api.openai.com/v1/organization/costs?${params}`,
        { headers: { Authorization: `Bearer ${key}` } },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          configured: true,
          error: `OpenAI costs API returned ${res.status}${
            res.status === 401 ? ' — key is not an org admin key' : ''
          }: ${body.slice(0, 200)}`,
        };
      }
      const json = (await res.json()) as {
        data?: Array<{
          start_time: number;
          // amount.value arrives as a decimal STRING (e.g. "0E-6176") — coerce.
          results?: Array<{ amount?: { value?: number | string }; line_item?: string | null }>;
        }>;
        has_more?: boolean;
        next_page?: string | null;
      };

      for (const bucket of json.data ?? []) {
        const date = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
        for (const r of bucket.results ?? []) {
          const usd = Number(r.amount?.value ?? 0) || 0;
          total += usd;
          daily.set(date, (daily.get(date) ?? 0) + usd);
          const li = r.line_item ?? 'other';
          byLineItem.set(li, (byLineItem.get(li) ?? 0) + usd);
        }
      }
      if (!json.has_more || !json.next_page) break;
      page = json.next_page;
    }
  } catch (e) {
    return {
      configured: true,
      error: e instanceof Error ? e.message : 'Failed to reach OpenAI costs API',
    };
  }

  return {
    configured: true,
    totalUsd: total,
    daily: [...daily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, usd]) => ({ date, usd })),
    byLineItem: [...byLineItem.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([lineItem, usd]) => ({ lineItem, usd })),
  };
}

// ─── Neon (personal API key) ─────────────────────────────────────────────────

interface NeonResult {
  configured: boolean;
  error?: string;
  projects?: Array<{ name: string; storageBytes: number | null; activeTimeSecs: number | null }>;
  totalStorageBytes?: number;
}

async function fetchNeon(): Promise<NeonResult> {
  const key = process.env.NEON_PERSONAL_ADMIN_KEY;
  if (!key) return { configured: false };
  try {
    const res = await fetch('https://console.neon.tech/api/v2/projects?limit=100', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { configured: true, error: `Neon API ${res.status}: ${body.slice(0, 200)}` };
    }
    const json = (await res.json()) as {
      projects?: Array<{
        name?: string;
        synthetic_storage_size?: number;
        active_time_seconds?: number;
      }>;
    };
    const projects = (json.projects ?? []).map((p) => ({
      name: p.name ?? 'unnamed',
      storageBytes: p.synthetic_storage_size ?? null,
      activeTimeSecs: p.active_time_seconds ?? null,
    }));
    return {
      configured: true,
      projects,
      totalStorageBytes: projects.reduce((a, p) => a + (p.storageBytes ?? 0), 0),
    };
  } catch (e) {
    return {
      configured: true,
      error: e instanceof Error ? e.message : 'Failed to reach Neon API',
    };
  }
}

// ─── Upstash (developer API key) ─────────────────────────────────────────────

interface UpstashResult {
  configured: boolean;
  error?: string;
  databases?: Array<{ name: string; region: string; state: string; type: string }>;
}

async function fetchUpstash(): Promise<UpstashResult> {
  const key = process.env.UPSTASH_PERSONAL_ADMIN_KEY;
  if (!key) return { configured: false };
  // The classic developer API authenticates with Basic(email, api-key); newer
  // management keys work as a Bearer token. Try Basic when an email is
  // configured, otherwise fall back to Bearer.
  const email = process.env.UPSTASH_EMAIL;
  const headers: Record<string, string> = email
    ? { Authorization: `Basic ${Buffer.from(`${email}:${key}`).toString('base64')}` }
    : { Authorization: `Bearer ${key}` };
  try {
    const res = await fetch('https://api.upstash.com/v2/redis/databases', { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        configured: true,
        error: `Upstash API ${res.status}${
          !email && (res.status === 401 || res.status === 403)
            ? ' — set UPSTASH_EMAIL for Basic auth'
            : ''
        }: ${body.slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as Array<{
      database_name?: string;
      region?: string;
      state?: string;
      database_type?: string;
    }>;
    return {
      configured: true,
      databases: (Array.isArray(json) ? json : []).map((d) => ({
        name: d.database_name ?? 'unnamed',
        region: d.region ?? '—',
        state: d.state ?? '—',
        type: d.database_type ?? '—',
      })),
    };
  } catch (e) {
    return {
      configured: true,
      error: e instanceof Error ? e.message : 'Failed to reach Upstash API',
    };
  }
}

// ─── Metered spend per provider from our own usage_records ───────────────────

function providerOfModel(model: string): string {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt')) return 'openai';
  if (model.startsWith('fireworks')) return 'fireworks';
  if (model.startsWith('gemini')) return 'google';
  if (model.startsWith('grok')) return 'xai';
  return 'other';
}

async function computeProviders() {
  const [openai, neon, upstash, usage] = await Promise.all([
    fetchOpenAICosts(),
    fetchNeon(),
    fetchUpstash(),
    getUsageOverview(),
  ]);

  const meteredByProvider = new Map<
    string,
    { costUsd: number; credits: number; models: string[] }
  >();
  for (const m of usage.byModelThisMonth) {
    const provider = providerOfModel(m.model);
    const entry = meteredByProvider.get(provider) ?? {
      costUsd: 0,
      credits: 0,
      models: [],
    };
    entry.costUsd += m.costUsd;
    entry.credits += m.credits;
    entry.models.push(m.model);
    meteredByProvider.set(provider, entry);
  }

  return {
    // Live billing pulls (provider-side truth):
    openai,
    // Anthropic's usage/cost Admin API needs a separate sk-ant-admin key —
    // not yet obtainable for this account. Rendered as unavailable in the UI.
    anthropic: { configured: false, unavailable: true },
    // No spend/balance API worth relying on — dashboard links + metered proxy.
    fireworks: { configured: false, dashboardOnly: true },
    xai: { configured: false, dashboardOnly: true },
    google: { configured: false, dashboardOnly: true },
    neon,
    upstash,
    // Our own settlement records (what the platform actually metered), for
    // cross-checking provider dashboards.
    meteredThisMonth: [...meteredByProvider.entries()]
      .sort(([, a], [, b]) => b.costUsd - a.costUsd)
      .map(([provider, v]) => ({ provider, ...v })),
    generatedAt: new Date().toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const adminId = await requirePanelAdmin();
  if (!adminId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const refresh = req.nextUrl.searchParams.get('refresh') === '1';
    const data = await panelCached('providers', 600, refresh, computeProviders);
    return NextResponse.json(data);
  } catch (error) {
    console.error('[panel/providers] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load providers' },
      { status: 500 },
    );
  }
}
