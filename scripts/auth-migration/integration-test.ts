/** Runs only against the isolated migration branch. No real emails are sent. */
import { config } from "dotenv";
config({ path: process.env.AUTH_MIGRATION_ENV_FILE || ".env.local", quiet: true });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { getIdentityDb } from "../../src/lib/auth/database";
import { createIdentityAuth } from "../../src/lib/auth/config";
import { POST as guardedAuthPost } from "../../src/app/api/auth/[...all]/route";
async function main() {
  if (process.env.AUTH_MIGRATION_TARGET !== "staging")
    throw new Error("Integration tests require the isolated staging database");
  const db = getIdentityDb();
  const tag = randomUUID();
  const ownerId = `rehearsal-owner-${tag}`,
    legacyId = `rehearsal-legacy-${tag}`;
  process.env.PANEL_ADMIN_USER_IDS = ownerId;
  const mailbox: { email: string; subject: string; text: string }[] = [];
  const identity = createIdentityAuth(async (email, subject, text) => {
    mailbox.push({ email, subject, text });
  });
  const base = process.env.BETTER_AUTH_URL!;
  let requestIndex = 1;
  async function request(
    path: string,
    body?: unknown,
    cookie = "",
    origin = base,
    guarded = false,
  ) {
    const req = new Request(`${base}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie,
        "x-forwarded-for": `127.0.${Math.floor(Math.random() * 240) + 1}.${requestIndex++}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return guarded ? guardedAuthPost(req) : identity.handler(req);
  }
  function cookies(response: Response, original = "") {
    const jar = new Map(
      original
        .split("; ")
        .filter(Boolean)
        .map((s) => {
          const i = s.indexOf("=");
          return [s.slice(0, i), s.slice(i + 1)];
        }),
    );
    for (const entry of response.headers.getSetCookie()) {
      const raw = entry.split(";")[0];
      const i = raw.indexOf("=");
      jar.set(raw.slice(0, i), raw.slice(i + 1));
    }
    return [...jar]
      .filter(([, v]) => v)
      .map(([k, v]) => k + "=" + v)
      .join("; ");
  }
  const email = `rehearsal-${tag}@example.invalid`,
    legacyEmail = `legacy-${tag}@example.invalid`,
    ownerEmail = `owner-${tag}@example.invalid`;
  let signupId: string | undefined;
  try {
    const signup = await request("/sign-up/email", {
      email,
      password: "integration-passphrase",
      name: "Migration rehearsal",
    });
    assert.equal(signup.status, 200, await signup.clone().text());
    signupId = (await signup.json()).user.id;
    assert.ok(mailbox.length > 0);
    const otp = mailbox.at(-1)!.text.match(/\b\d{6}\b/)?.[0];
    assert.ok(otp);
    const early = await request("/sign-in/email", {
      email,
      password: "integration-passphrase",
    });
    assert.equal(early.status, 403);
    const wrongOtp = await request("/email-otp/verify-email", {
      email,
      otp: "000000" === otp ? "111111" : "000000",
    });
    assert.notEqual(wrongOtp.status, 200);
    const verified = await request("/email-otp/verify-email", { email, otp });
    assert.equal(verified.status, 200, await verified.clone().text());
    const signIn = await request("/sign-in/email", {
      email,
      password: "integration-passphrase",
    });
    assert.equal(signIn.status, 200, await signIn.clone().text());
    const userCookie = cookies(signIn);
    assert.ok(userCookie);
    const session = await request("/get-session", undefined, userCookie);
    const sessionBody = await session.json();
    assert.equal(sessionBody.user.id, signupId);
    assert.equal(sessionBody.user.privateMetadata, undefined);
    assert.equal(sessionBody.user.password, undefined);
    const escalation = await request(
      "/update-user",
      { role: "admin" },
      userCookie,
    );
    assert.ok([200, 400, 422].includes(escalation.status));
    assert.equal(
      (await db.query("SELECT role FROM identity_user WHERE id=$1", [signupId]))
        .rows[0].role,
      "user",
    );
    const crossOrigin = await request(
      "/change-password",
      {
        currentPassword: "integration-passphrase",
        newPassword: "attacker-passphrase",
      },
      userCookie,
      "https://attacker.invalid",
    );
    assert.equal(crossOrigin.status, 403);
    await db.query(
      `INSERT INTO identity_user(id,name,email,"emailVerified") VALUES ($1,'Legacy rehearsal',$2,true),($3,'Owner rehearsal',$4,true)`,
      [legacyId, legacyEmail, ownerId, ownerEmail],
    );
    for (const id of [legacyId, ownerId])
      await db.query(
        `INSERT INTO identity_account(id,"accountId","providerId","userId",password) VALUES ($1,$2,'credential',$2,$3)`,
        [randomUUID(), id, await hash("legacy-test-passphrase", 10)],
      );
    const legacy = await request("/sign-in/email", {
      email: legacyEmail,
      password: "legacy-test-passphrase",
    });
    assert.equal(legacy.status, 200, await legacy.clone().text());
    const denied = await request(
      "/admin/list-users",
      undefined,
      cookies(legacy),
    );
    assert.equal(denied.status, 403);
    const owner = await request("/sign-in/email", {
      email: ownerEmail,
      password: "legacy-test-passphrase",
    });
    assert.equal(owner.status, 200);
    const ownerCookie = cookies(owner);
    const impersonated = await request(
      "/admin/impersonate-user",
      { userId: legacyId },
      ownerCookie,
      base,
      true,
    );
    assert.equal(impersonated.status, 200, await impersonated.clone().text());
    const impersonatedCookie = cookies(impersonated, ownerCookie);
    const impersonationSession = await (
      await request("/get-session", undefined, impersonatedCookie)
    ).json();
    assert.equal(impersonationSession.session.impersonatedBy, ownerId);
    assert.equal(impersonationSession.user.id, legacyId);
    const nested = await request(
      "/admin/impersonate-user",
      { userId: signupId },
      impersonatedCookie,
      base,
      true,
    );
    assert.equal(nested.status, 403);
    const impersonatedDelete = await request(
      "/delete-user",
      {},
      impersonatedCookie,
      base,
      true,
    );
    assert.equal(impersonatedDelete.status, 403);
    const restored = await request(
      "/admin/stop-impersonating",
      {},
      impersonatedCookie,
      base,
      true,
    );
    assert.equal(restored.status, 200, await restored.clone().text());
    const audit = await db.query(
      "SELECT action FROM identity_audit WHERE actor_id=$1",
      [ownerId],
    );
    assert.ok(
      audit.rows.some((a) => a.action === "admin.impersonate-user.requested"),
    );
    const deletionRequest = await request("/delete-user", {}, cookies(legacy));
    assert.equal(deletionRequest.status, 200);
    const deletionToken = mailbox
      .at(-1)!
      .text.match(/delete_token=([a-zA-Z0-9]+)/)?.[1];
    assert.ok(deletionToken);
    assert.equal(
      (await db.query("SELECT id FROM identity_user WHERE id=$1", [legacyId]))
        .rowCount,
      1,
    );
    const invalidDeletion = await request(
      "/delete-user",
      { token: "invalid-token" },
      cookies(legacy),
    );
    assert.notEqual(invalidDeletion.status, 200);
    const deleted = await request(
      "/delete-user",
      { token: deletionToken },
      cookies(legacy),
    );
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.equal(
      (await db.query("SELECT id FROM identity_user WHERE id=$1", [legacyId]))
        .rowCount,
      0,
    );
    await request("/delete-user", {}, ownerCookie);
    const ownerDeleteToken = mailbox
      .at(-1)!
      .text.match(/delete_token=([a-zA-Z0-9]+)/)?.[1];
    assert.ok(ownerDeleteToken);
    const ownerDelete = await request(
      "/delete-user",
      { token: ownerDeleteToken },
      ownerCookie,
    );
    assert.equal(ownerDelete.status, 403);
    const signOut = await request("/sign-out", {}, userCookie);
    assert.equal(signOut.status, 200);
    assert.equal(
      await (await request("/get-session", undefined, userCookie)).json(),
      null,
    );
    console.log(
      JSON.stringify(
        {
          signupAndEmailVerification: "passed",
          unverifiedLoginDenied: "passed",
          incorrectOtpDenied: "passed",
          scryptSignIn: "passed",
          legacyBcryptSignIn: "passed",
          sessionRevocation: "passed",
          crossOriginMutationDenied: "passed",
          selfRoleEscalationDenied: "passed",
          nonAdminDenied: "passed",
          auditedImpersonation: "passed",
          nestedImpersonationDenied: "passed",
          returnToAdmin: "passed",
          emailConfirmedDeletion: "passed",
          invalidDeletionTokenDenied: "passed",
          ownerDeletionDenied: "passed",
          impersonatedDeletionDenied: "passed",
        },
        null,
        2,
      ),
    );
  } finally {
    await db.query(
      "DELETE FROM identity_audit WHERE actor_id=ANY($1::text[])",
      [[ownerId, legacyId, signupId].filter(Boolean)],
    );
    await db.query("DELETE FROM identity_user WHERE id=ANY($1::text[])", [
      [ownerId, legacyId, signupId].filter(Boolean),
    ]);
    await db.query(
      "DELETE FROM identity_verification WHERE identifier LIKE $1",
      [`%${tag}%`],
    );
    await db.end();
  }
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
