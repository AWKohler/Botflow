"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function safePreviewUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // Never frame Botflow itself (would put a same-origin page in the frame).
    if (typeof window !== "undefined" && u.origin === window.location.origin) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function PreviewPopup() {
  const searchParams = useSearchParams();
  // Only a real web preview may be framed here: anything else (data:, blob:,
  // javascript:, garbage) is refused, so this page can't be used to show
  // arbitrary content under Botflow's address.
  const url = safePreviewUrl(searchParams.get("url"));

  if (!url) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg px-6 text-center text-sm text-muted">
        Nothing to show yet. Open this window from a project&apos;s preview.
      </div>
    );
  }

  return (
    <iframe
      src={url}
      className="fixed inset-0 w-full h-full border-0"
      allow="cross-origin-isolated"
      title="Preview"
    />
  );
}

export default function PreviewPopupPage() {
  return (
    <Suspense>
      <PreviewPopup />
    </Suspense>
  );
}
