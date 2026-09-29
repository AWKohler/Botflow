import { config } from "dotenv";
config({ path: process.env.AUTH_MIGRATION_ENV_FILE || ".env.local", quiet: true });
import { readFile } from "node:fs/promises";
import { decryptPrivateData } from "../../src/lib/auth/crypto";
import { getIdentityDb } from "../../src/lib/auth/database";
import { symmetricDecrypt } from "better-auth/crypto";
import type { Snapshot } from "./snapshot";
import assert from "node:assert/strict";
async function main() {
  const snapshot = decryptPrivateData<Snapshot>(
    await readFile(".migration/clerk-snapshot.enc", "utf8"),
    "clerk-migration-snapshot",
  );
  const db = getIdentityDb();
  let passwordCount = 0,
    providerCount = 0,
    tokenCount = 0;
  for (const source of snapshot.users) {
    const primary = source.email_addresses.find(
      (e) => e.id === source.primary_email_address_id,
    )!;
    const {
      rows: [row],
    } = await db.query(
      "SELECT u.*,p.* FROM identity_user u JOIN identity_profile p ON p.user_id=u.id WHERE u.id=$1",
      [source.id],
    );
    assert.ok(row, `Missing identity ${source.id}`);
    assert.equal(row.email, primary.email_address.toLowerCase());
    assert.equal(
      row.emailVerified,
      primary.verification?.status === "verified",
    );
    assert.deepEqual(row.public_metadata, source.public_metadata);
    assert.deepEqual(row.unsafe_metadata, source.unsafe_metadata);
    assert.deepEqual(
      decryptPrivateData(
        row.private_metadata_encrypted,
        `profile:${source.id}`,
      ),
      source.private_metadata,
    );
    const { rows: accounts } = await db.query(
      'SELECT * FROM identity_account WHERE "userId"=$1',
      [source.id],
    );
    if (source.password_enabled) {
      assert.equal(
        accounts.find((a) => a.providerId === "credential")?.password,
        snapshot.passwords[source.id].password_digest,
      );
      passwordCount++;
    }
    for (const a of source.external_accounts) {
      const local = accounts.find(
        (x) => x.providerId === a.provider.replace(/^oauth_/, ""),
      );
      assert.equal(local?.accountId, a.provider_user_id);
      providerCount++;
      const available = snapshot.tokens[`${source.id}:${a.provider}`];
      const token = Array.isArray(available)
        ? available.find((t) => t.provider_user_id === a.provider_user_id)
        : null;
      if (token?.token) {
        assert.equal(
          await symmetricDecrypt({
            key: process.env.BETTER_AUTH_SECRET!,
            data: local.accessToken,
          }),
          token.token,
        );
        tokenCount++;
      }
    }
  }
  const projectCoverage = await db
    .query(
      "SELECT count(DISTINCT p.user_id) AS orphan_owners FROM projects p LEFT JOIN identity_user u ON u.id=p.user_id WHERE u.id IS NULL",
    )
    .catch(() => null);
  console.log(
    JSON.stringify(
      {
        verifiedUsers: snapshot.users.length,
        verifiedPasswordHashes: passwordCount,
        verifiedProviderLinks: providerCount,
        verifiedProviderTokens: tokenCount,
        allMetadataMatches: true,
        unmatchedProjectOwners:
          projectCoverage?.rows[0].orphan_owners ?? "not checked",
      },
      null,
      2,
    ),
  );
  await db.end();
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
