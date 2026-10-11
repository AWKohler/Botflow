// Multi-agent threads: thread columns on chat_sessions, unread tracking,
// thread attribution on questions/HITL rows, and the one-thread-per-segment
// backfill. Idempotent.
// Usage: node scripts/migrate-agent-threads.mjs
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

  const before = await sql.query(
    `SELECT count(*)::int AS threads, count(*) FILTER (WHERE current_segment_id IS NULL)::int AS unmigrated
     FROM chat_sessions`,
  ).catch(() => [{ threads: '?', unmigrated: '?' }]);

  const migrationPath = path.resolve(process.cwd(), 'drizzle/0014_agent_threads.sql');
  const ddlRaw = fs.readFileSync(migrationPath, 'utf8');
  const ddl = ddlRaw
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const statements = ddl
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`Running ${statements.length} statements from 0014_agent_threads.sql...`);
  for (const stmt of statements) {
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
    console.log(`  → ${preview}${stmt.length > 80 ? '…' : ''}`);
    await sql.query(stmt);
  }

  const [after] = await sql.query(
    `SELECT count(*)::int AS threads,
            count(*) FILTER (WHERE current_segment_id IS NULL)::int AS unmigrated,
            count(*) FILTER (WHERE title IS NOT NULL)::int AS titled
     FROM chat_sessions`,
  );
  console.log(`\nthreads before: ${before[0].threads} (unmigrated ${before[0].unmigrated})`);
  console.log(`threads after:  ${after.threads} (unmigrated ${after.unmigrated}, titled ${after.titled})`);
  console.log('\n✅ Migration complete.');
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
