"use client";
import Image from "next/image";
import React, { createContext, useContext, useEffect, useState } from "react";
import { authClient } from "@/lib/auth/client";
import { safeRedirect } from "@/lib/auth/policy";
import { AuthForm } from "./sign-in";
import { AccountPanel } from "./account";
export { PricingTable } from "./pricing-table";

interface User {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  imageUrl: string;
  publicMetadata: Record<string, unknown>;
  primaryEmailAddress?: { emailAddress: string };
}
const UserContext = createContext<{
  user: User | null;
  isLoaded: boolean;
  isSignedIn: boolean;
}>({ user: null, isLoaded: false, isSignedIn: false });
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const session = authClient.useSession();
  const [profile, setProfile] = useState<User | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setProfile(null);
    if (session.data?.user.id)
      fetch("/api/identity/me", { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.user)
            setProfile({
              ...data.user,
              fullName: [data.user.firstName, data.user.lastName]
                .filter(Boolean)
                .join(" "),
            });
        })
        .catch(() => {});
    return () => controller.abort();
  }, [session.data?.user.id]);
  const user = session.data?.user
    ? profile?.id === session.data.user.id
      ? profile
      : {
          id: session.data.user.id,
          firstName: session.data.user.name.split(" ")[0],
          lastName: null,
          fullName: session.data.user.name,
          imageUrl: session.data.user.image ?? "",
          publicMetadata: {},
          primaryEmailAddress: { emailAddress: session.data.user.email },
        }
    : null;
  return (
    <UserContext.Provider
      value={{ user, isLoaded: !session.isPending, isSignedIn: !!session.data }}
    >
      {session.data?.session.impersonatedBy && (
        <div
          role="status"
          className="fixed top-0 inset-x-0 z-[100] flex justify-center gap-4 bg-amber-100 p-2 text-sm text-amber-950"
        >
          Viewing Botflow as {session.data.user.email}
          <button
            className="underline"
            onClick={async () => {
              const result = await authClient.admin.stopImpersonating();
              if (!result.error) location.assign("/panel/users");
            }}
          >
            Return to admin
          </button>
        </div>
      )}
      {children}
    </UserContext.Provider>
  );
}
export function useUser() {
  return useContext(UserContext);
}
export function SignedIn({ children }: { children: React.ReactNode }) {
  const { isSignedIn } = useUser();
  return isSignedIn ? children : null;
}
export function SignedOut({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useUser();
  return isLoaded && !isSignedIn ? children : null;
}
interface SignInButtonProps {
  appearance?: unknown;
  children?: React.ReactNode;
  mode?: string;
  forceRedirectUrl?: string;
  fallbackRedirectUrl?: string;
}
export function SignInButton({
  children,
  mode,
  forceRedirectUrl,
  fallbackRedirectUrl,
}: SignInButtonProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialogRef.current?.showModal();
  }, [open]);
  function go() {
    if (mode === "modal") {
      setOpen(true);
      return;
    }
    location.assign(
      `/sign-in?redirect_url=${encodeURIComponent(safeRedirect(forceRedirectUrl ?? fallbackRedirectUrl ?? location.pathname + location.search))}`,
    );
  }
  const trigger = React.isValidElement<{ onClick?: () => void }>(children) ? (
    React.cloneElement(children, { onClick: go })
  ) : (
    <button onClick={go}>{children ?? "Sign in"}</button>
  );
  return (
    <>
      {trigger}
      {open && (
        <dialog
          ref={dialogRef}
          onClose={() => setOpen(false)}
          className="fixed inset-0 m-auto max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--sand-border)] bg-[var(--color-surface)] p-0 text-[var(--sand-text)] shadow-xl backdrop:bg-black/40"
        >
          <button
            autoFocus
            aria-label="Close sign in"
            className="absolute right-4 top-3 z-10 text-xl"
            onClick={() => dialogRef.current?.close()}
          >
            ×
          </button>
          <AuthForm
            redirectUrl={
              forceRedirectUrl ??
              fallbackRedirectUrl ??
              (typeof location !== "undefined"
                ? location.pathname + location.search
                : "/")
            }
          />
        </dialog>
      )}
    </>
  );
}
export function UserButton(_props: {
  appearance?: unknown;
  afterSignOutUrl?: string;
  userProfileMode?: string;
  userProfileUrl?: string;
}) {
  void _props;
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [accountTab, setAccountTab] = useState<string | null>(null);
  const accountDialog = React.useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (accountTab) accountDialog.current?.showModal();
  }, [accountTab]);
  if (!user) return null;
  return (
    <div className="relative text-[var(--sand-text)]">
      <button
        aria-label="Open user menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-[var(--sand-elevated)] text-sm"
      >
        {user.imageUrl ? (
          <Image
            unoptimized
            width={32}
            height={32}
            src={user.imageUrl}
            alt="User avatar"
            className="h-full w-full object-cover"
          />
        ) : (
          (user.fullName?.[0] ?? "U")
        )}
      </button>
      {open && (
        <>
          <button
            aria-label="Close user menu"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-0 top-11 z-50 w-72 rounded-xl border border-[var(--sand-border)] bg-[var(--color-surface)] p-2 shadow-xl"
          >
            <div className="border-b border-[var(--sand-border)] p-3">
              <p className="font-medium">{user.fullName}</p>
              <p className="text-sm text-[var(--sand-text-muted)]">
                {user.primaryEmailAddress?.emailAddress}
              </p>
            </div>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setAccountTab("profile");
              }}
              className="block rounded-lg p-3 text-sm hover:bg-[var(--sand-elevated)]"
            >
              Manage account
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setAccountTab("billing");
              }}
              className="block rounded-lg p-3 text-sm hover:bg-[var(--sand-elevated)]"
            >
              Billing
            </button>
            <button
              role="menuitem"
              className="w-full rounded-lg p-3 text-left text-sm hover:bg-[var(--sand-elevated)]"
              onClick={async () => {
                const result = await authClient.signOut();
                if (!result.error) location.assign("/");
              }}
            >
              Sign out
            </button>
          </div>
        </>
      )}
      {accountTab && (
        <dialog
          ref={accountDialog}
          onClose={() => setAccountTab(null)}
          className="fixed inset-0 m-auto max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-xl border-none bg-[var(--color-surface)] p-0 backdrop:bg-black/40"
        >
          <button
            aria-label="Close account"
            className="absolute right-4 top-3 z-10 text-xl"
            onClick={() => accountDialog.current?.close()}
          >
            ×
          </button>
          <AccountPanel embedded initialTab={accountTab} />
        </dialog>
      )}
    </div>
  );
}
interface AuthProps {
  forceRedirectUrl?: string;
  routing?: string;
  appearance?: unknown;
}
export function SignIn(props: AuthProps) {
  return <AuthForm redirectUrl={props.forceRedirectUrl} />;
}
export function SignUp(props: AuthProps) {
  return <AuthForm signUp redirectUrl={props.forceRedirectUrl} />;
}
