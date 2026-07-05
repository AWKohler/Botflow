"use client";

/**
 * Workspace-header sharing controls: active-collaborator avatar stack +
 * icon-only "Share" button + share-sheet popover. Sits between the preview
 * URL bar and the Clerk UserButton (see docs/features/project-sharing-plan.md §7).
 *
 * Popovers render through a portal to document.body with fixed positioning
 * computed from the trigger's rect — the same pattern as
 * sandboxed-web-workspace/publish-panel.tsx. In-header absolute positioning
 * gets buried/clipped by the workspace's stacking contexts (that's why the
 * publish panel is architected this way, and why v1 of this component
 * appeared to "not open").
 *
 * Data layer is intentionally a stub for now: `useActiveCollaborators`
 * returns the signed-in user (the owner) until the presence heartbeat lands
 * (plan §6.3) — the header stack hides self, so it renders empty until
 * presence exists. Invite/settings actions toast instead of persisting until
 * the members backend lands (plan Phase 3).
 *
 * Set NEXT_PUBLIC_SHARING_UI_MOCK=true to render six fake collaborators for
 * evaluating the stack/overflow visuals. Dev-only affordance.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUser } from "@clerk/nextjs";
import { UserPlus, Mail, Crown, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

// ─── Types + presence stub ───────────────────────────────────────────────────

export interface ActiveCollaborator {
  userId: string;
  name: string;
  /** Clerk avatar URL; absent → initials disc. */
  imageUrl?: string;
  role: "owner" | "editor";
}

/** Warm ring palette in the sand family — deterministic per user. */
const RING_COLORS = ["#c2703e", "#a98a2f", "#7d8c5c", "#5c7d8c", "#8c5c7d", "#b05252"];

function ringColorFor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
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

/**
 * Presence stub. Real version (plan §6.3) reads the presence set delivered on
 * the existing workspace poll — heartbeats must never feed keepalive.
 * Returns ALL active people including self; the header stack filters self out.
 */
function useActiveCollaborators(projectId: string): ActiveCollaborator[] {
  // Unused until the presence poll lands — the signature is the contract.
  void projectId;
  const { user } = useUser();
  return useMemo(() => {
    const self: ActiveCollaborator[] = user
      ? [
          {
            userId: user.id,
            name: user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "You",
            imageUrl: user.imageUrl,
            role: "owner",
          },
        ]
      : [];
    if (process.env.NEXT_PUBLIC_SHARING_UI_MOCK === "true") {
      return [...self, ...MOCK_COLLABORATORS];
    }
    return self;
  }, [user]);
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

function Avatar({
  collaborator,
  size = 28,
  className,
}: {
  collaborator: ActiveCollaborator;
  size?: number;
  className?: string;
}) {
  const ring = ringColorFor(collaborator.userId);
  const initials = collaborator.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      className={cn("relative inline-flex shrink-0 rounded-full", className)}
      style={{ width: size, height: size, boxShadow: `0 0 0 1.5px ${ring}` }}
      title={collaborator.name}
    >
      {collaborator.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={collaborator.imageUrl}
          alt={collaborator.name}
          className="w-full h-full rounded-full object-cover"
        />
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
                <Avatar collaborator={c} size={24} />
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

// ─── Avatar stack ────────────────────────────────────────────────────────────

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
          <Avatar collaborator={c} />
        </span>
      ))}
      {hidden.length > 0 && <OverflowChip hidden={hidden} />}
    </div>
  );
}

// ─── Toggle (sand-styled, no Switch primitive in the repo) ───────────────────

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none group">
      <button
        role="switch"
        aria-checked={checked}
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
  anchorRef,
  collaborators,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  collaborators: ActiveCollaborator[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [editorsCanPush, setEditorsCanPush] = useState(false);
  const [shareOwnerOauth, setShareOwnerOauth] = useState(false);
  const [position, setPosition] = useState<AnchoredPosition | null>(null);

  // Rendered only when the platform-wide escape hatch is on (plan §5.1);
  // the server enforces the real SHARING_ALLOW_OWNER_OAUTH at credential
  // resolution — this client flag only controls visibility.
  const ownerOauthAvailable = process.env.NEXT_PUBLIC_SHARING_ALLOW_OWNER_OAUTH === "true";

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

  const notWiredYet = () =>
    toast({
      title: "Not wired up yet",
      description: "Invites and sharing settings land with the members backend (Phase 3).",
    });

  const submitInvite = () => {
    if (!email.trim()) return;
    notWiredYet();
    setEmail("");
  };

  return createPortal(
    <>
      {/* Click-away backdrop — same pattern as the publish panel. */}
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

        <div className="flex items-center gap-2 mb-4">
          <div className="flex-1 relative">
            <Mail size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitInvite()}
              placeholder="teammate@example.com"
              className="pl-8 h-8 text-sm"
            />
          </div>
          <Button size="sm" className="h-8 text-white font-medium" onClick={submitInvite}>
            Invite
          </Button>
        </div>

        <div className="space-y-1 mb-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted mb-1.5">
            In this workspace now
          </div>
          {collaborators.map((c) => (
            <div key={c.userId} className="flex items-center gap-2.5 px-1 py-1">
              <Avatar collaborator={c} size={26} />
              <span className="text-sm text-fg truncate flex-1">{c.name}</span>
              {c.role === "owner" ? (
                <span className="text-[10px] font-medium text-muted border border-border rounded-full px-2 py-0.5 flex items-center gap-1">
                  <Crown size={10} /> Owner
                </span>
              ) : (
                <span className="text-[10px] font-medium text-muted border border-border rounded-full px-2 py-0.5">
                  Editor
                </span>
              )}
            </div>
          ))}
          {collaborators.length <= 1 && (
            <p className="text-xs text-muted px-1 py-1">No collaborators yet — invite someone above.</p>
          )}
        </div>

        <div className="border-t border-border pt-3 space-y-3">
          <Toggle
            checked={editorsCanPush}
            onChange={(v) => {
              setEditorsCanPush(v);
              notWiredYet();
            }}
            label="Editors can push to GitHub"
            hint="Commits and pushes go to your linked repository, attributed to the editor."
          />
          {ownerOauthAvailable && (
            <Toggle
              checked={shareOwnerOauth}
              onChange={(v) => {
                setShareOwnerOauth(v);
                notWiredYet();
              }}
              label="Collaborators may use my Claude/Codex subscription"
              hint="Off: collaborators connect their own accounts for OAuth models."
            />
          )}
        </div>

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
  const { user } = useUser();
  const collaborators = useActiveCollaborators(projectId);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // The header stack shows OTHER active people — never yourself.
  const others = useMemo(
    () => collaborators.filter((c) => c.userId !== user?.id),
    [collaborators, user?.id],
  );

  return (
    <div className="flex items-center gap-2">
      <CollaboratorStack collaborators={others} />
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
      {open && (
        <SharePopover anchorRef={triggerRef} collaborators={collaborators} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
