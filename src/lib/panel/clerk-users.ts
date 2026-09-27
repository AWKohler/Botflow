/** Neon identity directory and billing entitlements for the admin panel. */

import { identityClient } from '@/lib/auth/server';
import { getIdentityDb } from '@/lib/auth/database';
import { subscriptionTier, type SubscriptionRecord } from '@/lib/billing/entitlements';
import type { Tier } from '@/lib/tier-shared';

export interface PanelUser {
  userId: string;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
  tier: Tier;
  /** The raw plan in publicMetadata ('pro' | 'max' | undefined). */
  plan: string | null;
  isBeta: boolean;
  createdAt: string; // ISO
  lastSignInAt: string | null; // ISO
}

export interface PanelUserDirectory {
  users: PanelUser[];
  totalCount: number;
  truncated: boolean;
}

const PAGE_SIZE = 500;
const MAX_USERS = 5_000;

function resolveTier(plan: string | undefined, isBeta: boolean): Tier {
  if (plan === 'max') return 'max';
  if (plan === 'pro') return 'pro';
  return isBeta ? 'pro' : 'free';
}

export async function getPanelUserDirectory(): Promise<PanelUserDirectory> {
  const client = await identityClient();
  const users: PanelUser[] = [];
  const billing = await getIdentityDb().query<SubscriptionRecord>('SELECT * FROM botflow_subscription');
  const paid = new Map(billing.rows.map(row => [row.user_id, subscriptionTier(row)]));
  let offset = 0;
  let totalCount = 0;

  while (offset < MAX_USERS) {
    const { data, totalCount: total } = await client.users.getUserList({
      limit: PAGE_SIZE,
      offset,
      orderBy: '-created_at',
    });
    totalCount = total;
    for (const u of data) {
      const md = (u.publicMetadata ?? {}) as Record<string, unknown>;
      const plan = typeof md.plan === 'string' ? md.plan : undefined;
      const isBeta = md.isBeta === true;
      users.push({
        userId: u.id,
        email: u.primaryEmailAddress?.emailAddress ?? u.emailAddresses[0]?.emailAddress ?? null,
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || null,
        imageUrl: u.imageUrl ?? null,
        tier: resolveTier(paid.get(u.id) === 'max' || plan === 'max' ? 'max' : paid.get(u.id) === 'pro' ? 'pro' : plan, isBeta),
        plan: plan ?? null,
        isBeta,
        createdAt: new Date(u.createdAt).toISOString(),
        lastSignInAt: u.lastSignInAt ? new Date(u.lastSignInAt).toISOString() : null,
      });
    }
    offset += data.length;
    if (data.length < PAGE_SIZE || offset >= total) break;
  }

  return { users, totalCount, truncated: totalCount > users.length };
}
