import { Pool } from "pg";

let pool: Pool | undefined;
/** Shared pool for identity, encrypted metadata, billing, and audit transactions. */
export function getIdentityDb(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  }));
}
