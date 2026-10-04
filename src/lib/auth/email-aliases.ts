import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { getIdentityDb } from "./database";
/** Verified aliases use the same identity for password, OTP, recovery and OAuth. */
export function emailAliases(): BetterAuthPlugin {
  return {
    id: "botflow-email-aliases",
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (context) => {
            const adapter = context.context.internalAdapter;
            const findPrimary = adapter.findUserByEmail;
            return {
              context: {
                context: {
                  internalAdapter: {
                    ...adapter,
                    async findUserByEmail(
                      email: string,
                      options?: { includeAccounts: boolean },
                    ) {
                      const primary = await findPrimary(email, options);
                      if (primary) return primary;
                      const { rows } = await getIdentityDb().query<{
                        email: string;
                      }>(
                        'SELECT u.email FROM identity_email e JOIN identity_user u ON u.id=e.user_id WHERE e.email=lower($1) AND e.verified=true AND u."emailVerified"=true',
                        [email],
                      );
                      return rows[0]
                        ? findPrimary(rows[0].email, options)
                        : null;
                    },
                  },
                },
              },
            };
          }),
        },
      ],
    },
  };
}
