#!/usr/bin/env node
/**
 * Run the test suite with a scrubbed environment.
 *
 * The Vercel build runs this before `next build` (see vercel.json). That build
 * environment holds production secrets and feature flags (DATABASE_URL, Stripe
 * keys, NEXT_PUBLIC_* flags...). Tests must never see them — both so a test
 * can't touch a real service and so results are identical locally and on
 * Vercel. Only process plumbing is passed through; each test sets the env it
 * needs itself.
 *
 *   node scripts/test.mjs            # run once
 *   node scripts/test.mjs watch      # watch mode
 *   node scripts/test.mjs src/lib    # filter, any vitest args
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PASS_THROUGH = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'FORCE_COLOR', 'NO_COLOR', 'CI', 'NODE_OPTIONS'];

const env = { TZ: 'UTC' };
for (const key of PASS_THROUGH) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}

const args = process.argv.slice(2);
const watch = args[0] === 'watch';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitest = path.join(root, 'node_modules', '.bin', 'vitest');
const result = spawnSync(vitest, watch ? args.slice(1) : ['run', ...args], {
  cwd: root,
  stdio: 'inherit',
  env,
});
if (result.error) {
  console.error(result.error);
}
process.exit(result.status ?? 1);
