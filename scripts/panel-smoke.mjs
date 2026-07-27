// Smoke-test the panel's data layer against the dev DB + Clerk instance.
// Run: node --import tsx scripts/panel-smoke.mjs   (from the worktree root)
import { config } from 'dotenv';
config({ path: '.env.local' });

const summarize = (label, fn) =>
  fn()
    .then((v) => {
      const s = JSON.stringify(v);
      console.log(`✓ ${label}: ${s.length > 400 ? s.slice(0, 400) + '…' : s}`);
      return true;
    })
    .catch((e) => {
      console.error(`✗ ${label}: ${e?.message ?? e}`);
      return false;
    });

const { getUsageOverview, getPerUserUsage, getPerUserProjects, getProjectAggregates, getConvexAggregates, getWebhookHealth, getOpsSignals } =
  await import('../src/lib/panel/queries.ts');
const { getPanelUserDirectory } = await import('../src/lib/panel/clerk-users.ts');

const results = [];
results.push(await summarize('usageOverview', async () => {
  const v = await getUsageOverview();
  return { users: v.totalUsersEver, monthCredits: v.thisMonth.credits, models: v.byModelThisMonth.length, trendMonths: v.monthlyTrend.length };
}));
results.push(await summarize('perUserUsage', async () => ({ users: (await getPerUserUsage()).size })));
results.push(await summarize('perUserProjects', async () => {
  const m = await getPerUserProjects();
  const live = [...m.values()].filter((u) => u.liveNow).length;
  return { users: m.size, liveNow: live };
}));
results.push(await summarize('projectAggregates', async () => {
  const v = await getProjectAggregates();
  return { total: v.total, active: v.active, live: v.liveSessionCount, platforms: v.byPlatform };
}));
results.push(await summarize('convexAggregates', async () => {
  const v = await getConvexAggregates();
  return { platform: v.platformInstances, byoc: v.byocInstances, orphaned: v.orphanedInstances, calls30d: v.totalCallsLast30d };
}));
results.push(await summarize('webhookHealth', async () => {
  const v = await getWebhookHealth();
  return { stripe: v.stripe, rc: v.revenuecat, failures: v.recentFailures.length };
}));
results.push(await summarize('opsSignals', getOpsSignals));
results.push(await summarize('clerkDirectory', async () => {
  const v = await getPanelUserDirectory();
  const tiers = v.users.reduce((a, u) => ({ ...a, [u.tier]: (a[u.tier] ?? 0) + 1 }), {});
  return { total: v.totalCount, fetched: v.users.length, tiers };
}));

process.exit(results.every(Boolean) ? 0 : 1);
