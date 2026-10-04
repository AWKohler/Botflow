import { prepareAccountDeletion } from "./delete-account";
import { identityBaseURL } from "./base-url";
import { betterAuth } from "better-auth";
import { google } from "better-auth/social-providers";
import { admin, emailOTP, username } from "better-auth/plugins";
import { getIdentityDb } from "./database";
import { password } from "./password";
import { ownerIds } from "./policy";
import { encryptPrivateData } from "./crypto";
import { sendAuthEmail } from "./email";
import { emailAliases } from "./email-aliases";

export function createIdentityAuth(
  deliver: typeof sendAuthEmail = sendAuthEmail,
) {
  if (!process.env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET and BETTER_AUTH_URL are required");
  }
  return betterAuth({
    appName: "Botflow",
    baseURL: identityBaseURL(),
    secret: process.env.BETTER_AUTH_SECRET,
    database: getIdentityDb(),
    trustedOrigins: [identityBaseURL()],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await getIdentityDb().query(
              "INSERT INTO identity_profile(user_id,private_metadata_encrypted) VALUES($1,$2) ON CONFLICT DO NOTHING",
              [user.id, encryptPrivateData({}, `profile:${user.id}`)],
            );
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            if (
              process.env.AUTH_PREVIEW_OWNER_ONLY === "true" &&
              !ownerIds().includes(session.userId)
            )
              return false;
            return { data: session };
          },
          after: async (session) => {
            if (!("impersonatedBy" in session && session.impersonatedBy))
              await getIdentityDb().query(
                "UPDATE identity_profile SET last_sign_in_at=now() WHERE user_id=$1",
                [session.userId],
              );
          },
        },
      },
    },
    user: {
      modelName: "identity_user",
      changeEmail: { enabled: true },
      deleteUser: {
        enabled: true,
        deleteTokenExpiresIn: 600,
        sendDeleteAccountVerification: async ({ user, token }) =>
          deliver(
            user.email,
            "Confirm deletion of your Botflow account",
            `Confirm account deletion: ${identityBaseURL()}/account?delete_token=${encodeURIComponent(token)} . This link expires in 10 minutes. Your login, profile, and stored integration secrets will be removed, your subscriptions will be canceled, and your projects will no longer be accessible through this account. Ignore this email if you did not request deletion.`,
          ),
        beforeDelete: prepareAccountDeletion,
      },
    },
    session: {
      modelName: "identity_session",
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 15,
    },
    account: {
      modelName: "identity_account",
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, trustedProviders: ["google", "github"] },
    },
    verification: { modelName: "identity_verification" },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      password,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) =>
        deliver(
          user.email,
          "Reset your Botflow password",
          `Reset your password: ${url}`,
        ),
    },
    socialProviders: {
      ...(process.env.AUTH_GOOGLE_CLIENT_ID &&
      process.env.AUTH_GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.AUTH_GOOGLE_CLIENT_ID,
              clientSecret: process.env.AUTH_GOOGLE_CLIENT_SECRET,
              async getUserInfo(tokens) {
                const info = await google({
                  clientId: process.env.AUTH_GOOGLE_CLIENT_ID!,
                  clientSecret: process.env.AUTH_GOOGLE_CLIENT_SECRET!,
                }).getUserInfo(tokens);
                // Match the existing Clerk Google connection's subaddress rule.
                if (info?.user.email && /[+=#]/.test(info.user.email))
                  return null;
                return info;
              },
            },
          }
        : {}),
      ...(process.env.AUTH_GITHUB_CLIENT_ID &&
      process.env.AUTH_GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: process.env.AUTH_GITHUB_CLIENT_ID,
              clientSecret: process.env.AUTH_GITHUB_CLIENT_SECRET,
              prompt: "select_account",
            },
          }
        : {}),
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "identity_rate_limit",
      window: 60,
      max: 30,
    },
    plugins: [
      emailAliases(),
      username(),
      admin({
        adminUserIds: ownerIds(),
        impersonationSessionDuration: 60 * 15,
      }),
      emailOTP({
        changeEmail: { enabled: true },
        storeOTP: "hashed",
        expiresIn: 600,
        allowedAttempts: 5,
        sendVerificationOnSignUp: true,
        overrideDefaultEmailVerification: true,
        async sendVerificationOTP({ email, otp, type }) {
          await deliver(
            email,
            type === "forget-password"
              ? "Reset your Botflow password"
              : "Your Botflow verification code",
            `Your verification code is ${otp}. It expires in 10 minutes. If you did not request it, ignore this email.`,
          );
        },
      }),
    ],
  });
}
let instance: ReturnType<typeof createIdentityAuth> | undefined;
export function getAuth() {
  return (instance ??= createIdentityAuth());
}
