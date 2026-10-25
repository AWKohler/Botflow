import fs from 'node:fs';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../db/schema';

declare module 'vitest' {
  export interface ProvidedContext {
    schemaDdl: string[];
    identitySql: string;
  }
}

/**
 * Build the test database DDL once per run and hand it to every worker:
 *  - app tables from the current src/db/schema.ts (so uncommitted schema edits
 *    are tested immediately; src/db/migrations.test.ts checks drizzle/ agrees)
 *  - identity + billing tables from the raw-SQL auth migration (Better Auth
 *    identity_*, botflow_subscription, ...), which drizzle doesn't model.
 */
export default async function setup(project: TestProject) {
  const ddl = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as Record<string, unknown>),
  );
  project.provide('schemaDdl', ddl);
  project.provide(
    'identitySql',
    fs.readFileSync(path.resolve(__dirname, '../../scripts/auth-migration/001-identity.sql'), 'utf8'),
  );
}
