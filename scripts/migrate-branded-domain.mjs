#!/usr/bin/env node
/**
 * Backfill the white-label branded deployment domain for already-published projects.
 *
 * For every project with a Cloudflare Pages deployment that is NOT fronted by a
 * user managed domain, this:
 *   1. attaches `<project>.<CLOUDFLARE_BRANDED_DOMAIN>` to the Pages project
 *   2. upserts the proxied CNAME `<project>.<branded>` -> `<project>.pages.dev`
 *      (Cloudflare does NOT auto-create this record — without it the hostname
 *      never resolves and the cert never validates)
 *   3. updates projects.cloudflare_deployment_url to the branded URL
 *
 * Idempotent — safe to re-run. Projects with a managed domain keep their URL.
 *
 * Usage:
 *   node --env-file=.env.local scripts/migrate-branded-domain.mjs [--dry-run]
 *
 * Requires: DATABASE_URL, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *           CLOUDFLARE_BRANDED_DOMAIN, CLOUDFLARE_BRANDED_ZONE_ID
 */
import { neon } from '@neondatabase/serverless';

const DRY = process.argv.includes('--dry-run');
const CF_BASE = 'https://api.cloudflare.com/client/v4';

const {
  DATABASE_URL,
  CLOUDFLARE_API_TOKEN: TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_BRANDED_DOMAIN: BRANDED,
  CLOUDFLARE_BRANDED_ZONE_ID: ZONE,
} = process.env;

for (const [k, v] of Object.entries({ DATABASE_URL, TOKEN, ACCOUNT, BRANDED, ZONE })) {
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
}

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const cf = (path, opts = {}) => fetch(CF_BASE + path, { headers: H, ...opts }).then((r) => r.json());

const sql = neon(DATABASE_URL);

const rows = await sql`
  SELECT id, name, cloudflare_project_name, cloudflare_deployment_url, managed_domain_hostname
  FROM projects
  WHERE cloudflare_project_name IS NOT NULL
  ORDER BY updated_at DESC
`;
console.log(`${rows.length} published project(s) found${DRY ? ' (dry run)' : ''}\n`);

let migrated = 0, skipped = 0, failed = 0;
for (const p of rows) {
  const proj = p.cloudflare_project_name;
  const hostname = `${proj}.${BRANDED}`;
  const brandedUrl = `https://${hostname}`;

  if (p.managed_domain_hostname) {
    console.log(`SKIP  ${proj} — has managed domain ${p.managed_domain_hostname}`);
    skipped++;
    continue;
  }
  if (p.cloudflare_deployment_url === brandedUrl) {
    console.log(`OK    ${proj} — already branded`);
    skipped++;
    continue;
  }
  if (DRY) {
    console.log(`WOULD ${proj} — ${p.cloudflare_deployment_url} -> ${brandedUrl}`);
    migrated++;
    continue;
  }

  try {
    // Confirm the Pages project still exists (DB can lag behind unpublish).
    const projRes = await cf(`/accounts/${ACCOUNT}/pages/projects/${proj}`);
    if (!projRes.success) {
      console.log(`SKIP  ${proj} — Pages project not found in CF`);
      skipped++;
      continue;
    }

    // 1. Attach custom domain (8000040 / "already" = fine)
    const attach = await cf(`/accounts/${ACCOUNT}/pages/projects/${proj}/domains`, {
      method: 'POST',
      body: JSON.stringify({ name: hostname }),
    });
    if (!attach.success) {
      const already = attach.errors?.some(
        (e) => e.code === 8000040 || /already/i.test(e.message ?? ''),
      );
      if (!already) throw new Error(`attach failed: ${JSON.stringify(attach.errors)}`);
    }

    // 2. Upsert proxied CNAME
    const existing = await cf(`/zones/${ZONE}/dns_records?type=CNAME&name=${hostname}`);
    const record = { type: 'CNAME', name: hostname, content: `${proj}.pages.dev`, proxied: true, comment: 'Botflow white-label deployment domain' };
    if (existing.result?.length) {
      await cf(`/zones/${ZONE}/dns_records/${existing.result[0].id}`, { method: 'PATCH', body: JSON.stringify(record) });
    } else {
      const created = await cf(`/zones/${ZONE}/dns_records`, { method: 'POST', body: JSON.stringify(record) });
      if (!created.success) throw new Error(`dns create failed: ${JSON.stringify(created.errors)}`);
    }

    // 3. Update DB
    await sql`
      UPDATE projects
      SET cloudflare_deployment_url = ${brandedUrl}, updated_at = NOW()
      WHERE id = ${p.id}
    `;
    console.log(`DONE  ${proj} — ${brandedUrl}`);
    migrated++;
  } catch (err) {
    console.error(`FAIL  ${proj} — ${err.message}`);
    failed++;
  }
}

console.log(`\nmigrated=${migrated} skipped=${skipped} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
