"use client";

import { useEffect, useState } from "react";
import { useModal } from "@/components/ui/use-modal";
import { AlertTriangle, PauseCircle, X } from "lucide-react";

/**
 * Workspace surfaces for the Convex usage guardrails
 * (docs/features/convex-usage-guardrails.md, Phase 2).
 *
 * Persistence contract (design decision 2026-07-23):
 *  - paused banner: NOT dismissible — the backend is down; the annoyance is
 *    the feature. Stays until the status leaves 'paused'.
 *  - warned banner: dismissible per mount (in-memory) — returns on refresh,
 *    which is intended; the condition persists.
 *  - paused modal: shown once per workspace-open by the parent (ref-guarded
 *    there), dismissible, returns on reopen/refresh.
 *
 * The transfer-to-BYOC CTA lands with the Phase 3 portal; until then the CTA
 * is contact-support. Editors see the truth but the resolution CTA is
 * owner-only (they can't fix it).
 */

const SUPPORT_MAILTO =
  "mailto:support@botflow.io?subject=Convex%20backend%20paused";

export type ConvexNoticeStatus = "active" | "warned" | "paused" | "migrating" | "transferred";

export function ConvexStatusBanner({
  status,
  isOwner,
}: {
  status: ConvexNoticeStatus;
  isOwner: boolean;
}) {
  const [warnDismissed, setWarnDismissed] = useState(false);

  // A dismissal covers ONE warning episode: leaving 'warned' (cleared, or
  // escalated to paused) re-arms the banner for the next episode.
  useEffect(() => {
    if (status !== "warned") setWarnDismissed(false);
  }, [status]);

  if (status === "paused") {
    return (
      <div className="flex items-center gap-3 border-b border-danger-border bg-danger-soft px-4 py-2 text-xs text-danger">
        <PauseCircle className="h-4 w-4 shrink-0" />
        <span className="font-semibold shrink-0">Backend paused</span>
        <span className="opacity-80 flex-1 truncate">
          This project&apos;s database and functions are paused because usage exceeded
          platform limits. The app can&apos;t read or write data until it&apos;s resolved.
        </span>
        {isOwner ? (
          <a
            href={SUPPORT_MAILTO}
            className="shrink-0 rounded-md bg-danger-solid px-2 py-1 text-xs font-medium text-white hover:bg-danger-solid/90"
          >
            Contact us
          </a>
        ) : (
          <span className="opacity-80 shrink-0">Ask the project owner to resolve this.</span>
        )}
      </div>
    );
  }

  if (status === "warned" && !warnDismissed) {
    return (
      <div className="px-4 py-2 bg-warning-soft border-b border-warning-border text-warning text-xs flex items-center gap-3">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="font-semibold shrink-0">High backend usage</span>
        <span className="opacity-90 flex-1 truncate">
          This project&apos;s Convex backend is unusually busy. If usage keeps climbing it
          may be paused automatically.
        </span>
        <button
          onClick={() => setWarnDismissed(true)}
          className="p-1 rounded hover:bg-warning-border/60 shrink-0"
          aria-label="Dismiss warning"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return null;
}

export function ConvexPausedModal({
  isOwner,
  onClose,
}: {
  isOwner: boolean;
  onClose: () => void;
}) {
  const modalRef = useModal<HTMLDivElement>(true, onClose);
  return (
    <div className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Your backend is paused"
        tabIndex={-1}
        className="w-[min(480px,calc(100vw-2rem))] rounded-2xl border border-border bg-bg text-fg shadow-2xl outline-none"
      >
        <div className="px-5 py-4 border-b border-border flex items-center gap-2.5">
          <PauseCircle className="h-5 w-5 text-danger shrink-0" />
          <h2 className="flex-1 text-base font-semibold">Your backend is paused</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-elevated hover:text-fg"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3 text-sm">
          <p>
            This project&apos;s Convex backend exceeded the usage included with managed
            hosting, so it has been paused. While paused, the app&apos;s database
            queries and functions fail — your data is safe and nothing has been
            deleted.
          </p>
          <p className="text-muted">
            This usually means a runaway loop (for example a scheduled function
            re-triggering itself) or genuinely heavy traffic.
          </p>
          {isOwner ? (
            <p className="text-muted">
              Think this is a mistake, or ready to keep growing?{" "}
              <a href={SUPPORT_MAILTO} className="text-accent underline underline-offset-2">
                Contact us
              </a>{" "}
              and we&apos;ll resolve it — including moving the backend to your own
              Convex account so it&apos;s never capped by platform limits.
            </p>
          ) : (
            <p className="text-muted">
              Only the project owner can resolve this — let them know.
            </p>
          )}
        </div>
        <div className="px-5 py-3.5 border-t border-border flex justify-end gap-2">
          {isOwner && (
            <a
              href={SUPPORT_MAILTO}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-fg bg-linear-to-b from-white/[0.09] to-white/0 inset-shadow-bevel-ink disabled:bg-none disabled:shadow-none disabled:inset-shadow-none px-3 text-[13px] font-medium text-bg shadow-xs transition-colors hover:bg-fg/88 disabled:opacity-50"
            >
              Contact us
            </a>
          )}
          <button
            onClick={onClose}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-linear-to-b from-bg to-surface inset-shadow-bevel disabled:bg-none disabled:bg-surface disabled:shadow-none disabled:inset-shadow-none dark:from-elevated dark:to-surface px-3 text-[13px] font-medium text-fg shadow-xs transition-colors hover:border-border-strong hover:from-surface hover:to-elevated dark:hover:from-soft dark:hover:to-elevated disabled:opacity-50"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
