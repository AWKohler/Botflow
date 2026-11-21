"use client";

import { useEffect, useRef, useState } from "react";
import { useModal } from "@/components/ui/use-modal";
import { ExternalLink, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { phoneOverlayClass, phonePanelClass } from "@/components/ui/dialog";

interface StripeConnectModalProps {
  requestId: string;
  projectId: string;
  mode: "test" | "live";
  authorizeUrl: string;
  /** Called when the modal should close (success, dismiss, or external close). */
  onClose: () => void;
}

export function StripeConnectModal({
  projectId,
  mode,
  authorizeUrl,
  onClose,
}: StripeConnectModalProps) {
  const [opening, setOpening] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const popupRef = useRef<Window | null>(null);

  const modalRef = useModal<HTMLDivElement>(true);

  // Detect when the user closes the Stripe popup without authorizing — we
  // don't auto-dismiss the modal (the agent is still polling and they may
  // try again), but we do clear the "opening…" spinner.
  useEffect(() => {
    if (!popupOpen) return;
    const t = setInterval(() => {
      if (popupRef.current && popupRef.current.closed) {
        setPopupOpen(false);
        clearInterval(t);
      }
    }, 500);
    return () => clearInterval(t);
  }, [popupOpen]);

  const handleConnect = () => {
    setOpening(true);
    // Centered popup. 520×720 fits Stripe's authorize page comfortably.
    const w = 520;
    const h = 720;
    const left = Math.max(0, (window.screen.width - w) / 2);
    const top = Math.max(0, (window.screen.height - h) / 2);
    const popup = window.open(
      authorizeUrl,
      "botflow-stripe-connect",
      `width=${w},height=${h},left=${left},top=${top},popup=1`,
    );
    if (!popup) {
      // Popup blocked — fall back to same-tab navigation.
      window.location.href = authorizeUrl;
      return;
    }
    popupRef.current = popup;
    setPopupOpen(true);
    setOpening(false);
  };

  const handleDismiss = () => {
    // Fire-and-forget dismiss on the server (wakes the agent's poll loop).
    fetch(`/api/projects/${projectId}/stripe/connect-request`, {
      method: "DELETE",
    }).catch(() => {});
    if (popupRef.current && !popupRef.current.closed) {
      try {
        popupRef.current.close();
      } catch {
        /* ignore */
      }
    }
    onClose();
  };

  return (
    <div className={cn("fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]", phoneOverlayClass)}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Connect Stripe"
        tabIndex={-1}
        className={cn("relative w-full max-w-md bg-bg border border-border rounded-2xl shadow-2xl mx-4 overflow-hidden outline-none", phonePanelClass)}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b border-border">
          {/* Stripe wordmark "S" */}
          <div className="w-7 h-7 shrink-0 rounded-md bg-[#635BFF] flex items-center justify-center text-white font-bold text-sm">
            S
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-fg flex items-center gap-2">
              Connect Stripe
              <span
                className={
                  "text-[11px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded " +
                  (mode === "live"
                    ? "bg-danger-soft text-danger"
                    : "bg-warning-soft text-warning")
                }
              >
                {mode} mode
              </span>
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Link your Stripe account to accept payments in this project.
            </p>
          </div>
          <button
            onClick={handleDismiss}
            className="shrink-0 text-muted hover:text-fg hover:bg-elevated rounded-lg p-1.5 transition-colors"
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-muted leading-relaxed">
            You&apos;ll be sent to Stripe to sign in (or sign up) and authorize
            Botflow. Your account is linked once and reused for every project
            you build here — separate transactions are tagged by project so you
            can keep them straight in your Stripe Dashboard.
          </p>

          <ul className="text-xs text-muted space-y-1.5 pl-4 list-disc">
            <li>Stripe handles all KYC and disputes — Botflow never sees card data.</li>
            <li>1% platform fee applies to transactions in live mode.</li>
            <li>You can disconnect any time from Stripe&apos;s dashboard.</li>
          </ul>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 pb-6">
          <button
            onClick={handleDismiss}
            className="text-sm text-muted hover:text-fg transition-colors"
          >
            Not now
          </button>
          <button
            onClick={handleConnect}
            disabled={opening}
            className="flex items-center gap-2 bg-[#635BFF] hover:bg-[#5851e8] text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {opening ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Opening Stripe…
              </>
            ) : popupOpen ? (
              <>
                <ExternalLink size={14} />
                Re-open Stripe
              </>
            ) : (
              <>
                Connect with Stripe
                <ExternalLink size={14} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
