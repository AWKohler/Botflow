// Sharing hardening part 1: sticky projects.shared_at (backfilled),
// projects.sandbox_credentials, and cleanup of snapshot/thumbnail URLs that
// don't belong to a real upload. Idempotent.
// Usage: node scripts/migrate-sharing-hardening.mjs [--dry-run]
// Run once before the deploy and once after it has fully rolled out.
// Reads DATABASE_URL from .env.local (falls back to process.env), mirroring the
// other scripts/migrate-*.mjs runners (raw SQL via @neondatabase/serverless).
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

  const [before] = await sql.query(
    `SELECT count(*)::int AS projects FROM projects`,
  );

  // Dry run: what the URL cleanup would clear (only meaningful once the
  // columns exist; the URL columns always do).
  const URL_OK = (col, key) =>
    `(${col} ~ '^https://(utfs\\.io|[a-z0-9-]+\\.ufs\\.sh)/f/[^/?#]+$' AND substring(${col} from '/f/([^/?#]+)$') IS NOT DISTINCT FROM ${key})`;
  const [preview] = await sql.query(
    `SELECT count(*) FILTER (WHERE html_snapshot_url IS NOT NULL AND NOT ${URL_OK('html_snapshot_url', 'html_snapshot_key')})::int AS snapshots,
            count(*) FILTER (WHERE thumbnail_url IS NOT NULL AND NOT ${URL_OK('thumbnail_url', 'thumbnail_key')})::int AS thumbnails,
            (SELECT count(DISTINCT project_id)::int FROM project_members) AS shared
       FROM projects`,
  );
  console.log(`projects: ${before.projects}; ever shared: ${preview.shared}`);
  console.log(`URL cleanup would clear: ${preview.snapshots} snapshot URL(s), ${preview.thumbnails} thumbnail URL(s)`);
  if (process.argv.includes('--dry-run')) {
    console.log('\n--dry-run: no changes made.');
    return;
  }

  const migrationPath = path.resolve(process.cwd(), 'drizzle/0018_sharing_hardening.sql');
  const ddl = fs.readFileSync(migrationPath, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const statements = ddl.split(';').map((s) => s.trim()).filter((s) => s.length > 0);

  console.log(`Running ${statements.length} statements from 0018_sharing_hardening.sql...`);
  for (const stmt of statements) {
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
    console.log(`  → ${preview}${stmt.length > 80 ? '…' : ''}`);
    await sql.query(stmt);
  }

  const [after] = await sql.query(
    `SELECT count(*) FILTER (WHERE shared_at IS NOT NULL)::int AS shared,
            count(*) FILTER (WHERE sandbox_credentials IS NULL)::int AS unknown_credentials
       FROM projects`,
  );
  console.log(`\nprojects: ${before.projects}; shared (sticky): ${after.shared}; credential state unknown: ${after.unknown_credentials}`);
  console.log('\n✅ Migration complete.');
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
