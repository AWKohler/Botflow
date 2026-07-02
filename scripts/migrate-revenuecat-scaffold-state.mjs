// RevenueCat scaffold-state migration.
// Usage: node scripts/migrate-revenuecat-scaffold-state.mjs
// Reads DATABASE_URL from .env.local (falls back to process.env), mirroring the
// other scripts/migrate-*.mjs runners (raw SQL via @neondatabase/serverless).
//
// Applies drizzle/0005_revenuecat_scaffold_state.sql: adds
// projects.revenuecat_scaffold_state and drops the unused
// revenuecat_webhook_events table.
import { neon } from '@neondatabase/serverless';
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

  const migrationPath = path.resolve(process.cwd(), 'drizzle/0005_revenuecat_scaffold_state.sql');
  const ddlRaw = fs.readFileSync(migrationPath, 'utf8');
  const ddl = ddlRaw
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const statements = ddl
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`Running ${statements.length} statements from 0005_revenuecat_scaffold_state.sql...`);
  for (const stmt of statements) {
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
    console.log(`  → ${preview}${stmt.length > 80 ? '…' : ''}`);
    await sql.query(stmt);
  }

  const cols = await sql.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'projects' AND column_name = 'revenuecat_scaffold_state'`,
  );
  console.log('\nprojects.revenuecat_scaffold_state:', cols.length ? cols[0].data_type : 'MISSING');
  console.log('\n✅ Migration complete.');
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
