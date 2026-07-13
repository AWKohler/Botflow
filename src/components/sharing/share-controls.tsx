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
import { useUser } from "@clerk/nextjs";
import { UserPlus, Mail, Crown, X, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/members`);
      if (res.ok) setState((await res.json()) as SharingState);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  return { state, loading, reload, setState };
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
          className="w-full h-full rounded-full flex items-center justify-center text-[10px] font-semibold text-white"
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
        className="w-7 h-7 -ml-2.5 rounded-full bg-elevated border border-border ring-2 ring-[var(--sand-surface)] text-[10px] font-semibold text-muted flex items-center justify-center hover:bg-soft transition-colors relative z-10"
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
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 w-8 h-[18px] rounded-full transition-colors shrink-0",
          checked ? "bg-accent" : "bg-soft",
        )}
      >
        <span
          className={cn(
            "absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform",
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
  const { state, loading, reload, setState } = useSharing(projectId, true);
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

  const revoke = async (m: Member) => {
    const res = await fetch(`/api/projects/${projectId}/members/${m.id}`, { method: "DELETE" });
    if (res.ok) {
      toast({ title: "Access removed", description: m.email });
      void reload();
    } else {
      toast({ title: "Couldn't remove", description: "Something went wrong." });
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
        className="fixed z-50 w-[380px] max-w-[calc(100vw-1rem)] rounded-2xl border border-border bg-surface shadow-xl p-4"
        style={position ? { top: position.top, right: position.right } : { top: 60, right: 16 }}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-fg">Share project</h3>
            <p className="text-xs text-muted mt-0.5">
              Invite collaborators by email. They can prompt their own agents in this workspace.
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-fg p-0.5" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        {isOwner && (
          <div className="flex items-center gap-2 mb-4">
            <div className="flex-1 relative">
              <Mail size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submitInvite()}
                placeholder="teammate@example.com"
                className="pl-8 h-8 text-sm"
              />
            </div>
            <Button size="sm" className="h-8 text-white font-medium" disabled={inviting} onClick={() => void submitInvite()}>
              {inviting ? <Loader2 size={14} className="animate-spin" /> : "Invite"}
            </Button>
          </div>
        )}

        <div className="space-y-1 mb-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted mb-1.5">
            People with access
          </div>
          {/* Owner row — always present. */}
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
            <span className="text-[10px] font-medium text-muted border border-border rounded-full px-2 py-0.5 flex items-center gap-1">
              <Crown size={10} /> Owner
            </span>
          </div>
          {loading && !state && (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted">
              <Loader2 size={12} className="animate-spin" /> Loading members…
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
                  "text-[10px] font-medium rounded-full px-2 py-0.5 border",
                  m.status === "pending" ? "text-amber-700 border-amber-300 bg-amber-50" : "text-muted border-border",
                )}
              >
                {m.status === "pending" ? "Invited" : "Editor"}
              </span>
              {(isOwner || m.userId === user?.id) && (
                <button
                  onClick={() => void revoke(m)}
                  className="text-muted hover:text-red-500 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  title={m.userId === user?.id && !isOwner ? "Leave project" : "Remove access"}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
          {state && state.members.length === 0 && (
            <p className="text-xs text-muted px-1 py-1">No collaborators yet — invite someone above.</p>
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
              hint="Their agent turns bill your plan's credits, and they get access to your tier's models."
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

        <p className="text-[11px] text-muted mt-3 pt-3 border-t border-border">
          Sharing requires a Pro or Max plan. Platform-metered model usage by collaborators bills
          your credits, capped per collaborator.
        </p>
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
          "flex items-center justify-center w-8 h-8 rounded-full border border-border transition-colors bolt-hover",
          open ? "bg-elevated text-fg" : "bg-surface text-muted hover:text-fg hover:bg-elevated",
        )}
        title="Share this project"
        aria-label="Share"
      >
        <UserPlus size={15} />
      </button>
      {open && <SharePopover projectId={projectId} anchorRef={triggerRef} onClose={() => setOpen(false)} />}
    </div>
  );
}
