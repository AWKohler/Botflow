import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { createIdentityAuth } from "./config";
import { getIdentityDb } from "./database";
import { requireSameOrigin } from "./policy";
import { sendAuthEmail } from "./email";

const input = z.object({
  action: z.enum(["request", "verify", "primary", "remove"]),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  otp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
function digest(userId: string, email: string, otp: string) {
  if (!process.env.BETTER_AUTH_SECRET)
    throw new Error("Authentication is not configured");
  return createHmac("sha256", process.env.BETTER_AUTH_SECRET)
    .update(JSON.stringify([userId, email, otp]))
    .digest("hex");
}
export async function handleIdentityEmails(
  request: Request,
  identity: ReturnType<typeof createIdentityAuth>,
  deliver = sendAuthEmail,
) {
  const session = await identity.api.getSession({ headers: request.headers });
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getIdentityDb();
  if (request.method === "GET") {
    const { rows } = await db.query(
      "SELECT e.email,e.verified,(e.email=lower(u.email)) AS primary FROM identity_email e JOIN identity_user u ON u.id=e.user_id WHERE e.user_id=$1 ORDER BY (e.email=lower(u.email)) DESC,e.created_at",
      [session.user.id],
    );
    return NextResponse.json({ emails: rows });
  }
  if (!requireSameOrigin(request) || session.session.impersonatedBy)
    return NextResponse.json(
      { error: "Account security changes are unavailable" },
      { status: 403 },
    );
  if (
    Date.now() - new Date(session.session.createdAt).getTime() >
    15 * 60 * 1000
  )
    return NextResponse.json(
      {
        error:
          "Please sign out and sign in again before changing your email addresses.",
      },
      { status: 403 },
    );
  if (!session.user.emailVerified)
    return NextResponse.json(
      { error: "Verify your primary email first." },
      { status: 403 },
    );
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid email request" },
      { status: 400 },
    );
  const { action, email, otp } = parsed.data;
  const userId = session.user.id;
  const connection = await db.connect();
  let verification: { code: string; digest: string } | undefined;
  let result = { status: 200, message: "Saved" };
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `identity-emails:${userId}`,
    ]);
    const {
      rows: [user],
    } = await connection.query(
      "SELECT email FROM identity_user WHERE id=$1 FOR UPDATE",
      [userId],
    );
    const {
      rows: [address],
    } = await connection.query("SELECT * FROM identity_email WHERE email=$1", [
      email,
    ]);
    if (action === "request") {
      if (address)
        result = {
          status: 409,
          message: "That email address is already assigned.",
        };
      else {
        const {
          rows: [limit],
        } = await connection.query(
          `INSERT INTO identity_rate_limit(id,key,count,"lastRequest") VALUES($1,$1,1,$2)
           ON CONFLICT(key) DO UPDATE SET count=CASE WHEN identity_rate_limit."lastRequest"<$3 THEN 1 ELSE identity_rate_limit.count+1 END,"lastRequest"=$2
           WHERE identity_rate_limit."lastRequest"<$3 OR identity_rate_limit.count<10 RETURNING count`,
          [`alias-email:${userId}`, Date.now(), Date.now() - 60 * 60 * 1000],
        );
        const recent = await connection.query(
          "SELECT 1 FROM identity_email_challenge WHERE user_id=$1 AND sent_at>now()-interval '1 minute'",
          [userId],
        );
        const count = await connection.query(
          "SELECT count(*)::int AS count FROM identity_email WHERE user_id=$1",
          [userId],
        );
        if (!limit || recent.rowCount)
          result = {
            status: 429,
            message: "Please wait before requesting another code.",
          };
        else if (count.rows[0].count >= 5)
          result = {
            status: 400,
            message: "You can keep up to five email addresses.",
          };
        else {
          const code = randomInt(0, 1000000).toString().padStart(6, "0");
          verification = { code, digest: digest(userId, email, code) };
          await connection.query(
            `INSERT INTO identity_email_challenge(user_id,email,digest,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')
             ON CONFLICT(user_id,email) DO UPDATE SET digest=$3,attempts=0,expires_at=now()+interval '10 minutes',sent_at=now()`,
            [userId, email, verification.digest],
          );
        }
      }
    } else if (action === "verify") {
      const {
        rows: [challenge],
      } = await connection.query(
        "SELECT * FROM identity_email_challenge WHERE user_id=$1 AND email=$2 FOR UPDATE",
        [userId, email],
      );
      const count = await connection.query(
        "SELECT count(*)::int AS count FROM identity_email WHERE user_id=$1",
        [userId],
      );
      if (
        !otp ||
        !challenge ||
        challenge.attempts >= 5 ||
        new Date(challenge.expires_at).getTime() <= Date.now()
      )
        result = {
          status: 400,
          message: "The code has expired. Request a new code.",
        };
      else if (
        !timingSafeEqual(
          Buffer.from(challenge.digest, "hex"),
          Buffer.from(digest(userId, email, otp), "hex"),
        )
      ) {
        await connection.query(
          "UPDATE identity_email_challenge SET attempts=attempts+1 WHERE user_id=$1 AND email=$2",
          [userId, email],
        );
        result = { status: 400, message: "Incorrect verification code." };
      } else if (count.rows[0].count >= 5)
        result = {
          status: 400,
          message: "You can keep up to five email addresses.",
        };
      else {
        await connection.query(
          "INSERT INTO identity_email(email,user_id,verified) VALUES($1,$2,true)",
          [email, userId],
        );
        await connection.query(
          "DELETE FROM identity_email_challenge WHERE user_id=$1 AND email=$2",
          [userId, email],
        );
      }
    } else if (
      address?.user_id !== userId ||
      (action === "primary" && !address.verified)
    )
      result = {
        status: 400,
        message: "Choose a verified email on your account.",
      };
    else if (action === "primary") {
      await connection.query(
        'UPDATE identity_user SET email=$2,"emailVerified"=true,"updatedAt"=now() WHERE id=$1',
        [userId, email],
      );
    } else if (user.email.toLowerCase() === email)
      result = {
        status: 400,
        message: "Choose another primary email before removing this address.",
      };
    else
      await connection.query(
        "DELETE FROM identity_email WHERE email=$1 AND user_id=$2",
        [email, userId],
      );
    if (result.status === 200 && action !== "request") {
      await connection.query(
        "INSERT INTO identity_audit(actor_id,target_id,action) VALUES($1,$1,$2)",
        [userId, `account.email.${action}`],
      );
    }
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    // Unique constraints serialize alias verification against signup/OAuth/email changes.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    )
      result = {
        status: 409,
        message: "That email address is already assigned.",
      };
    else {
      console.error("Unable to update identity email addresses");
      result = { status: 500, message: "Unable to update email addresses." };
    }
  } finally {
    connection.release();
  }
  if (verification && result.status === 200) {
    try {
      await deliver(
        email,
        "Verify your Botflow email address",
        `Your verification code is ${verification.code}. It expires in 10 minutes. If you did not request this email, ignore it.`,
      );
    } catch {
      await db.query(
        "DELETE FROM identity_email_challenge WHERE user_id=$1 AND email=$2 AND digest=$3",
        [userId, email, verification.digest],
      );
      return NextResponse.json(
        {
          error: "Unable to deliver the verification email. Please try again.",
        },
        { status: 502 },
      );
    }
  }
  return NextResponse.json(
    result.status === 200 ? { success: true } : { error: result.message },
    { status: result.status },
  );
}
