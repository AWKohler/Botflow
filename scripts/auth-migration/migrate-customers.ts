/** Reuse Clerk's existing Stripe customers and preserve pre-cutover receipts. */
import { config } from "dotenv";
config({
  path: process.env.AUTH_MIGRATION_ENV_FILE || ".env.local",
  quiet: true,
});
import { readFile } from "node:fs/promises";
import { migrationArtifactPath } from "./artifacts";
import { decryptPrivateData } from "../../src/lib/auth/crypto";
import { getIdentityDb } from "../../src/lib/auth/database";
import { billingStripe } from "../../src/lib/billing/stripe";
import type { Snapshot } from "./snapshot";
async function main() {
  if (
    process.env.AUTH_MIGRATION_TARGET !== "production" ||
    process.env.BILLING_STRIPE_MODE !== "live"
  )
    throw new Error("Production/live customer reconciliation required");
  const snapshot = decryptPrivateData<Snapshot>(
    await readFile(migrationArtifactPath("clerk-snapshot.enc"), "utf8"),
    "clerk-migration-snapshot",
  );
  if (snapshot.instanceId !== process.env.CLERK_MIGRATION_INSTANCE_ID)
    throw new Error("Source instance mismatch");
  const promotion = JSON.parse(
    await readFile(migrationArtifactPath("promotion.json"), "utf8"),
  );
  const cutoff = new Date(promotion.requestedAt);
  if (!Number.isFinite(cutoff.getTime()) || cutoff.getTime() > Date.now())
    throw new Error("Native production cutover timestamp required");
  const users = new Set(snapshot.users.map((u) => u.id));
  const matches = new Map<string, string>();
  for await (const customer of billingStripe().customers.list({ limit: 100 })) {
    const id = customer.metadata.user_id || customer.metadata.botflow_user_id;
    if (!users.has(id)) continue;
    if (
      matches.has(id) ||
      (customer.metadata.user_id &&
        customer.metadata.botflow_user_id &&
        customer.metadata.user_id !== customer.metadata.botflow_user_id)
    )
      throw new Error(
        "Ambiguous customer ownership; reconcile before applying",
      );
    matches.set(id, customer.id);
  }
  if (matches.size !== users.size)
    throw new Error("An existing source customer is missing");
  const db = getIdentityDb();
  const run = await db.query(
    "SELECT id FROM identity_migration_run WHERE manifest_digest=$1",
    [snapshot.digest],
  );
  if (run.rowCount !== 1)
    throw new Error("Verified source import required before linking customers");
  console.log(
    JSON.stringify({
      ready: true,
      existingCustomers: matches.size,
      apply: process.argv.includes("--apply"),
    }),
  );
  if (!process.argv.includes("--apply")) {
    await db.end();
    return;
  }
  const host = new URL(process.env.DATABASE_URL!).hostname;
  if (!process.argv.includes(`--target-host=${host}`))
    throw new Error("Explicit production database target required");
  await db.query(
    await readFile("scripts/auth-migration/001-identity.sql", "utf8"),
  );
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    for (const [id, customerId] of [...matches].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      await connection.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `billing:${id}`,
      ]);
      const row = (
        await connection.query(
          "SELECT * FROM botflow_subscription WHERE user_id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (
        !row ||
        (row.stripe_customer_id && row.stripe_customer_id !== customerId) ||
        (row.plan !== "free" && row.stripe_customer_id !== customerId)
      )
        throw new Error(
          "Customer mapping conflicts with current native billing; no changes committed",
        );
      await connection.query(
        "UPDATE botflow_subscription SET stripe_customer_id=$2,source=CASE WHEN plan='free' THEN 'stripe' ELSE source END,legacy_billing_cutover_at=COALESCE(legacy_billing_cutover_at,$3),updated_at=now() WHERE user_id=$1",
        [id, customerId, cutoff],
      );
    }
    await connection.query("COMMIT");
    console.log(
      JSON.stringify({
        customersLinked: matches.size,
        existingPlansAndCardsPreserved: true,
        legacyReceiptCutoff: cutoff.toISOString(),
      }),
    );
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
    await db.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Customer migration failed",
  );
  process.exitCode = 1;
});
