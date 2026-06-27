// RevenueCat hardening migration.
// Usage: node scripts/migrate-revenuecat-hardening.mjs
// Reads DATABASE_URL from .env.local (falls back to process.env), mirroring the
// other scripts/migrate-*.mjs runners (raw SQL via @neondatabase/serverless).
//
// Applies drizzle/0003_revenuecat_hardening.sql: the revenuecat_webhook_deliveries
// durable outbox table.
import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

async function run() {
  let urlFromEnv = process.env.DATABASE_URL;
  let urlFromFile = undefined;
  try {
    const envPath = path.resolve(process.cwd(), '.env.local');
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/);
      if (m) { urlFromFile = m[1]; break; }
    }
  } catch {}
  let url = (urlFromFile && urlFromFile.startsWith('postgres')) ? urlFromFile : urlFromEnv;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  url = url.trim().replace(/^postgresql:\/\//, 'postgres://');
  const sql = neon(url);

  const migrationPath = path.resolve(process.cwd(), 'drizzle/0003_revenuecat_hardening.sql');
  const ddlRaw = fs.readFileSync(migrationPath, 'utf8');
  const ddl = ddlRaw
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const statements = ddl
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`Running ${statements.length} statements from 0003_revenuecat_hardening.sql...`);
  for (const stmt of statements) {
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
    console.log(`  → ${preview}${stmt.length > 80 ? '…' : ''}`);
    await sql.query(stmt);
  }

  // Backfill the inbound-secret digest for existing rows (in JS, so we don't
  // depend on the pgcrypto extension).
  const rows = await sql.query(
    `SELECT user_id, rc_inbound_webhook_secret FROM user_revenuecat_identity
     WHERE rc_inbound_webhook_secret IS NOT NULL AND rc_inbound_webhook_secret_digest IS NULL`,
  );
  let backfilled = 0;
  for (const r of rows) {
    const digest = createHash('sha256').update(r.rc_inbound_webhook_secret).digest('hex');
    await sql.query(
      `UPDATE user_revenuecat_identity SET rc_inbound_webhook_secret_digest = $1 WHERE user_id = $2`,
      [digest, r.user_id],
    );
    backfilled++;
  }
  console.log(`Backfilled ${backfilled} inbound-secret digest(s).`);

  const cols = await sql.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'revenuecat_webhook_deliveries' ORDER BY ordinal_position`,
  );
  console.log('\nrevenuecat_webhook_deliveries columns:');
  for (const c of cols) console.log(`  ${c.column_name} : ${c.data_type}`);
  console.log('\n✅ Migration complete.');
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
