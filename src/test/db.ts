import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import * as schema from '@/db/schema';

export type TestDb = PgliteDatabase<typeof schema>;

type QueryResult = { rows: any[]; rowCount: number }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The subset of a `pg` Pool the identity layer uses (query + connect/release). */
export interface IdentityPool {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  connect(): Promise<{ query: IdentityPool['query']; release(): void }>;
  end(): Promise<void>;
}

let current: { pg: PGlite; db: TestDb; pool: IdentityPool } | null = null;

function missing(): never {
  throw new Error('Database used without a test database. Call setupTestDb() at the top of the test file.');
}

/** What the mocked `getDb()` returns (src/test/setup.ts). */
export function currentTestDb(): TestDb {
  return current?.db ?? missing();
}

/** What the mocked `getIdentityDb()` returns — same PGlite, `pg`-shaped. */
export function currentIdentityPool(): IdentityPool {
  return current?.pool ?? missing();
}

function poolOver(pg: PGlite): IdentityPool {
  const query: IdentityPool['query'] = async (text, params = []) => {
    const r = await pg.query(text, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  // One connection underneath: serialize "checked-out" clients so two
  // transactions in a test can't interleave their BEGIN/COMMIT.
  let tail = Promise.resolve();
  return {
    query,
    async connect() {
      let release!: () => void;
      const prev = tail;
      tail = new Promise<void>((r) => (release = r));
      await prev;
      return { query, release };
    },
    async end() {},
  };
}

async function createDb() {
  const pg = new PGlite();
  for (const stmt of inject('schemaDdl')) await pg.exec(stmt);
  await pg.exec(inject('identitySql'));
  return { pg, db: drizzle(pg, { schema }), pool: poolOver(pg) };
}

async function truncateAll(pg: PGlite) {
  const { rows } = await pg.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public'",
  );
  if (rows.length === 0) return;
  await pg.exec(`truncate ${rows.map((r) => `"${r.tablename}"`).join(', ')} restart identity cascade`);
}

/**
 * Every row of every table, for asserting a request changed nothing:
 *   const before = await snapshotDb(); ...; expect(await snapshotDb()).toEqual(before)
 */
export async function snapshotDb(): Promise<Record<string, unknown[]>> {
  if (!current) missing();
  const { pg } = current;
  const { rows } = await pg.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  const out: Record<string, unknown[]> = {};
  for (const { tablename } of rows) {
    const res = await pg.query(`select * from "${tablename}" order by 1`);
    if (res.rows.length) out[tablename] = res.rows;
  }
  return out;
}

/**
 * Give this test file a real in-process Postgres (PGlite) holding the app
 * schema and the identity/billing tables. Every app call to `getDb()` and
 * `getIdentityDb()` hits it. All tables are truncated before each test.
 */
export function setupTestDb(): () => TestDb {
  beforeAll(async () => {
    current = await createDb();
  });
  beforeEach(async () => {
    if (current) await truncateAll(current.pg);
  });
  afterAll(async () => {
    await current?.pg.close();
    current = null;
  });
  return currentTestDb;
}
