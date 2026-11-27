// Sharing hardening part 1: sticky projects.shared_at (backfilled),
// projects.sandbox_credentials, and cleanup of snapshot/thumbnail URLs that
// don't belong to a real upload. Idempotent.
// Usage:
//   node scripts/migrate-sharing-hardening.mjs --dry-run      counts only
//   node scripts/migrate-sharing-hardening.mjs                BEFORE the deploy
//   node scripts/migrate-sharing-hardening.mjs --post-deploy  AFTER: once the deploy
//     has been live longer than 300s (max function duration) + any Skew
//     Protection max age, so no old instance can still serve a request.
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
            count(*) FILTER (WHERE thumbnail_url IS NOT NULL AND thumbnail_url !~ '^https://(utfs\\.io|[a-z0-9-]+\\.ufs\\.sh)/f/[^/?#]+$')::int AS thumbnails,
            (SELECT count(DISTINCT project_id)::int FROM project_members) AS shared
       FROM projects`,
  );
  console.log(`projects: ${before.projects}; ever shared: ${preview.shared}`);
  console.log(`URL cleanup would clear: ${preview.snapshots} snapshot URL(s), ${preview.thumbnails} thumbnail URL(s)`);
  if (process.argv.includes('--dry-run')) {
    console.log('\n--dry-run: no changes made.');
    return;
  }

  if (process.argv.includes('--post-deploy')) {
    // Rollout barrier. Old instances ignore shared_at, the credential lock
    // and the in-sandbox fence, so during the overlap one could have written
    // an owner's Codex token into a sandbox the new code had already marked
    // clean. Once no old instance can serve (deploy live for longer than the
    // longest function duration, 300s, plus any Skew Protection max age):
    // re-backfill shared_at for invites the old code wrote, and send every
    // shared project back to "unknown" so its next member access re-purges.
    const [backfilled] = await sql.query(
      `WITH m AS (SELECT project_id, min(invited_at) AS first_invited FROM project_members GROUP BY project_id)
       UPDATE projects p SET shared_at = m.first_invited FROM m
        WHERE p.id = m.project_id AND p.shared_at IS NULL
       RETURNING p.id`,
    ).then((rows) => [rows.length]);
    const reset = await sql.query(
      `UPDATE projects SET sandbox_credentials = NULL
        WHERE shared_at IS NOT NULL AND sandbox_credentials IS NOT DISTINCT FROM 'none'
       RETURNING id`,
    );
    console.log(`post-deploy: shared_at backfilled on ${backfilled} project(s); ${reset.length} shared project(s) set to re-verify`);
    console.log('\n✅ Post-deploy step complete.');
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
