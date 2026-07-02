/**
 * Move existing free-tier projects from Vercel Sandbox to the self-hosted
 * sandbox-host service.
 *
 * For every non-deleted project on sandbox_provider='vercel' whose owner
 * resolves to the free tier (publicMetadata.plan, with isBeta acting as a
 * pro floor — mirrors src/lib/tier.ts), this script:
 *   1. tars the project source out of its Vercel sandbox (node_modules etc.
 *      excluded — same exclude list as tarSandboxProject),
 *   2. creates the same-named sandbox on sandbox-host and extracts the tar,
 *   3. stops the host session (snapshot persists; frees a concurrency slot),
 *   4. flips projects.sandbox_provider to 'sandbox-host',
 *   5. (only with --delete-vercel) deletes the Vercel sandbox + snapshots.
 *
 * The Vercel sandbox is KEPT by default so a migration can be rolled back by
 * flipping the column to 'vercel'. Run again with --delete-vercel once the
 * fleet looks healthy to actually reclaim the Vercel storage/spend.
 *
 * Idempotent: re-running skips projects already on sandbox-host, and won't
 * re-seed a host sandbox that already has files.
 *
 * Usage:
 *   node scripts/migrate-free-projects-to-sandbox-host.mjs [--dry-run]
 *     [--limit N] [--project <projectId>] [--user <clerkUserId>]
 *     [--min-idle-minutes 30] [--delete-vercel]
 *
 * Env (process env or .env.local): DATABASE_URL, CLERK_SECRET_KEY,
 *   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID,
 *   SANDBOX_API_URL, SANDBOX_HOST_TOKEN,
 *   SANDBOX_HOST_TEAM_ID / SANDBOX_HOST_PROJECT_ID (default "default").
 */
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import path from 'node:path';

// ─── Env loading (process env first, .env.local fallback) ────────────────────

const ENV_KEYS = [
  'DATABASE_URL',
  'CLERK_SECRET_KEY',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID',
  'SANDBOX_API_URL',
  'SANDBOX_HOST_TOKEN',
  'SANDBOX_HOST_TEAM_ID',
  'SANDBOX_HOST_PROJECT_ID',
];

function loadEnv() {
  let fileVars = {};
  try {
    const text = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && ENV_KEYS.includes(m[1])) fileVars[m[1]] = m[2];
    }
  } catch {}
  const env = {};
  for (const key of ENV_KEYS) env[key] = process.env[key] || fileVars[key] || '';
  return env;
}

const env = loadEnv();
// The host SDK reads its base URL from process.env.SANDBOX_API_URL at client
// construction time, so make the .env.local value visible before importing it.
if (env.SANDBOX_API_URL && !process.env.SANDBOX_API_URL) {
  process.env.SANDBOX_API_URL = env.SANDBOX_API_URL;
}

const { Sandbox: VercelSandbox, APIError: VercelAPIError } = await import('@vercel/sandbox');
const { Sandbox: HostSandbox, APIError: HostAPIError } = await import('@sandbox-host/sdk');

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const val = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const DRY_RUN = has('--dry-run');
const DELETE_VERCEL = has('--delete-vercel');
const LIMIT = parseInt(val('--limit', '0'), 10) || 0;
const ONLY_PROJECT = val('--project', '');
const ONLY_USER = val('--user', '');
const MIN_IDLE_MINUTES = parseInt(val('--min-idle-minutes', '30'), 10);

// Must match vercel-sandbox.ts so the app's Sandbox.get/create find the
// migrated sandbox under the same name and session defaults.
const SANDBOX_ROOT = '/vercel/sandbox';
const DEFAULT_RUNTIME = 'node22';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const SANDBOX_PORTS = [3000, 5173, 4173, 8000];
const SNAPSHOT_EXPIRATION_MS = 90 * 24 * 60 * 60 * 1000;

const TAR_EXCLUDES = [
  '--exclude=.git',
  '--exclude=node_modules',
  '--exclude=.build',
  '--exclude=build',
  '--exclude=dist',
  '--exclude=*.xcodeproj/xcuserdata',
  '--exclude=*.xcodeproj/project.xcworkspace/xcuserdata',
  '--exclude=DerivedData',
  '--exclude=.DS_Store',
].join(' ');

function sandboxName(projectId) {
  return `botflow-project-${projectId}`;
}

function requireEnv(keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`Missing env: ${missing.join(', ')} (set in env or .env.local)`);
    process.exit(1);
  }
}

function apiStatus(err) {
  if (err instanceof VercelAPIError || err instanceof HostAPIError) {
    return err.response?.status;
  }
  return undefined;
}

const vercelCreds = {
  token: env.VERCEL_TOKEN,
  teamId: env.VERCEL_TEAM_ID,
  projectId: env.VERCEL_PROJECT_ID,
};
const hostCreds = {
  token: env.SANDBOX_HOST_TOKEN,
  teamId: env.SANDBOX_HOST_TEAM_ID || 'default',
  projectId: env.SANDBOX_HOST_PROJECT_ID || 'default',
};

