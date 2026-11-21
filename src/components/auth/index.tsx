"use client";
import Image from "next/image";
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth/client";
import { safeRedirect } from "@/lib/auth/policy";
import { AuthForm } from "./sign-in";
import Link from "next/link";
import { LogOut, Settings2, X } from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { Menu, MenuItem, MenuSeparator, menuItemClass } from "@/components/ui/menu";
import { phoneNativeDialogClass } from "@/components/ui/dialog";
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
          className="fixed top-0 inset-x-0 z-[100] flex justify-center gap-4 bg-warning-soft p-2 text-sm text-amber-950"
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
          className={`fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-border bg-bg p-0 text-fg shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-[2px] ${phoneNativeDialogClass}`}
        >
          <button
            autoFocus
            aria-label="Close sign in"
            className={buttonClass({ variant: "ghost", size: "icon-sm", className: "absolute right-3 top-3 z-10" })}
            onClick={() => dialogRef.current?.close()}
          >
            <X className="h-4 w-4" />
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
  const rootRef = useRef<HTMLDivElement>(null);
  // Close on a press anywhere else, or Escape. (A full-screen catcher element
  // would not work here: inside the blurred header, `fixed` only covers the header.)
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  if (!user) return null;
  return (
    <div ref={rootRef} className="relative text-fg">
      <button
        aria-label="Open user menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-border bg-elevated text-[13px] font-medium uppercase text-fg transition-colors hover:border-border-strong pointer-coarse:h-10 pointer-coarse:w-10"
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
          <Menu className="absolute right-0 top-full z-50 mt-2 w-64">
            <div className="px-2.5 pb-2 pt-1.5 pointer-coarse:px-3">
              <p className="truncate text-[13px] font-medium text-fg pointer-coarse:text-[15px]">{user.fullName}</p>
              <p className="truncate text-xs text-muted pointer-coarse:text-[13px]">
                {user.primaryEmailAddress?.emailAddress}
              </p>
            </div>
            <MenuSeparator />
            {/* One destination for everything about the account. */}
            <Link href="/account" role="menuitem" className={menuItemClass} onClick={() => setOpen(false)}>
              <Settings2 className="h-4 w-4 text-muted" strokeWidth={1.75} />
              Settings
            </Link>
            <MenuItem
              onClick={async () => {
                const result = await authClient.signOut();
                if (!result.error) location.assign("/");
              }}
            >
              <LogOut className="h-4 w-4 text-muted" strokeWidth={1.75} />
              Sign out
            </MenuItem>
          </Menu>
        </>
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
