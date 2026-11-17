"use client";

/**
 * Workspace-header sharing controls: active-collaborator avatar stack +
 * icon-only "Share" button + share-sheet popover, wired to the Phase 3
 * members backend (docs/features/project-sharing-plan.md §3–§4, §7).
 *
 * Hidden entirely unless NEXT_PUBLIC_SHARING_ENABLED. Popovers render through
 * a portal to document.body with fixed positioning computed from the
 * trigger's rect (publish-panel pattern — in-header absolute positioning gets
 * buried by the workspace's stacking contexts).
 *
 * Presence (who is "active" right now) is still a stub: the stack shows
 * OTHER members once presence heartbeats land (plan §6.3); today it shows
 * mock users only under NEXT_PUBLIC_SHARING_UI_MOCK. The share sheet's
 * member list is real.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUser } from "@/components/auth";
import { UserPlus, Mail, Crown, X, Check, Loader2 } from "lucide-react";
import { TextInput } from "@/components/ui/field";
import { Button, buttonClass } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { SHARING_ENABLED } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ActiveCollaborator {
  userId: string;
  name: string;
  imageUrl?: string;
  role: "owner" | "editor";
}

interface Member {
  id: string;
  userId: string | null;
  email: string;
  status: "pending" | "active";
  role: string;
  tokenCapPct: number;
  name: string;
  imageUrl?: string;
}

interface SharingState {
  role: "owner" | "editor";
  editorsCanPush: boolean;
  editorsManageBackend: boolean;
  shareOwnerCredits: boolean;
  shareOwnerOauth: boolean;
  members: Member[];
}

/** Warm ring palette in the sand family — deterministic per user. */
const RING_COLORS = ["#c2703e", "#a98a2f", "#7d8c5c", "#5c7d8c", "#8c5c7d", "#b05252"];

function ringColorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return RING_COLORS[h % RING_COLORS.length];
}

const MOCK_COLLABORATORS: ActiveCollaborator[] = [
  { userId: "mock-1", name: "Maya Lindholm", role: "editor" },
  { userId: "mock-2", name: "Devon Okafor", role: "editor" },
  { userId: "mock-3", name: "Kenji Sato", role: "editor" },
  { userId: "mock-4", name: "Priya Anand", role: "editor" },
  { userId: "mock-5", name: "Lucas Ferreira", role: "editor" },
  { userId: "mock-6", name: "Astrid Bergman", role: "editor" },
];

/** Presence stub (plan §6.3) — real version reads the workspace poll. */
function useActiveCollaborators(projectId: string): ActiveCollaborator[] {
  void projectId;
  return useMemo(
    () => (process.env.NEXT_PUBLIC_SHARING_UI_MOCK === "true" ? MOCK_COLLABORATORS : []),
    [],
  );
}

// ─── Members data layer ──────────────────────────────────────────────────────