// ─── Clerk tier resolution (mirrors resolveTier in src/lib/tier.ts) ─────────

const tierCache = new Map();

async function resolveUserTier(userId) {
  if (tierCache.has(userId)) return tierCache.get(userId);
  const res = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
  });
  let tier;
  if (res.status === 404) {
    tier = 'missing'; // user deleted from Clerk — leave their projects alone
  } else if (!res.ok) {
    throw new Error(`Clerk users API ${res.status} for ${userId}`);
  } else {
    const user = await res.json();
    const md = user.public_metadata ?? {};
    const plan = md.plan;
    const isBeta = md.isBeta === true;
    tier = plan === 'max' ? 'max' : plan === 'pro' ? 'pro' : isBeta ? 'pro' : 'free';
  }
  tierCache.set(userId, tier);
  await new Promise((r) => setTimeout(r, 100)); // be gentle with Clerk's rate limit
  return tier;
}

// ─── Sandbox helpers ─────────────────────────────────────────────────────────

async function runInSandbox(sandbox, script) {
  const cmd = await sandbox.runCommand('bash', ['-c', script]);
  return {
    exitCode: cmd.exitCode,
    stdout: await cmd.stdout(),
    stderr: await cmd.stderr(),
  };
}

async function sandboxIsEmpty(sandbox) {
  const res = await runInSandbox(
    sandbox,
    `ls -A ${SANDBOX_ROOT} 2>/dev/null | grep -v '^node_modules$' | grep -v '^\\.git$' | head -1 || true`,
  );
  return res.stdout.trim() === '';
}

async function tarProjectSource(sandbox) {
  const script = [
    'set -o pipefail',
    `tar czf - ${TAR_EXCLUDES} -C ${SANDBOX_ROOT} . 2>/dev/null | base64 -w 0`,
    'rc=$?',
    '[ $rc -eq 0 ] || [ $rc -eq 1 ]',
  ].join(' ; ');
  const res = await runInSandbox(sandbox, script);
  if (res.exitCode !== 0) {
    throw new Error(`tar failed (${res.exitCode}): ${res.stderr || '(no output)'}`);
  }
  const b64 = res.stdout.trim();
  if (!b64) throw new Error('tar produced empty output');
  return Buffer.from(b64, 'base64');
}

async function stopQuietly(sandbox, label) {
  if (!sandbox) return;
  try {
    if (typeof sandbox.stop === 'function') await sandbox.stop();
  } catch (e) {
    console.warn(`    (non-fatal) failed to stop ${label}: ${e.message ?? e}`);
  }
}

// ─── Per-project migration ───────────────────────────────────────────────────

