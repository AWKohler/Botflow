// Admin escape hatch: unpause a platform-managed Convex deployment and reset
// its guardrail status to 'active' (e.g. after fixing an accidental cron loop).
// Usage: node scripts/admin-unpause-convex.mjs <projectId>
// Reads DATABASE_URL from .env.local like the migrate-*.mjs runners.
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import path from 'node:path';

const projectId = process.argv[2];
if (!projectId) {
  console.error('Usage: node scripts/admin-unpause-convex.mjs <projectId>');
  process.exit(1);
}

function databaseUrl() {
  let fromFile;
  try {
    const text = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/);
      if (m) { fromFile = m[1]; break; }
    }
  } catch {}
  const url = (fromFile && fromFile.startsWith('postgres')) ? fromFile : process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  return url.trim().replace(/^postgresql:\/\//, 'postgres://');
}

async function run() {
  const sql = neon(databaseUrl());
  const rows = await sql.query(
    `SELECT id, name, backend_type, convex_status, convex_deployment_id,
            convex_deploy_url, convex_deploy_key
     FROM projects WHERE id = $1`,
    [projectId],
  );
  if (rows.length === 0) {
    console.error(`Project ${projectId} not found`);
    process.exit(1);
  }
  const p = rows[0];
  console.log(`Project: ${p.name} (${p.id})`);
  console.log(`  backendType=${p.backend_type} convexStatus=${p.convex_status} deployment=${p.convex_deployment_id}`);
  if (p.backend_type !== 'platform' || !p.convex_deploy_url || !p.convex_deploy_key) {
    console.error('Not a platform-managed Convex project with stored credentials — nothing to unpause.');
    process.exit(1);
  }

  const res = await fetch(`${p.convex_deploy_url}/api/change_deployment_state`, {
    method: 'POST',
    headers: {
      Authorization: `Convex ${p.convex_deploy_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ newState: 'running' }),
  });
  if (!res.ok) {
    console.error(`change_deployment_state failed: HTTP ${res.status}`);
    process.exit(1);
  }
  console.log('Deployment resumed (newState=running).');

  await sql.query(
    `UPDATE projects
     SET convex_status = 'active', convex_paused_at = NULL, convex_pause_reason = NULL
     WHERE id = $1`,
    [projectId],
  );
  console.log("convex_status reset to 'active'.");

  // Zero today's usage bucket. The daily counter is CUMULATIVE — without this,
  // a bucket already over the pause bar makes the next poller tick re-pause
  // immediately (pause_repeat) even though the abusive workload was fixed,
  // and the unpause can't stick until the UTC midnight reset.
  const todayUtc = new Date().toISOString().slice(0, 10);
  await sql.query(
    `UPDATE convex_usage_daily SET calls = 0, updated_at = now()
     WHERE project_id = $1 AND day = $2`,
    [projectId, todayUtc],
  );
  console.log(`today's usage bucket (${todayUtc}) zeroed so the unpause sticks.`);
  console.log('\n✅ Unpaused. The poller resumes counting from now; it will warn/pause again only on NEW abusive traffic.');
}

run().catch((err) => {
  console.error('Unpause failed:', err);
  process.exit(1);
});
