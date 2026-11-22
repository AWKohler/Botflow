import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { getAuth } from "@/lib/auth/config";
import { NATIVE_CHALLENGE_PATTERN } from "@/lib/auth/native-app";
import { NativeAuthorize } from "./native-authorize";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Sign in to the Botflow app",
  robots: { index: false, follow: false },
};

const STATE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The page the Botflow iOS app opens to sign someone in (see
 * src/lib/auth/native-app.ts). Signed out, it sends them through the normal
 * sign-in or sign-up page and back here. Signed in, it asks them to confirm
 * before the app receives anything: a silent redirect would let any app that
 * opens this URL borrow a browser session without the person noticing.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : "");
  const challenge = one("challenge");
  const state = one("state");
  const device = one("device").replace(/[^\p{L}\p{N} '’._-]/gu, "").trim().slice(0, 60);

  if (!NATIVE_CHALLENGE_PATTERN.test(challenge) || !STATE_PATTERN.test(state)) {
    return (
      <AuthShell>
        <div className="px-4">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">This sign-in link isn’t valid</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">
            Go back to the Botflow app and start signing in again.
          </p>
        </div>
      </AuthShell>
    );
  }

  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) {
    const back = new URLSearchParams({ challenge, state });
    if (device) back.set("device", device);
    const page = one("mode") === "sign-up" ? "/sign-up" : "/sign-in";
    redirect(`${page}?redirect_url=${encodeURIComponent(`/native/authorize?${back.toString()}`)}`);
  }

  return (
    <AuthShell>
      <NativeAuthorize
        challenge={challenge}
        state={state}
        device={device || "your iPhone"}
        name={session.user.name || session.user.email}
        email={session.user.email}
        image={session.user.image ?? null}
        impersonating={Boolean(session.session.impersonatedBy)}
      />
    </AuthShell>
  );
}
