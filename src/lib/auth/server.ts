import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./config";
import { getPaidTier } from "@/lib/billing/entitlements";
import { safeRedirect } from "./policy";
export { identityClient } from "./directory";

export async function auth() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  const userId = session?.user.id ?? null;
  const tier = userId ? await getPaidTier(userId) : "free";
  return {
    userId,
    sessionId: session?.session.id ?? null,
    actor: session?.session.impersonatedBy ?? null,
    has: ({ plan }: { plan: string }) => Boolean(userId && tier === plan),
    redirectToSignIn: (options?: { returnBackUrl?: string }): never =>
      redirect(
        `/sign-in?redirect_url=${encodeURIComponent(safeRedirect(options?.returnBackUrl))}`,
      ),
  };
}
