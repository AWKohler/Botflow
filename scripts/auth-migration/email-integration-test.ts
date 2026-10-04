/** Real database checks with synthetic identities and a captured mailbox. */
import { config } from "dotenv";
config({
  path: process.env.AUTH_MIGRATION_ENV_FILE || ".env.local",
  quiet: true,
});
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hash } from "bcryptjs";
import { betterAuth } from "better-auth";
import { getIdentityDb } from "../../src/lib/auth/database";
import { createIdentityAuth } from "../../src/lib/auth/config";
import { handleIdentityEmails } from "../../src/lib/auth/manage-emails";
import { getIdentityUser } from "../../src/lib/auth/directory";
async function main() {
  if (process.env.AUTH_MIGRATION_TARGET !== "staging")
    throw Error("Staging database required");
  const db = getIdentityDb();
  await db.query(
    await readFile("scripts/auth-migration/001-identity.sql", "utf8"),
  );
  const id = `alias-test-${randomUUID()}`,
    other = `alias-other-${randomUUID()}`;
  const primary = `${id}@example.invalid`,
    alias = `second-${id}@example.invalid`,
    reserved = `${other}@example.invalid`;
  const mailbox: { email: string; text: string }[] = [];
  const deliver = async (email: string, _subject: string, text: string) => {
    mailbox.push({ email, text });
  };
  const identity = createIdentityAuth(deliver);
  const base = process.env.BETTER_AUTH_URL!;
  let index = 0;
  async function auth(path: string, body: unknown) {
    return identity.handler(
      new Request(`${base}/api/auth${path}`, {
        method: "POST",
        headers: {
          origin: base,
          "content-type": "application/json",
          "x-forwarded-for": `127.2.1.${++index}`,
        },
        body: JSON.stringify(body),
      }),
    );
  }
  function cookies(response: Response) {
    return response.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
  }
  async function manage(body: unknown, cookie: string, origin = base) {
    return handleIdentityEmails(
      new Request(`${base}/api/identity/emails`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      identity,
      deliver,
    );
  }
  try {
    await db.query(
      "INSERT INTO identity_user(id,name,email,\"emailVerified\") VALUES($1,'Email test',$2,true),($3,'Other email test',$4,true)",
      [id, primary, other, reserved],
    );
    await db.query(
      'INSERT INTO identity_account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',
      [randomUUID(), id, await hash("email-test-passphrase", 10)],
    );
    const login = await auth("/sign-in/email", {
      email: primary,
      password: "email-test-passphrase",
    });
    assert.equal(login.status, 200);
    const cookie = cookies(login);
    assert.equal(
      (await manage({ action: "request", email: alias }, "")).status,
      401,
    );
    assert.equal(
      (
        await manage(
          { action: "request", email: alias },
          cookie,
          "https://attacker.invalid",
        )
      ).status,
      403,
    );
    assert.equal(
      (await manage({ action: "request", email: reserved }, cookie)).status,
      409,
    );
    assert.equal(
      (await manage({ action: "request", email: alias }, cookie)).status,
      200,
    );
    const code = mailbox.at(-1)!.text.match(/\b\d{6}\b/)![0];
    assert.equal(mailbox.at(-1)!.email, alias);
    const challenge = (
      await db.query(
        "SELECT digest FROM identity_email_challenge WHERE user_id=$1",
        [id],
      )
    ).rows[0];
    assert.notEqual(challenge.digest, code);
    assert.equal(
      (await manage({ action: "request", email: `third-${alias}` }, cookie))
        .status,
      429,
    );
    assert.equal(
      (
        await manage(
          {
            action: "verify",
            email: alias,
            otp: code === "000000" ? "111111" : "000000",
          },
          cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await db.query(
          "SELECT attempts FROM identity_email_challenge WHERE user_id=$1 AND email=$2",
          [id, alias],
        )
      ).rows[0].attempts,
      1,
    );
    await db.query(
      "UPDATE identity_email_challenge SET attempts=5 WHERE user_id=$1",
      [id],
    );
    assert.equal(
      (await manage({ action: "verify", email: alias, otp: code }, cookie))
        .status,
      400,
    );
    await db.query(
      "UPDATE identity_email_challenge SET attempts=0,expires_at=now()-interval '1 second' WHERE user_id=$1",
      [id],
    );
    assert.equal(
      (await manage({ action: "verify", email: alias, otp: code }, cookie))
        .status,
      400,
    );
    await db.query(
      "UPDATE identity_email_challenge SET expires_at=now()+interval '10 minutes' WHERE user_id=$1",
      [id],
    );
    assert.equal(
      (await manage({ action: "verify", email: alias, otp: code }, cookie))
        .status,
      200,
    );
    assert.equal(
      (await manage({ action: "verify", email: alias, otp: code }, cookie))
        .status,
      400,
    );
    const aliasLogin = await auth("/sign-in/email", {
      email: alias,
      password: "email-test-passphrase",
    });
    assert.equal(aliasLogin.status, 200);
    assert.equal((await aliasLogin.json()).user.id, id);
    const signupCollision = await auth("/sign-up/email", {
      email: alias,
      password: "new-test-passphrase",
      name: "Collision",
    });
    assert.equal(signupCollision.status, 200);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM identity_user WHERE email=$1",
          [alias],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await auth("/email-otp/send-verification-otp", {
          email: alias,
          type: "sign-in",
        })
      ).status,
      200,
    );
    const loginOtp = mailbox.at(-1)!.text.match(/\b\d{6}\b/)![0];
    const otpLogin = await auth("/sign-in/email-otp", {
      email: alias,
      otp: loginOtp,
    });
    assert.equal(otpLogin.status, 200);
    assert.equal((await otpLogin.json()).user.id, id);
    const directory = await getIdentityUser(id);
    assert.equal(directory.emailAddresses.length, 2);
    assert.equal(
      (await manage({ action: "primary", email: alias }, cookie)).status,
      200,
    );
    assert.equal(
      (await manage({ action: "remove", email: alias }, cookie)).status,
      400,
    );
    const oldPrimary = await auth("/sign-in/email", {
      email: primary,
      password: "email-test-passphrase",
    });
    assert.equal(oldPrimary.status, 200);
    assert.equal((await oldPrimary.json()).user.id, id);
    await assert.rejects(
      db.query("UPDATE identity_user SET email=$2 WHERE id=$1", [
        other,
        primary,
      ]),
    );
    assert.equal(
      (await manage({ action: "remove", email: primary }, cookie)).status,
      200,
    );
    assert.notEqual(
      (
        await auth("/sign-in/email", {
          email: primary,
          password: "email-test-passphrase",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await auth("/email-otp/send-verification-otp", {
          email: alias,
          type: "forget-password",
        })
      ).status,
      200,
    );
    const resetOtp = mailbox.at(-1)!.text.match(/\b\d{6}\b/)![0];
    assert.equal(
      (
        await auth("/email-otp/reset-password", {
          email: alias,
          otp: resetOtp,
          password: "replacement-test-passphrase",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await auth("/sign-in/email", {
          email: alias,
          password: "replacement-test-passphrase",
        })
      ).status,
      200,
    );
    // Only this isolated test instance accepts a synthetic provider response.
    const mockProvider = betterAuth({
      ...identity.options,
      socialProviders: {
        google: {
          clientId: "synthetic-client",
          clientSecret: "synthetic-secret",
          verifyIdToken: async () => true,
          getUserInfo: async () => ({
            user: {
              name: "Provider test",
              email: `provider-${id}@example.invalid`,
              emailVerified: true,
            },
            data: {
              sub: `provider-${id}`,
              aud: "synthetic-client",
              azp: "synthetic-client",
              email: `provider-${id}@example.invalid`,
              email_verified: true,
              name: "Provider test",
              given_name: "Provider",
              family_name: "Test",
              picture: "",
              iss: "https://accounts.google.com",
              iat: Math.floor(Date.now() / 1000),
              exp: Math.floor(Date.now() / 1000) + 300,
            },
          }),
        },
      },
    });
    async function mockRequest(path: string, body: unknown, cookie: string) {
      return mockProvider.handler(
        new Request(`${base}/api/auth${path}`, {
          method: "POST",
          headers: {
            origin: base,
            cookie,
            "content-type": "application/json",
            "x-forwarded-for": `127.3.1.${++index}`,
          },
          body: JSON.stringify(body),
        }),
      );
    }
    const linkLogin = await auth("/sign-in/email", {
      email: alias,
      password: "replacement-test-passphrase",
    });
    const linked = await mockRequest(
      "/link-social",
      { provider: "google", idToken: { token: "synthetic-id-token" } },
      cookies(linkLogin),
    );
    assert.equal(linked.status, 200);
    assert.equal(
      (
        await db.query(
          `SELECT "userId" FROM identity_account WHERE "providerId"='google' AND "accountId"=$1`,
          [`provider-${id}`],
        )
      ).rows[0].userId,
      id,
    );
    await db.query(
      `INSERT INTO identity_account(id,"accountId","providerId","userId",password) VALUES($1,$2,'credential',$2,$3)`,
      [randomUUID(), other, await hash("other-test-passphrase", 10)],
    );
    const otherLogin = await auth("/sign-in/email", {
      email: reserved,
      password: "other-test-passphrase",
    });
    const collision = await mockRequest(
      "/link-social",
      { provider: "google", idToken: { token: "synthetic-id-token" } },
      cookies(otherLogin),
    );
    assert.equal(collision.status, 409);
    const socialLogin = await mockRequest(
      "/sign-in/social",
      { provider: "google", idToken: { token: "synthetic-id-token" } },
      "",
    );
    assert.equal(socialLogin.status, 200);
    assert.equal((await socialLogin.json()).user.id, id);
    const accountId = (
      await db.query(
        `SELECT id FROM identity_account WHERE "providerId"='google' AND "accountId"=$1`,
        [`provider-${id}`],
      )
    ).rows[0].id;
    assert.equal(
      (await mockRequest("/unlink-account", { accountId }, cookies(linkLogin)))
        .status,
      200,
    );
    const refreshedLogin = await auth("/sign-in/email", {
      email: alias,
      password: "replacement-test-passphrase",
    });
    const freshCookie = cookies(refreshedLogin);
    await db.query(
      'UPDATE identity_session SET "impersonatedBy"=$2 WHERE "userId"=$1',
      [id, other],
    );
    assert.equal(
      (
        await manage(
          { action: "request", email: `third-${alias}` },
          freshCookie,
        )
      ).status,
      403,
    );
    await db.query(
      `UPDATE identity_session SET "impersonatedBy"=NULL,"createdAt"=now()-interval '16 minutes' WHERE "userId"=$1`,
      [id],
    );
    assert.equal(
      (
        await manage(
          { action: "request", email: `third-${alias}` },
          freshCookie,
        )
      ).status,
      403,
    );
    console.log(
      "Email integration checks passed: verification, alias password/OTP/recovery, namespace collisions, primary selection, removal, origin and rate guards.",
    );
  } finally {
    await db.query(
      "DELETE FROM identity_audit WHERE actor_id=ANY($1::text[])",
      [[id, other]],
    );
    await db.query("DELETE FROM identity_rate_limit WHERE key=$1", [
      `alias-email:${id}`,
    ]);
    await db.query(
      "DELETE FROM identity_verification WHERE identifier LIKE $1",
      [`%${id}%`],
    );
    await db.query("DELETE FROM identity_user WHERE id=ANY($1::text[])", [
      [id, other],
    ]);
    await db.end();
  }
}
main().catch((error) => {
  console.error(error.message);
  console.error(
    error.stack
      ?.split("\n")
      .find((line: string) => line.includes("email-integration-test.ts")),
  );
  process.exitCode = 1;
});
