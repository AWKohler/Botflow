// Migrate existing projects from the old Kimi K2.6 model id to Kimi K2.7.
// Together AI homologated its pricing to Fireworks, so the rename is purely
// cosmetic for cost — but the stored model id must move to the new value so
// projects show "Kimi K2.7" and route correctly.
//
// Safe to run multiple times (idempotent). Usage: node scripts/migrate-kimi-k2p7.mjs
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import path from 'node:path';

function loadDatabaseUrl() {
  try {
    const envPath = path.resolve(process.cwd(), '.env.local');
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/);
      if (m && m[1].startsWith('postgres')) return m[1];
    }
  } catch {}
  return process.env.DATABASE_URL;
}

async function run() {
  let url = loadDatabaseUrl();
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  url = url.trim().replace(/^postgresql:\/\//, 'postgres://');
  const sql = neon(url);

  const rows = await sql`
    UPDATE projects
    SET model = 'fireworks-kimi-k2p7'
    WHERE model = 'fireworks-kimi-k2p6'
    RETURNING id`;
  console.log(`✅ Migrated ${rows.length} project(s) from fireworks-kimi-k2p6 → fireworks-kimi-k2p7.`);
}

run().catch((err) => { console.error(err); process.exit(1); });
