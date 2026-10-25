/**
 * Schema drift guard: replaying every drizzle/*.sql migration in order must
 * produce the same database as src/db/schema.ts. A schema.ts edit without a
 * matching migration (or a migration that doesn't match the TS) fails here
 * instead of in production.
 *
 * Compares the two databases' catalogs directly (columns, indexes, and
 * constraints by definition) rather than via drizzle-kit's pushSchema, which
 * stops to ask "created or renamed?" questions that need a TTY.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as schema from './schema';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

/**
 * Drift that predates this guard. Each entry needs a decision (write the
 * migration, or change schema.ts to match prod) — then delete it here.
 */
const KNOWN_DRIFT = [
  // 0000_baseline has DEFAULT 'fireworks-kimi-k2p7'; schema.ts says gpt-6-luna.
  // Every insert path passes a model explicitly, so the live default is unused.
  "column projects.model text NOT NULL DEFAULT 'fireworks-kimi-k2p7'::text",
  "column projects.model text NOT NULL DEFAULT 'gpt-6-luna'::text",
];

const CATALOG = `
  select 'column ' || table_name || '.' || column_name || ' ' || data_type
         || case when is_nullable = 'NO' then ' NOT NULL' else '' end
         || coalesce(' DEFAULT ' || column_default, '') as item
    from information_schema.columns where table_schema = 'public'
  union all
  select 'index ' || tablename || ' ' || regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX \\S+ ON \\S+ ', '\\1')
    from pg_indexes where schemaname = 'public'
  union all
  -- Constraint NAMES differ (hand-written FKs use Postgres' <table>_<col>_fkey);
  -- compare what they enforce.
  select 'constraint ' || conrelid::regclass || ' ' || pg_get_constraintdef(oid)
    from pg_constraint where connamespace = 'public'::regnamespace and contype in ('p', 'f', 'u', 'c')
  order by 1`;

function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

async function replayMigrations(pg: PGlite) {
  for (const file of migrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      if (!stmt.trim()) continue;
      try {
        await pg.exec(stmt);
      } catch (e) {
        throw new Error(`${file}: ${(e as Error).message}`);
      }
    }
  }
}

async function catalog(pg: PGlite): Promise<Set<string>> {
  return new Set((await pg.query<{ item: string }>(CATALOG)).rows.map((r) => r.item));
}

describe('drizzle migrations', () => {
  let fromMigrations: PGlite;
  let fromSchema: PGlite;

  beforeAll(async () => {
    fromMigrations = new PGlite();
    await replayMigrations(fromMigrations);
    fromSchema = new PGlite();
    const ddl = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema as Record<string, unknown>));
    for (const stmt of ddl) await fromSchema.exec(stmt);
  });

  afterAll(async () => {
    await fromMigrations?.close();
    await fromSchema?.close();
  });

  test('replay cleanly and are safe to re-run (applied by hand via scripts)', async () => {
    for (const file of migrationFiles().slice(1)) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await expect(fromMigrations.exec(sql), file).resolves.toBeDefined();
    }
  });

  test('match src/db/schema.ts', async () => {
    const a = await catalog(fromMigrations);
    const b = await catalog(fromSchema);
    const onlyMigrations = [...a].filter((x) => !b.has(x) && !KNOWN_DRIFT.includes(x));
    const onlySchema = [...b].filter((x) => !a.has(x) && !KNOWN_DRIFT.includes(x));
    expect({ onlyMigrations, onlySchema }, 'schema.ts and drizzle/ disagree — add a migration (or fix schema.ts)').toEqual({
      onlyMigrations: [],
      onlySchema: [],
    });
  });
});
