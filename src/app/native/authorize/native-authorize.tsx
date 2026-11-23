"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";

const APP_CALLBACK = "botflow://auth";

interface Props {
  challenge: string;
  state: string;
  device: string;
  name: string;
  email: string;
  image: string | null;
  impersonating: boolean;
}

export function NativeAuthorize({ challenge, state, device, name, email, image, impersonating }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const returnToApp = (params: Record<string, string>) => {
    window.location.href = `${APP_CALLBACK}?${new URLSearchParams({ ...params, state }).toString()}`;
  };

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/native/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge }),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      if (!res.ok || !body.code) throw new Error(body.message || "Could not sign in. Try again.");
      returnToApp({ code: body.code });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in. Try again.");
      setBusy(false);
    }
  }

  async function switchAccount() {
    setBusy(true);
    await authClient.signOut().catch(() => {});
    const back = new URLSearchParams({ challenge, state, device });
    window.location.href = `/sign-in?redirect_url=${encodeURIComponent(`/native/authorize?${back.toString()}`)}`;
  }

  const initials = name.replace(/@.*/, "").slice(0, 2).toUpperCase();

  return (
    <div className="px-4">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Sign in to the Botflow app</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">
        The Botflow app on {device} will be signed in to this account.
      </p>

      <div className="mt-6 flex items-center gap-3 rounded-xl border border-border bg-surface p-4">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="h-11 w-11 rounded-full border border-border object-cover" />
        ) : (
          <div className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-elevated text-sm font-semibold text-fg">
            {initials}
          </div>
        )}
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium text-fg">{name}</div>
          {email !== name && <div className="truncate text-sm text-subtle">{email}</div>}
        </div>
      </div>

      {impersonating ? (
        <p role="alert" className="mt-4 rounded-lg border border-warning-border bg-warning-soft p-3 text-sm text-warning">
          You are impersonating this account. Stop impersonating before signing in to the app.
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-danger-border bg-danger-soft p-3 text-sm text-danger">
              {error}
            </p>
          )}
          <Button size="lg" className="mt-6 w-full" onClick={approve} disabled={busy} data-testid="native-authorize-continue">
            {busy ? "Signing in…" : `Continue as ${name.split(" ")[0] || name}`}
          </Button>
        </>
      )}
      <Button variant="ghost" className="mt-2 w-full" onClick={switchAccount} disabled={busy}>
        Use a different account
      </Button>
      <button
        type="button"
        className="mt-1 w-full rounded-md py-2 text-sm text-subtle underline-offset-4 hover:underline"
        onClick={() => returnToApp({ error: "access_denied" })}
      >
        Cancel
      </button>
    </div>
  );
}
