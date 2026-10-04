import { migrationArtifactPath } from "./artifacts";
import { config } from "dotenv";
config({
  path: process.env.AUTH_MIGRATION_ENV_FILE || ".env.local",
  quiet: true,
});
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { getIdentityDb } from "../../src/lib/auth/database";
import {
  decryptPrivateData,
  encryptPrivateData,
} from "../../src/lib/auth/crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import type { Snapshot } from "./snapshot";

async function main() {
  const snapshot = decryptPrivateData<Snapshot>(
    await readFile(migrationArtifactPath("clerk-snapshot.enc"), "utf8"),
    "clerk-migration-snapshot",
  );
  const { digest, ...payload } = snapshot;
  if (
    createHash("sha256").update(JSON.stringify(payload)).digest("hex") !==
    digest
  )
    throw new Error("Snapshot digest mismatch");
  if (
    snapshot.version !== 1 ||
    snapshot.instanceId !== process.env.CLERK_MIGRATION_INSTANCE_ID
  )
    throw new Error(
      "Set CLERK_MIGRATION_INSTANCE_ID to the verified source instance",
    );
  const problems: string[] = [];
  const emails = new Set<string>();
  for (const user of snapshot.users) {
    const primary = user.email_addresses.find(
      (e) => e.id === user.primary_email_address_id,
    );
    if (!primary || emails.has(primary.email_address.toLowerCase()))
      problems.push(`${user.id}: missing or duplicate primary email`);
    if (primary) emails.add(primary.email_address.toLowerCase());
    if (user.two_factor_enabled || user.passkeys?.length)
      problems.push(
        `${user.id}: MFA/passkey migration requires additional verification`,
      );
    const hash = snapshot.passwords[user.id];
    if (
      user.password_enabled &&
      (!hash ||
        !/^\$2[aby]\$/.test(hash.password_digest) ||
        hash.password_hasher !== "bcrypt")
    )
      problems.push(`${user.id}: missing or unsupported password hash`);
    if (
      user.external_accounts.some(
        (a) => !["oauth_google", "oauth_github"].includes(a.provider),
      )
    )
      problems.push(`${user.id}: unsupported social provider`);
  }
  if (problems.length) {
    console.error(JSON.stringify({ ready: false, problems }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      ready: true,
      users: snapshot.users.length,
      passwords: Object.keys(snapshot.passwords).length,
      apply: process.argv.includes("--apply"),
    }),
  );
  if (!process.argv.includes("--apply")) return;
  const targetHost = new URL(process.env.DATABASE_URL!).hostname;
  if (
    !["staging", "production"].includes(
      process.env.AUTH_MIGRATION_TARGET ?? "",
    ) ||
    !process.argv.includes(`--target-host=${targetHost}`)
  )
    throw new Error("Explicit migration target and --target-host are required");
  if (!process.env.BETTER_AUTH_SECRET)
    throw new Error(
      "BETTER_AUTH_SECRET is required for provider token encryption",
    );
  const pool = getIdentityDb();
  await pool.query(
    await readFile("scripts/auth-migration/001-identity.sql", "utf8"),
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('clerk-identity-import'))",
    );
    const prior = await client.query(
      "SELECT id FROM identity_migration_run WHERE manifest_digest=$1",
      [digest],
    );
    if (prior.rowCount) {
      console.log("Snapshot already imported");
      await client.query("ROLLBACK");
      return;
    }
    for (const user of snapshot.users) {
      const primary = user.email_addresses.find(
        (e) => e.id === user.primary_email_address_id,
      )!;
      const params = [
        user.id,
        [user.first_name, user.last_name].filter(Boolean).join(" ") ||
          user.username ||
          primary.email_address,
        primary.email_address.toLowerCase(),
        primary.verification?.status === "verified",
        user.image_url,
        new Date(user.created_at),
        new Date(user.updated_at),
        user.banned || user.locked,
        user.username?.toLowerCase() ?? null,
        user.username,
      ];
      // Only insert identities on replay: never overwrite a locally changed password,
      // verified email, session, role, or metadata with an older Clerk snapshot.
      const result = await client.query(
        `INSERT INTO identity_user (id,name,email,"emailVerified",image,"createdAt","updatedAt",banned,username,"displayUsername") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING RETURNING id`,
        params,
      );
      if (!result.rowCount) continue;
      const addresses = user.email_addresses.map((e) => ({
        id: e.id,
        emailAddress: e.email_address,
        verification: { status: e.verification?.status ?? "unverified" },
      }));
      await client.query(
        `INSERT INTO identity_profile (user_id,first_name,last_name,username,email_addresses,public_metadata,unsafe_metadata,private_metadata_encrypted,last_sign_in_at,source_updated_at,source_primary_email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          user.id,
          user.first_name,
          user.last_name,
          user.username,
          JSON.stringify(addresses),
          JSON.stringify(user.public_metadata),
          JSON.stringify(user.unsafe_metadata),
          encryptPrivateData(user.private_metadata, `profile:${user.id}`),
          user.last_sign_in_at ? new Date(user.last_sign_in_at) : null,
          new Date(user.updated_at),
          primary.email_address.toLowerCase(),
        ],
      );
      for (const address of user.email_addresses) {
        if (address.id === user.primary_email_address_id) continue;
        await client.query(
          "INSERT INTO identity_email(email,user_id,verified) VALUES(lower($1),$2,$3)",
          [
            address.email_address,
            user.id,
            address.verification?.status === "verified",
          ],
        );
      }
      if (user.password_enabled)
        await client.query(
          `INSERT INTO identity_account (id,"accountId","providerId","userId",password) VALUES ($1,$2,'credential',$2,$3)`,
          [randomUUID(), user.id, snapshot.passwords[user.id].password_digest],
        );
      for (const account of user.external_accounts) {
        const available = snapshot.tokens[`${user.id}:${account.provider}`];
        const token = Array.isArray(available)
          ? available.find(
              (t) => t.provider_user_id === account.provider_user_id,
            )
          : null;
        const encryptedToken = token?.token
          ? await symmetricEncrypt({
              key: process.env.BETTER_AUTH_SECRET!,
              data: token.token,
            })
          : null;
        await client.query(
          `INSERT INTO identity_account (id,"accountId","providerId","userId",scope,"accessToken","accessTokenExpiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            account.id,
            account.provider_user_id,
            account.provider.replace(/^oauth_/, ""),
            user.id,
            account.approved_scopes,
            encryptedToken,
            token?.expires_at ? new Date(token.expires_at) : null,
          ],
        );
      }
      const subscription = snapshot.subscriptions[user.id];
      const items = subscription.subscription_items.filter((i) =>
        ["active", "past_due", "canceled"].includes(i.status),
      );
      const paid = items.filter((i) =>
        ["pro", "max", "staff"].includes(i.plan.slug),
      );
      if (paid.length > 1)
        throw new Error(
          `Multiple legacy paid subscriptions for ${user.id}; reconcile before import`,
        );
      const item = paid[0] ?? items[0];
      if (item) {
        const fee =
          item.plan_period === "annual" || item.plan_period === "year"
            ? item.plan.annual_fee
            : item.plan.fee;
        const plan = item.plan.slug === "free_user" ? "free" : item.plan.slug;
        await client.query(
          `INSERT INTO botflow_subscription (user_id,source,clerk_subscription_id,clerk_item_id,plan,status,amount,currency,interval,period_start,period_end,cancel_at_period_end) VALUES ($1,'clerk',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            user.id,
            subscription.id,
            item.id,
            plan,
            item.status,
            fee.amount,
            fee.currency?.toLowerCase() || "usd",
            item.plan_period === "annual" || item.plan_period === "year"
              ? "year"
              : "month",
            item.period_start ? new Date(item.period_start) : null,
            item.period_end ? new Date(item.period_end) : null,
            !!item.canceled_at,
          ],
        );
      }
    }
    await client.query(
      "INSERT INTO identity_migration_run (id,source_instance,user_count,manifest_digest) VALUES ($1,$2,$3,$4)",
      [randomUUID(), snapshot.instanceId, snapshot.users.length, digest],
    );
    await client.query("COMMIT");
    console.log(
      "Import committed. No Clerk users, sessions, or subscriptions were modified.",
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Import failed");
  process.exitCode = 1;
});
