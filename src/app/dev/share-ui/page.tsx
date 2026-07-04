import { notFound } from "next/navigation";
import { ShareControls } from "@/components/sharing/share-controls";

/**
 * Dev-only visual harness for the sharing header controls — renders them in a
 * fake header strip without needing a signed-in workspace. 404s outside
 * development. Set NEXT_PUBLIC_SHARING_UI_MOCK=true to populate the stack.
 */
export default function ShareUiDevPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return (
    <div className="min-h-screen bg-elevated flex items-start justify-center pt-24">
      <div className="w-[900px] space-y-8">
        <div className="flex items-center gap-2 h-12 px-3 rounded-xl border border-border bg-surface">
          <span className="text-sm text-muted">project header mock</span>
          <div className="flex items-center gap-2 border border-border rounded-full px-3 py-1 min-w-[220px] ml-auto">
            <span className="text-sm text-muted">/</span>
          </div>
          <ShareControls projectId="dev-share-ui" />
          <div className="w-8 h-8 rounded-full bg-soft" title="UserButton placeholder" />
        </div>
        <p className="text-xs text-muted text-center">
          /dev/share-ui — development-only harness for ShareControls
        </p>
      </div>
    </div>
  );
}
