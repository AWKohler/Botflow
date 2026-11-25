import { prepareAccountDeletion } from "./delete-account";
import { identityBaseURL } from "./base-url";
import { betterAuth } from "better-auth";
import { google } from "better-auth/social-providers";
import { decryptOAuthToken } from "better-auth/oauth2";
import { admin, emailOTP, username } from "better-auth/plugins";
import { getIdentityDb } from "./database";
import { password } from "./password";
import { ownerIds } from "./policy";
import { encryptPrivateData } from "./crypto";
import { sendAuthEmail } from "./email";
import { emailAliases } from "./email-aliases";
import { captchaPlugin } from "./captcha";
import { nativeApp } from "./native-app";
import {
  APPLE_ISSUER,
  appleAudiences,
  appleClientSecret,
  appleConfig,
  revokeAppleTokens,
} from "./apple";
import { gateNewUser, isGateBannedUser } from "./username-gate";

export function createIdentityAuth(
  deliver: typeof sendAuthEmail = sendAuthEmail,
) {
  if (!process.env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET and BETTER_AUTH_URL are required");
  }
  const apple = appleConfig();
  const auth = betterAuth({
    appName: "Botflow",
    baseURL: identityBaseURL(),
    secret: process.env.BETTER_AUTH_SECRET,
    database: getIdentityDb(),
    // Apple returns from its sign-in page with a cross-site form POST.
    trustedOrigins: [identityBaseURL(), ...(apple ? [APPLE_ISSUER] : [])],
    databaseHooks: {
      user: {
        create: {
          // USERNAME_GATE_ENABLED: machine-generated usernames are created
          // already banned, and sendVerificationOTP below never mails them.
          before: async (user) => gateNewUser(user),
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
        beforeDelete: async (user) => {
          await prepareAccountDeletion(user);
          // Apple requires apps to revoke Sign in with Apple on account deletion.
          if (apple) {
            const ctx = (await auth.$context) as unknown as Parameters<typeof decryptOAuthToken>[1];
            const accounts = await ctx.internalAdapter.findAccounts(user.id);
            await revokeAppleTokens(
              await Promise.all(
                accounts
                  .filter((a) => a.providerId === "apple")
                  .map(async (a) => ({
                    idToken: a.idToken,
                    refreshToken: await decryptOAuthToken(a.refreshToken ?? "", ctx),
                    accessToken: await decryptOAuthToken(a.accessToken ?? "", ctx),
                  })),
              ),
            ).catch((error) => console.error("Apple token revocation failed", error));
          }
        },
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
      accountLinking: {
        enabled: true,
        trustedProviders: ["google", "github"],
        allowDifferentEmails: true,
      },
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
      ...(apple
        ? {
            apple: {
              // The web redirect flow needs a Services ID; without one only the
              // iOS app's native button (identity tokens for the bundle ID) works.
              clientId: apple.serviceId ?? apple.bundleId,
              get clientSecret() {
                return appleClientSecret(apple, apple.serviceId ?? apple.bundleId);
              },
              audience: appleAudiences(apple),
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
      captchaPlugin(),
      nativeApp(),
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
        async sendVerificationOTP({ email, otp, type }, ctx) {
          // Silently drop codes for accounts banned by the username gate.
          // The sign-up OTP is sent before the user row commits, so look the
          // user up through ctx's adapter (same transaction), not the pool.
          const found = await ctx?.context.internalAdapter.findUserByEmail(email);
          if (isGateBannedUser(found?.user as Parameters<typeof isGateBannedUser>[0]))
            return;
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
  return auth;
}
let instance: ReturnType<typeof createIdentityAuth> | undefined;
export function getAuth() {
  return (instance ??= createIdentityAuth());
}
