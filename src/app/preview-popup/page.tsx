"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function PreviewPopup() {
  const searchParams = useSearchParams();
  const url = searchParams.get("url") ?? "";

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
