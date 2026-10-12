"use client";

import { Lock, X } from "lucide-react";

interface OwnerOnlyRequestProps {
  /** What the agent is waiting for, e.g. "Google sign-in credentials". */
  subject: string;
  /** Hide this card for the current viewer only; the request stays open. */
  onHide: () => void;
  /** Tell the agent to carry on without it (where editors may dismiss). */
  onSkip?: () => void;
}

/**
 * Shown INSTEAD of a needs-input modal to a project member who isn't allowed
 * to complete it (secret values and integration connects are owner-only — see
 * the sharing permission table). The request stays pending for the owner.
 */
export function OwnerOnlyRequest({ subject, onHide, onSkip }: OwnerOnlyRequestProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative mx-4 w-full max-w-md overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-6 pb-4 pt-6">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Lock size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-fg">Waiting for the project owner</h2>
            <p className="mt-0.5 text-xs text-muted">An agent in this project needs {subject}.</p>
          </div>
          <button
            onClick={onHide}
            className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-elevated hover:text-fg"
            aria-label="Hide"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-6 py-5 text-sm leading-relaxed text-fg/90">
          Only the project owner can provide this. The request stays open, and they&apos;ll see it the next time they
          open the project.
        </div>
        <div className="flex items-center justify-between gap-3 px-6 pb-6">
          {onSkip ? (
            <button onClick={onSkip} className="text-sm text-muted transition-colors hover:text-fg">
              Tell the agent to skip it
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={onHide}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