function useSharing(projectId: string, open: boolean) {
  const [state, setState] = useState<SharingState | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/members`);
      if (res.ok) setState((await res.json()) as SharingState);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  return { state, loading, failed, reload, setState };
}

// ─── Popover positioning (mirrors publish-panel.tsx) ─────────────────────────

interface AnchoredPosition {
  top: number;
  right: number;
}

function positionFrom(el: HTMLElement | null, gap = 8): AnchoredPosition | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.bottom + gap, right: window.innerWidth - r.right };
}

// ─── Avatar primitives ───────────────────────────────────────────────────────

function AvatarDisc({
  id,
  name,
  imageUrl,
  size = 28,
}: {
  id: string;
  name: string;
  imageUrl?: string;
  size?: number;
}) {
  const ring = ringColorFor(id);
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      className="relative inline-flex shrink-0 rounded-full"
      style={{ width: size, height: size, boxShadow: `0 0 0 1.5px ${ring}` }}
      title={name}
    >
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt={name} className="w-full h-full rounded-full object-cover" />
      ) : (
        <span
          className="w-full h-full rounded-full flex items-center justify-center text-[11px] font-semibold text-white"
          style={{ backgroundColor: ring }}
        >
          {initials}
        </span>
      )}
    </span>
  );
}

// ─── Overflow ("+x") popover ─────────────────────────────────────────────────

function OverflowChip({ hidden }: { hidden: ActiveCollaborator[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<AnchoredPosition | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hold = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setPosition(positionFrom(chipRef.current));
    setOpen(true);
  }, []);
  const release = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }, []);

  return (
    <>
      <button
        ref={chipRef}
        onMouseEnter={hold}
        onMouseLeave={release}
        onClick={() => (open ? setOpen(false) : hold())}
        className="w-7 h-7 -ml-2.5 rounded-full bg-elevated border border-border ring-2 ring-[var(--sand-surface)] text-[11px] font-semibold text-muted flex items-center justify-center hover:bg-soft transition-colors relative z-10"
        aria-label={`${hidden.length} more collaborators`}
      >
        +{hidden.length}
      </button>
      {open &&
        createPortal(
          <div
            onMouseEnter={hold}
            onMouseLeave={release}
            className="fixed z-50 w-56 max-h-64 overflow-y-auto modern-scrollbar rounded-xl border border-border bg-surface shadow-lg p-1.5"
            style={position ? { top: position.top, right: position.right } : { top: 60, right: 16 }}
          >
            {hidden.map((c) => (
              <div key={c.userId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-elevated">
                <AvatarDisc id={c.userId} name={c.name} imageUrl={c.imageUrl} size={24} />
                <span className="text-sm text-fg truncate flex-1">{c.name}</span>
                {c.role === "owner" && <Crown size={12} className="text-muted shrink-0" />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

// ─── Avatar stack (active collaborators, never self) ────────────────────────

const MAX_VISIBLE = 5;

function CollaboratorStack({ collaborators }: { collaborators: ActiveCollaborator[] }) {
  if (collaborators.length === 0) return null;
  const visible = collaborators.slice(0, MAX_VISIBLE);
  const hidden = collaborators.slice(MAX_VISIBLE);
  return (
    <div className="flex items-center pl-2.5" aria-label="Active collaborators">
      {visible.map((c, i) => (
        <span
          key={c.userId}
          className="-ml-2.5 rounded-full ring-2 ring-[var(--sand-surface)] transition-transform hover:-translate-y-0.5 hover:z-20 relative"
          style={{ zIndex: visible.length - i }}
        >
          <AvatarDisc id={c.userId} name={c.name} imageUrl={c.imageUrl} />
        </span>
      ))}
      {hidden.length > 0 && <OverflowChip hidden={hidden} />}
    </div>
  );
}

// ─── Toggle ──────────────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex items-start gap-3 select-none", disabled ? "opacity-60" : "cursor-pointer")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          // appearance-none + border-0 + p-0 strip the UA button chrome that
          // was shifting the knob; inline-flex/items-center centers the knob
          // so its slide is purely the transform below.
          "relative mt-0.5 inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border-0 p-0 appearance-none transition-colors",
          checked ? "bg-accent" : "bg-soft",
        )}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-[16px]" : "translate-x-[2px]",
          )}
        />
      </button>
      <span className="flex-1">
        <span className="block text-sm text-fg">{label}</span>
        {hint && <span className="block text-xs text-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

// ─── Share popover ───────────────────────────────────────────────────────────

function SharePopover({
  projectId,
  anchorRef,
  onClose,
}: {
  projectId: string;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { user } = useUser();
  const { state, failed, reload, setState } = useSharing(projectId, true);
  // The owner's plan decides whether inviting is available at all, so the
  // sheet can offer the upgrade instead of a field that would only error.
  const [tier, setTier] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/usage/credits")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { tier?: string } | null) => {
        if (!cancelled) setTier(d?.tier ?? "free");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const planAllowsSharing = tier === "pro" || tier === "max";
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [position, setPosition] = useState<AnchoredPosition | null>(null);

  const isOwner = state?.role === "owner";

  useEffect(() => {
    setPosition(positionFrom(anchorRef.current));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onResize = () => setPosition(positionFrom(anchorRef.current));
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [anchorRef, onClose]);

  const submitInvite = async () => {
    const value = email.trim();
    if (!value || inviting) return;
    setInviting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (res.ok) {
        toast({ title: "Invited", description: data.message });
        setEmail("");
        void reload();
      } else {
        toast({ title: "Couldn't invite", description: data.error ?? "Something went wrong." });
      }
    } finally {
      setInviting(false);
    }
  };

  // Two-step: clicking the row's X arms confirmation; confirming runs this.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const performRemove = async (m: Member) => {
    // An editor removing their OWN row is leaving; anyone else is the owner
    // revoking a member.
    const selfLeave = !isOwner && m.userId === user?.id;
    setRemovingId(m.id);
    try {
      const res = await fetch(`/api/projects/${projectId}/members/${m.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast({
          title: selfLeave ? "Couldn't leave" : "Couldn't remove",
          description: "Something went wrong.",
        });
        return;
      }
      if (selfLeave) {
        // Push the leaver out immediately — their access is already gone
        // server-side, so keeping them in the workspace would only 404.
        toast({ title: "You left the project", description: "You no longer have access." });
        window.location.assign("/projects");
        return;
      }
      toast({ title: "Access removed", description: m.email });
      setConfirmingId(null);
      void reload();
    } finally {
      setRemovingId(null);
    }
  };

  const patchSettings = async (patch: {
    editorsCanPush?: boolean;
    editorsManageBackend?: boolean;
    shareOwnerCredits?: boolean;
    shareOwnerOauth?: boolean;
  }) => {
    // Optimistic; revert on failure.
    setState((s) => (s ? { ...s, ...patch } : s));
    const res = await fetch(`/api/projects/${projectId}/sharing-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast({ title: "Couldn't save", description: data.error ?? "Something went wrong." });
      void reload();
    }
  };

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 w-[420px] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border bg-bg shadow-xl"
        style={position ? { top: position.top, right: position.right } : { top: 60, right: 16 }}
      >
        {/* Same layout as the Publish popover: title row, divider, body. */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-fg">Share project</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-muted transition-colors hover:bg-elevated hover:text-fg">
            <X size={14} />
          </button>
        </div>
        <div className="p-4">
        <p className="mb-4 text-[13px] leading-relaxed text-muted">
          Invite collaborators by email. They can prompt their own agents in this workspace.
        </p>

        {isOwner && tier !== null && !planAllowsSharing ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
            <p className="text-[13px] leading-snug text-fg">Sharing is part of the Pro and Max plans.</p>
            <a href="/pricing" target="_blank" rel="noopener noreferrer" className={buttonClass({ variant: "primary", size: "sm", className: "shrink-0" })}>
              Compare plans
            </a>
          </div>
        ) : (
          (isOwner || !state) && (
            <div className="flex items-center gap-2 mb-4">
              <div className="flex-1 relative">
                <Mail size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
                <TextInput
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submitInvite()}
                  placeholder="teammate@example.com"
                  aria-label="Invite by email"
                  disabled={!state}
                  className="h-8 pl-8 text-[13px]"
                />
              </div>
              <Button
                variant={email.trim() ? "primary" : "secondary"}
                size="sm"
                disabled={!state || inviting || !email.trim()}
                onClick={() => void submitInvite()}
              >
                {inviting ? <Loader2 size={14} className="animate-spin" /> : "Invite"}
              </Button>
            </div>
          )
        )}

        <div className="space-y-1 mb-4">
          <div className="mb-1.5 text-[11px] font-medium text-muted">
            People with access
          </div>
          {!state && failed && (
            <div className="flex items-center justify-between gap-3 px-1 py-1.5">
              <p className="text-[13px] text-muted">Couldn&apos;t load who has access.</p>
              <Button variant="secondary" size="xs" onClick={() => void reload()}>
                Try again
              </Button>
            </div>
          )}
          {/* Placeholder rows while the list loads — never a made-up person. */}
          {!state && !failed &&
            [0, 1].map((i) => (
              <div key={i} className="flex items-center gap-2.5 px-1 py-1" aria-hidden={i > 0} aria-busy="true" aria-label={i === 0 ? "Loading people" : undefined}>
                <span className="size-[26px] shrink-0 animate-pulse rounded-full bg-soft" />
                <span className={cn("h-3 animate-pulse rounded bg-soft", i === 0 ? "w-36" : "w-28")} />
              </div>
            ))}
          {/* Owner row. */}
          {state && (
            <div className="flex items-center gap-2.5 px-1 py-1">
              <AvatarDisc
                id={user?.id ?? "owner"}
                name={isOwner ? (user?.fullName ?? "You") : "Project owner"}
                imageUrl={isOwner ? user?.imageUrl : undefined}
                size={26}
              />
              <span className="text-sm text-fg truncate flex-1">
                {isOwner ? (user?.fullName ?? "You") : "Project owner"}
              </span>
              <span className="text-[11px] font-medium text-muted border border-border rounded-full px-2 py-0.5 flex items-center gap-1">
                <Crown size={10} /> Owner
              </span>
            </div>
          )}
          {state?.members.map((m) => (
            <div key={m.id} className="flex items-center gap-2.5 px-1 py-1 group">
              <AvatarDisc id={m.userId ?? m.email} name={m.name} imageUrl={m.imageUrl} size={26} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-fg truncate">{m.name}</span>
                {m.name !== m.email && <span className="block text-[11px] text-muted truncate">{m.email}</span>}
              </span>
              <span
                className={cn(
                  "text-[11px] font-medium rounded-full px-2 py-0.5 border",
                  m.status === "pending" ? "text-warning border-warning-border bg-warning-soft" : "text-muted border-border",
                )}
              >
                {m.status === "pending" ? "Invited" : "Editor"}
              </span>
              {(isOwner || m.userId === user?.id) && (
                (() => {
                  const selfLeave = !isOwner && m.userId === user?.id;
                  if (confirmingId === m.id) {
                    return (
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[11px] text-muted">
                          {selfLeave ? "Leave?" : "Remove?"}
                        </span>
                        <button
                          onClick={() => setConfirmingId(null)}
                          disabled={removingId === m.id}
                          className="text-muted hover:text-fg p-0.5"
                          title="Cancel"
                          aria-label="Cancel"
                        >
                          <X size={13} />
                        </button>
                        <button
                          onClick={() => void performRemove(m)}
                          disabled={removingId === m.id}
                          className="text-danger hover:text-danger p-0.5"
                          title={selfLeave ? "Confirm leave" : "Confirm remove"}
                          aria-label={selfLeave ? "Confirm leave" : "Confirm remove"}
                        >
                          {removingId === m.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                        </button>
                      </span>
                    );
                  }
                  return (
                    <button
                      onClick={() => setConfirmingId(m.id)}
                      className="text-muted hover:text-danger p-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      title={selfLeave ? "Leave project" : "Remove access"}
                      aria-label={selfLeave ? "Leave project" : "Remove access"}
                    >
                      <X size={13} />
                    </button>
                  );
                })()
              )}
            </div>
          ))}
          {state && state.members.length === 0 && (
            <p className="text-xs text-muted px-1 py-1">
              {isOwner ? "Only you so far." : "No other collaborators yet."}
            </p>
          )}
        </div>

        {isOwner && state && (
          <div className="border-t border-border pt-3 space-y-3">
            <Toggle
              checked={state.editorsCanPush}
              onChange={(v) => void patchSettings({ editorsCanPush: v })}
              label="Editors can push to GitHub"
              hint="Commits and pushes go to your linked repository, attributed to the editor."
            />
            <Toggle
              checked={state.editorsManageBackend}
              onChange={(v) => void patchSettings({ editorsManageBackend: v })}
              label="Editors can manage the backend"
              hint="Lets editors open the database dashboard and edit backend env vars (which include deployment secrets)."
            />
            <Toggle
              checked={state.shareOwnerCredits}
              onChange={(v) =>
                void patchSettings({ shareOwnerCredits: v, ...(v ? {} : { shareOwnerOauth: false }) })
              }
              label="Collaborators use my credits"
              hint="Their agent turns bill your plan's credits (capped per collaborator), and they get access to your plan's models."
            />
            {state.shareOwnerCredits && (
              <Toggle
                checked={state.shareOwnerOauth}
                onChange={(v) => void patchSettings({ shareOwnerOauth: v })}
                label="Share my Claude/Codex & API-key usage"
                hint="Their turns can run through your connected accounts via Botflow's proxy — they never see the keys."
              />
            )}
          </div>
        )}


        </div>
      </div>
    </>,
    document.body,
  );
}

// ─── Public component ────────────────────────────────────────────────────────

export function ShareControls({ projectId }: { projectId: string }) {
  const collaborators = useActiveCollaborators(projectId);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!SHARING_ENABLED) return null;

  return (
    <div className="flex items-center gap-2">
      <CollaboratorStack collaborators={collaborators} />
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "tap-44 flex h-8 w-8 items-center justify-center rounded-lg border border-border shadow-xs transition-colors",
          open ? "bg-elevated text-fg" : "bg-bg text-muted hover:border-border-strong hover:text-fg",
        )}
        title="Share this project"
        aria-label="Share project"
      >
        <UserPlus size={15} />
      </button>
      {open && <SharePopover projectId={projectId} anchorRef={triggerRef} onClose={() => setOpen(false)} />}
    </div>
  );
}