async function migrateProject(sql, project) {
  const name = sandboxName(project.id);

  // 1. Source: the project's Vercel sandbox. A 404/400 means it was never
  //    created or already reaped — flip the column and let the app's
  //    auto-reseed rebuild from the template on next open.
  let vercelSandbox = null;
  try {
    vercelSandbox = await VercelSandbox.get({ name, ...vercelCreds });
  } catch (err) {
    const status = apiStatus(err);
    if (status !== 404 && status !== 400) throw err;
  }

  let tarBuf = null;
  if (vercelSandbox) {
    if (await sandboxIsEmpty(vercelSandbox)) {
      console.log('    vercel sandbox is empty — will rely on template auto-reseed');
    } else {
      tarBuf = await tarProjectSource(vercelSandbox);
      console.log(`    tarred source: ${(tarBuf.length / 1024).toFixed(0)} KiB`);
    }
  } else {
    console.log('    no vercel sandbox (404) — will rely on template auto-reseed');
  }

  if (DRY_RUN) {
    console.log('    [dry-run] would seed sandbox-host and flip sandbox_provider');
    await stopQuietly(vercelSandbox, 'vercel sandbox');
    return 'dry-run';
  }

  // 2. Destination: same-named sandbox on sandbox-host.
  let hostSandbox;
  try {
    hostSandbox = await HostSandbox.get({ name, ...hostCreds });
  } catch (err) {
    const status = apiStatus(err);
    if (status !== 404 && status !== 400) throw err;
    hostSandbox = await HostSandbox.create({
      ...hostCreds,
      name,
      runtime: DEFAULT_RUNTIME,
      timeout: DEFAULT_TIMEOUT_MS,
      ports: SANDBOX_PORTS,
      snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
      keepLastSnapshots: { count: 1, deleteEvicted: true },
    });
  }

  try {
    // 3. Seed it (skip when a previous run already copied the files).
    if (tarBuf) {
      if (await sandboxIsEmpty(hostSandbox)) {
        const tmp = `/tmp/migrate-${project.id}.tar.gz`;
        await hostSandbox.writeFiles([{ path: tmp, content: tarBuf }]);
        const extract = await runInSandbox(
          hostSandbox,
          `mkdir -p ${SANDBOX_ROOT} && tar xzf ${tmp} -C ${SANDBOX_ROOT} && rm -f ${tmp}`,
        );
        if (extract.exitCode !== 0) {
          throw new Error(`extract failed (${extract.exitCode}): ${extract.stderr}`);
        }
        if (await sandboxIsEmpty(hostSandbox)) {
          throw new Error('host sandbox still empty after extract');
        }
        console.log('    seeded sandbox-host copy');
      } else {
        console.log('    host sandbox already has files — skipping copy');
      }
    }
  } finally {
    // Free the VM either way: 10-per-token concurrency on the host, and the
    // stop snapshots the disk for persistent sandboxes.
    await stopQuietly(hostSandbox, 'host sandbox');
  }

  // 4. Flip the pointer. From here the app serves this project from
  //    sandbox-host (instances may cache 'vercel' for up to 60s).
  await sql.query(
    `UPDATE projects SET sandbox_provider = 'sandbox-host', updated_at = now() WHERE id = $1`,
    [project.id],
  );
  console.log('    flipped sandbox_provider → sandbox-host');

  // 5. Optionally reclaim the Vercel side.
  if (vercelSandbox) {
    if (DELETE_VERCEL) {
      try {
        if (typeof vercelSandbox.delete === 'function') await vercelSandbox.delete();
        else await stopQuietly(vercelSandbox, 'vercel sandbox');
        try {
          if (vercelSandbox.listSnapshots && vercelSandbox.deleteSnapshot) {
            const page = await vercelSandbox.listSnapshots({ limit: 50 });
            for (const snap of page.snapshots ?? []) {
              await vercelSandbox.deleteSnapshot(snap.id).catch(() => undefined);
            }
          }
        } catch {}
        console.log('    deleted vercel sandbox + snapshots');
      } catch (e) {
        console.warn(`    (non-fatal) vercel delete failed: ${e.message ?? e}`);
      }
    } else {
      // Not deleting: stop it so the resume we triggered doesn't idle-burn
      // a VM for the next 30 minutes.
      await stopQuietly(vercelSandbox, 'vercel sandbox');
      console.log('    kept vercel sandbox (stopped) — rollback = flip column back');
    }
  }

  return 'migrated';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  requireEnv([
    'DATABASE_URL',
    'CLERK_SECRET_KEY',
    'VERCEL_TOKEN',
    'VERCEL_TEAM_ID',
    'VERCEL_PROJECT_ID',
    'SANDBOX_API_URL',
    'SANDBOX_HOST_TOKEN',
  ]);

  const url = env.DATABASE_URL.trim().replace(/^postgresql:\/\//, 'postgres://');
  const sql = neon(url);

  const conditions = [
    `deleted_at IS NULL`,
    `sandbox_provider = 'vercel'`,
    `platform IN ('sandboxed-web', 'swift')`,
    `reap_stage <> 'deleted'`,
    // Skip projects touched recently: a request racing the flip could write
    // to the old (Vercel) sandbox during the app's 60s provider-cache window.
    `(last_sandbox_activity_at IS NULL OR last_sandbox_activity_at < now() - interval '${MIN_IDLE_MINUTES} minutes')`,
  ];
  const params = [];
  if (ONLY_PROJECT) {
    params.push(ONLY_PROJECT);
    conditions.push(`id = $${params.length}`);
  }
  if (ONLY_USER) {
    params.push(ONLY_USER);
    conditions.push(`user_id = $${params.length}`);
  }

  const rows = await sql.query(
    `SELECT id, name, user_id, platform
       FROM projects
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ASC
      ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}`,
    params,
  );

  console.log(
    `${rows.length} candidate project(s) on vercel` +
      `${DRY_RUN ? ' [DRY RUN]' : ''}${DELETE_VERCEL ? ' [DELETE VERCEL]' : ''}`,
  );

  const summary = { migrated: 0, 'dry-run': 0, skippedTier: 0, failed: 0 };

  for (const project of rows) {
    let tier;
    try {
      tier = await resolveUserTier(project.user_id);
    } catch (e) {
      console.warn(`  ~ ${project.id} (${project.name}): tier lookup failed — skipping: ${e.message}`);
      summary.failed++;
      continue;
    }
    if (tier !== 'free') {
      summary.skippedTier++;
      continue;
    }

    console.log(`  → ${project.id} (${project.name}) [${project.platform}] owner=${project.user_id}`);
    try {
      const outcome = await migrateProject(sql, project);
      summary[outcome]++;
    } catch (e) {
      summary.failed++;
      console.error(`    ✗ FAILED (project left on vercel): ${e.message ?? e}`);
    }
  }

  console.log(
    `\nDone. migrated=${summary.migrated} dry-run=${summary['dry-run']} ` +
      `skipped(non-free)=${summary.skippedTier} failed=${summary.failed}`,
  );
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
