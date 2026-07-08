"use client";

/**
 * SandboxedWebWorkspace
 *
 * The web/Vite-Convex experience but driven by a Vercel Sandbox instead of a
 * StackBlitz WebContainer. Mirrors `<Workspace>` for layout/UX:
 *
 *   • Tabs: Preview / Code / Database (Database only when hasBackend)
 *   • Sidebar (on Code): Files / Search / ENV
 *   • Terminal panel at the bottom of Code tab (xterm via sandbox/exec SSE)
 *   • Play to start the dev server inside the sandbox
 *   • Preview iframe sources the public domain returned by `sandbox.domain(port)`
 *
 * Out of scope for v1 (deferred — both panels are heavily WebContainer-coupled
 * and need a separate refactor):
 *   • Publish panel (Cloudflare deploy)
 *   • HTML snapshot capture (requires postMessage from a cross-origin iframe;
 *     verify the template's main.tsx forwarding works to *.vercel.run first)
 *
 * GitHub: Phase A wiring lives in `./github-panel.tsx` and renders as a
 * sidebar tab on the Code view.
 */
import { Input } from "@/components/ui/input";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspacePoll, rateLimitDelayMs } from "./use-workspace-poll";
import dynamic from "next/dynamic";
import { useToast } from "@/components/ui/toast";
import { CodeEditor } from "@/components/workspace/code-editor";
import { FileTree } from "@/components/workspace/file-tree";
import { EnvPanel } from "@/components/workspace/env-panel";
import { ImageViewer } from "@/components/workspace/image-viewer";
import { Preview } from "@/components/workspace/preview";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { ConvexDashboard } from "@/components/convex/ConvexDashboard";
import { Button } from "@/components/ui/button";
import { Tabs, TabOption } from "@/components/ui/tabs";
import { UserButton } from "@clerk/nextjs";

const PersistentTerminal = dynamic(
  () => import("@/components/persistent-workspace/terminal").then((m) => m.PersistentTerminal),
  { ssr: false, loading: () => <div className="h-full w-full bg-elevated" /> },
);
import {
  PanelLeft,
  Save,
  Play,
  Loader2,
  Monitor,
  Tablet,
  Smartphone,
  AppWindow,
  Frame,
  ArrowUpRight,
  ExternalLink,
  MousePointer2,
  RefreshCw,
} from "lucide-react";
import type { PreviewInfo } from "@/lib/preview-store";
import { buildPreviewUrl } from "@/lib/preview-url";
import { cn } from "@/lib/utils";
import {
  normalizeBackendType,
  projectUsesConvex,
  type BackendType,
} from "@/lib/project-platform";
import { FileSearch } from "@/components/persistent-workspace/file-search";
import { OAuthProviderModal } from "@/components/workspace/oauth-provider-modal";
import { StripeConnectModal } from "@/components/workspace/stripe-connect-modal";
import { EnvVarModal } from "@/components/workspace/env-var-modal";
import { StripeTab, StripeModeToggle } from "@/components/sandboxed-web-workspace/stripe-tab";
import { SandboxGitHubPanel } from "./github-panel";
import { SandboxPublishPanel } from "./publish-panel";
import { Globe } from "lucide-react";

type WorkspaceView = "preview" | "code" | "database" | "stripe";
type SandboxStatus = "idle" | "booting" | "ready" | "error";
type FileEntry = { type: "file" | "folder" };

interface SandboxedWebWorkspaceProps {
  projectId: string;
  initialPrompt?: string;
  backendType?: BackendType;
}

export function SandboxedWebWorkspace({
  projectId,
  initialPrompt,
  backendType: initialBackendType,
}: SandboxedWebWorkspaceProps) {
  const { toast } = useToast();

  // ── Sandbox lifecycle ────────────────────────────────────────────────
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus>("idle");
  const [bootError, setBootError] = useState<string | null>(null);
  const initializedRef = useRef(false);

  // ── File state ───────────────────────────────────────────────────────
  const [files, setFiles] = useState<Record<string, FileEntry>>({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [imageBlobUrl, setImageBlobUrl] = useState<string | null>(null);
  const [imageByteLength, setImageByteLength] = useState<number | undefined>(undefined);

  // ── UI state ─────────────────────────────────────────────────────────
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<"files" | "search" | "env" | "git">("files");

  // GitHub link state (lives on `projects`; mirrored locally for the panel)
  const [githubRepoOwner, setGithubRepoOwner] = useState<string | null>(null);
  const [githubRepoName, setGithubRepoName] = useState<string | null>(null);
  const [githubDefaultBranch, setGithubDefaultBranch] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<WorkspaceView>("preview");

  // ── Preview / dev server ─────────────────────────────────────────────
  const [previews, setPreviews] = useState<PreviewInfo[]>([]);
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
  const [previewPath, setPreviewPath] = useState<string>("/");
  const [previewDevice, setPreviewDevice] = useState<
    "desktop" | "tablet" | "mobile" | "responsive" | "figma"
  >("desktop");
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [editMode, setEditMode] = useState(false);
  const [isDevServerRunning, setIsDevServerRunning] = useState(false);
  const [isStartingServer, setIsStartingServer] = useState(false);
  /** Last-seen HTML snapshot (UploadThing) — rendered blurred while the dev
   *  server is off. */
  const [htmlSnapshotUrl, setHtmlSnapshotUrl] = useState<string | null>(null);
  /** Mirrors AgentPanel's debounced busy state via the agent-busy-change event. */
  const [isAgentWorking, setIsAgentWorking] = useState(false);
  /** True only while the agent works on the project's FIRST message. */
  const [isInitialBuild, setIsInitialBuild] = useState(false);

  // ── Project metadata ─────────────────────────────────────────────────
  const [backendType, setBackendType] = useState<BackendType>(
    initialBackendType ?? "platform",
  );
  const hasBackend = projectUsesConvex(backendType);
  /** True once setupAuth has run successfully on this project. */
  const [hasAuth, setHasAuth] = useState(false);
  /** Pending OAuth provider request surfaced by the agent's setupOAuthProvider tool. */
  const [pendingOAuthRequest, setPendingOAuthRequest] = useState<{
    id: string;
    provider: string;
    convexSiteUrl: string | null;
  } | null>(null);
  /** Pending Stripe Connect request surfaced by initializeStripePayments. */
  const [pendingStripeRequest, setPendingStripeRequest] = useState<{
    id: string;
    mode: "test" | "live";
    authorizeUrl: string;
  } | null>(null);
  /** Pending env-var entry request surfaced by the agent's requestEnvVar tool. */
  const [pendingEnvVarRequest, setPendingEnvVarRequest] = useState<{
    id: string;
    target: "client" | "server";
    key: string;
    message: string | null;
    isSecret: boolean;
  } | null>(null);
  /** Project's Stripe state — populated from /api/projects/[id]. */
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [stripePaymentMode, setStripePaymentMode] = useState<"test" | "live">("test");
  const [stripeModeToggling, setStripeModeToggling] = useState(false);
  /** Set when the previewed app asks us to open a Stripe URL it can't iframe
   *  (Checkout / dashboard). We surface a card with a real "Open" button so the
   *  user's click is a fresh top-level gesture (no popup blocker). */
  const [checkoutHandoffUrl, setCheckoutHandoffUrl] = useState<string | null>(null);
  /** Set when the previewed app asks us to resume an OAuth sign-in that can't
   *  complete inside the iframe. We reopen the app in a new top-level tab with
   *  ?botflow_signin=<provider> so the flow runs (and the session lands) there. */
  const [authHandoff, setAuthHandoff] = useState<{ provider: string; url: string } | null>(null);

  // ── Publish / Cloudflare Pages state ─────────────────────────────────
  const [cloudflareProjectName, setCloudflareProjectName] = useState<string | null>(null);
  const [cloudflareDeploymentUrl, setCloudflareDeploymentUrl] = useState<string | null>(null);
  const [managedDomainId, setManagedDomainId] = useState<string | null>(null);
  const [managedDomainHostname, setManagedDomainHostname] = useState<string | null>(null);
  const [customDomain, setCustomDomain] = useState<string | null>(null);
  const [customDomainStatus, setCustomDomainStatus] = useState<"pending" | "active" | "error" | null>(null);
  const [canUseCustomDomain, setCanUseCustomDomain] = useState(false);
  const [managedDomainsEnabled, setManagedDomainsEnabled] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const publishBtnRef = useRef<HTMLButtonElement | null>(null);
  // Public/showcase state — a project is listed publicly only via the deploy popover.
  const [isPublic, setIsPublic] = useState(false);
  const [publicSlug, setPublicSlug] = useState<string | null>(null);
  const [publicDescription, setPublicDescription] = useState<string | null>(null);

  // Fall back to Preview if Database tab is selected but no backend
  useEffect(() => {
    if (!hasBackend && currentView === "database") {
      setCurrentView("preview");
    }
  }, [hasBackend, currentView]);

  // Fetch project metadata (backendType + authConfigured + GitHub link) on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
        if (!res.ok) return;
        const proj = await res.json();
        if (!initialBackendType && typeof proj?.backendType === "string") {
          setBackendType(normalizeBackendType(proj.backendType));
        }
        if (proj?.authConfigured === true) setHasAuth(true);
        if (typeof proj?.githubRepoOwner === "string") setGithubRepoOwner(proj.githubRepoOwner);
        if (typeof proj?.githubRepoName === "string") setGithubRepoName(proj.githubRepoName);
        if (typeof proj?.githubDefaultBranch === "string") setGithubDefaultBranch(proj.githubDefaultBranch);
        if (proj?.cloudflareProjectName) setCloudflareProjectName(proj.cloudflareProjectName);
        if (proj?.cloudflareDeploymentUrl) setCloudflareDeploymentUrl(proj.cloudflareDeploymentUrl);
        if (typeof proj?.isPublic === "boolean") setIsPublic(proj.isPublic);
        if (typeof proj?.publicSlug === "string") setPublicSlug(proj.publicSlug);
        if (typeof proj?.publicDescription === "string") setPublicDescription(proj.publicDescription);
        if (proj?.managedDomainId) setManagedDomainId(proj.managedDomainId);
        if (proj?.managedDomainHostname) setManagedDomainHostname(proj.managedDomainHostname);
        if (proj?.customDomain) setCustomDomain(proj.customDomain);
        if (proj?.customDomainStatus) setCustomDomainStatus(proj.customDomainStatus);
        if (proj?.stripeEnabled === true) setStripeEnabled(true);
        if (proj?.stripePaymentMode === "live" || proj?.stripePaymentMode === "test") {
          setStripePaymentMode(proj.stripePaymentMode);
        }
        if (typeof proj?.htmlSnapshotUrl === "string") setHtmlSnapshotUrl(proj.htmlSnapshotUrl);
      } catch (e) {
        console.warn("Failed to load project metadata", e);
      }
    })();
    // Plan flags — separate endpoint, parallel.
    (async () => {
      try {
        const r = await fetch('/api/user/plan');
        if (!r.ok) return;
        const plan = await r.json() as { canUseCustomDomain?: boolean; managedDomains?: boolean };
        setCanUseCustomDomain(Boolean(plan.canUseCustomDomain));
        setManagedDomainsEnabled(Boolean(plan.managedDomains));
      } catch {/* ignore */}
    })();
  }, [initialBackendType, projectId]);

  const refreshFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/sandbox/files`);
      if (!res.ok) return;
      const data = (await res.json()) as { files: Record<string, FileEntry> };
      setFiles(data.files ?? {});
    } catch (e) {
      console.warn("Failed to load files", e);
    }
  }, [projectId]);

  // ── Live file-tree reconcile ──────────────────────────────────────────
  // The sandbox FS can change underneath us at any time: the terminal
  // (`touch`, `rm`, `mv`), the agent's file tools, and `git pull` all mutate
  // disk without going through this component. Without a change feed the tree
  // would stay frozen at its boot snapshot until a manual refresh.
  //
  // We poll a cheap signature endpoint (`?signature` → `find | cksum`) that
  // folds in path+size+mtime for every file. When it differs from the last
  // value we saw, the tree genuinely changed, so we re-fetch the full listing.
  // `setFiles` only swaps the path→type map; `expandedFolders` (owned by
  // FileTree) and `selectedFile` are untouched, so reconciling never collapses
  // folders or steals the user's selection.
  const lastTreeSignatureRef = useRef<string | null>(null);
  useWorkspacePoll(async (signal) => {
    // NOTE: must send a *value* (`=1`). Vercel's runtime drops value-less
    // query params, so a bare `?signature` arrives as no param at all and
    // the route falls through to returning the full listing.
    const res = await fetch(
      `/api/projects/${projectId}/sandbox/files?signature=1`,
      { cache: "no-store", signal },
    );
    if (res.status === 429) return rateLimitDelayMs(res);
    if (!res.ok) return;
    const { signature } = (await res.json()) as { signature: string };
    // Empty signature == probe hiccup; leave the baseline alone.
    if (!signature || signal.aborted) return;

    if (lastTreeSignatureRef.current === null) {
      // First successful probe. Establish the baseline and reconcile once
      // to close the gap between boot's snapshot and this signature (a
      // change in that window would otherwise go unnoticed until the next).
      lastTreeSignatureRef.current = signature;
      await refreshFiles();
    } else if (signature !== lastTreeSignatureRef.current) {
      lastTreeSignatureRef.current = signature;
      await refreshFiles();
    }
  }, 3000, sandboxStatus === "ready");

  // Boot the sandbox: ensure session → seed if empty → load file tree.
  // Extracted so the retry button on the error banner can re-invoke it.
  const bootSandbox = useCallback(async () => {
    setSandboxStatus("booting");
    setBootError(null);
    try {
      const sessionRes = await fetch(`/api/projects/${projectId}/sandbox/session`, {
        method: "POST",
      });
      if (!sessionRes.ok) {
        const body = await sessionRes.text();
        throw new Error(body || `Failed to start sandbox (status ${sessionRes.status})`);
      }

      const seedRes = await fetch(`/api/projects/${projectId}/sandbox/seed`, {
        method: "POST",
      });
      if (seedRes.ok) {
        const { seeded, template } = (await seedRes.json()) as {
          seeded: boolean;
          template?: string;
        };
        if (seeded) {
          const label =
            template === "viteConvex"
              ? "the Vite + Convex starter"
              : template === "vite"
                ? "the Vite starter"
                : "the project starter";
          toast({ title: "Project initialized", description: `Seeded ${label}.` });
        }
      }

      await refreshFiles();
      setSandboxStatus("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start sandbox";
      setBootError(msg);
      setSandboxStatus("error");
      toast({ title: "Sandbox error", description: msg });
    }
  }, [projectId, refreshFiles, toast]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void bootSandbox();
  }, [bootSandbox]);

  // ── File actions ─────────────────────────────────────────────────────
  const isImageExtension = (filename: string) => {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    return ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"].includes(ext);
  };

  const handleFileSelect = useCallback(
    async (filePath: string) => {
      if (files[filePath]?.type !== "file") return;
      try {
        if (isImageExtension(filePath)) {
          // Image: fetch as binary and produce a blob URL for ImageViewer
          const res = await fetch(
            `/api/projects/${projectId}/sandbox/files?path=${encodeURIComponent(filePath)}`,
          );
          if (!res.ok) {
            toast({ title: "Failed to read image", description: await res.text() });
            return;
          }
          const data = (await res.json()) as { content: string; binary: boolean };
          if (!data.binary) return;
          const bytes = Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0));
          const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
          const mime =
            ext === "svg" ? "image/svg+xml" : ext === "ico" ? "image/x-icon" : `image/${ext}`;
          const blob = new Blob([new Uint8Array(bytes)], { type: mime });
          if (imageBlobUrl) URL.revokeObjectURL(imageBlobUrl);
          setImageBlobUrl(URL.createObjectURL(blob));
          setImageByteLength(bytes.byteLength);
          setSelectedFile(filePath);
          setFileContent("");
          setHasUnsavedChanges(false);
          return;
        }

        const res = await fetch(
          `/api/projects/${projectId}/sandbox/files?path=${encodeURIComponent(filePath)}`,
        );
        if (!res.ok) {
          toast({ title: "Failed to read file", description: await res.text() });
          return;
        }
        const data = (await res.json()) as { content: string; binary: boolean };
        if (data.binary) {
          toast({ title: "Binary file", description: "Binary files cannot be edited here." });
          return;
        }
        if (imageBlobUrl) {
          URL.revokeObjectURL(imageBlobUrl);
          setImageBlobUrl(null);
        }
        setSelectedFile(filePath);
        setFileContent(data.content);
        setHasUnsavedChanges(false);
      } catch (e) {
        console.error("Failed to read file:", e);
      }
    },
    [projectId, files, toast, imageBlobUrl],
  );

  const handleContentChange = useCallback((next: string) => {
    setFileContent(next);
    setHasUnsavedChanges(true);
  }, []);

  const handleSaveFile = useCallback(async () => {
    if (!selectedFile) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/sandbox/files`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFile, content: fileContent }),
      });
      if (!res.ok) throw new Error(await res.text());
      setHasUnsavedChanges(false);
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, [projectId, selectedFile, fileContent, toast]);

  // Cmd/Ctrl+S to save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (selectedFile && hasUnsavedChanges) handleSaveFile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedFile, hasUnsavedChanges, handleSaveFile]);

  // ── Iframe postMessage → server browser log ──────────────────────────
  // The Vite template at `vite_convex_template/src/main.tsx` posts console
  // events, errors, and HMR events to `window.parent` with targetOrigin '*'.
  // We accept them only from *.vercel.run (the sandbox public domain),
  // buffer them in a ref, and flush via debounced POST to /browser-log so
  // the agent's `getBrowserLog` tool can read recent activity.
  const browserLogBufferRef = useRef<
    Array<{ timestamp: number; level: "log" | "warn" | "error"; message: string; type: "console" | "error" | "hmr" }>
  >([]);
  const browserLogFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const FLUSH_THRESHOLD = 50;
    const FLUSH_INTERVAL_MS = 500;

    function flush() {
      if (browserLogFlushTimerRef.current) {
        clearTimeout(browserLogFlushTimerRef.current);
        browserLogFlushTimerRef.current = null;
      }
      const batch = browserLogBufferRef.current.splice(0, browserLogBufferRef.current.length);
      if (batch.length === 0) return;
      fetch(`/api/projects/${projectId}/browser-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: batch }),
        keepalive: true,
      }).catch(() => { /* best-effort; the next batch will arrive shortly */ });
    }

    function schedule() {
      if (browserLogBufferRef.current.length >= FLUSH_THRESHOLD) {
        flush();
        return;
      }
      if (browserLogFlushTimerRef.current) return;
      browserLogFlushTimerRef.current = setTimeout(flush, FLUSH_INTERVAL_MS);
    }

    function handleMessage(event: MessageEvent) {
      // Only accept messages from the sandbox's own public domain. In dev the
      // origin will be sb-xxxx.vercel.run; if a project ever runs locally we
      // also accept localhost to ease testing.
      if (
        !event.origin.endsWith(".vercel.run") &&
        !event.origin.startsWith("http://localhost")
      ) return;

      const data = event.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== "object") return;
      const type = data.type;

      if (type === "IFRAME_CONSOLE") {
        const level = data.level === "warn" || data.level === "error" ? data.level : "log";
        const message = typeof data.message === "string" ? data.message : String(data.message ?? "");
        if (!message) return;
        browserLogBufferRef.current.push({
          timestamp: Date.now(),
          level,
          message,
          type: "console",
        });
        schedule();
      } else if (type === "IFRAME_ERROR") {
        const message = data.filename
          ? `${data.message} at ${data.filename}:${data.lineno}:${data.colno}`
          : String(data.message ?? "");
        if (!message) return;
        browserLogBufferRef.current.push({
          timestamp: Date.now(),
          level: "error",
          message,
          type: "error",
        });
        schedule();
      } else if (type === "VITE_HMR") {
        const evt = typeof data.event === "string" ? data.event : "";
        if (!evt) return;
        const err = typeof data.error === "string" ? data.error : undefined;
        browserLogBufferRef.current.push({
          timestamp: Date.now(),
          level: evt === "error" ? "error" : "log",
          message: err ? `${evt}: ${err}` : evt,
          type: "hmr",
        });
        schedule();
      }
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      // Final flush on unmount.
      flush();
    };
  }, [projectId]);

  // ── Preview state polling (refresh signal + dev server state) ───────
  // The Redis-backed preview-state endpoint is the SINGLE SOURCE OF TRUTH for
  // what the preview pane should show. Two distinct signals flow through it:
  //
  //  1. `refreshAt` — bumped by the agent's `refreshPreview` tool. When it
  //     changes, we remount the iframe (forces a hard reload).
  //
  //  2. `devServer` — published by `start/stopSandboxDevServer` (whether
  //     called by the Play button or by the agent's startDevServer tool).
  //     When `running` flips true with a URL, we wire the preview pane to it
  //     and bump previewReloadKey. When it flips false, we clear the pane.
  //
  // This is what makes the agent's startDevServer tool actually surface the
  // running preview to the user — without it, the agent would start the
  // server but the user's iframe would still be empty.
  const lastRefreshAtRef = useRef<number | null>(null);
  const lastDevServerStateRef = useRef<{ running: boolean; previewUrl: string | null; updatedAt: number } | null>(null);
  useWorkspacePoll(async (signal) => {
    const res = await fetch(`/api/projects/${projectId}/sandbox/preview-state`, {
      cache: "no-store",
      signal,
    });
    if (res.status === 429) return rateLimitDelayMs(res);
    if (!res.ok) return;
    const data = (await res.json()) as {
      refreshAt: number | null;
      devServer: { running: boolean; previewUrl: string | null; port: number | null; updatedAt: number } | null;
    };
    if (signal.aborted) return;

    // ── Refresh signal ───────────────────────────────────────────
    const nextRefresh = data.refreshAt;
    if (lastRefreshAtRef.current === null) {
      // First poll establishes baseline so a stale signal from before
      // the user opened the workspace doesn't trigger an immediate reload.
      lastRefreshAtRef.current = nextRefresh;
    } else if (nextRefresh && nextRefresh !== lastRefreshAtRef.current) {
      lastRefreshAtRef.current = nextRefresh;
      setPreviewReloadKey((k) => k + 1);
    }

    // ── Dev server state ──────────────────────────────────────────
    // Mirror Redis truth into local UI state. Only react when the
    // updatedAt timestamp advances OR when the running/URL pair drifts
    // from what we last applied — this prevents false-positive remounts
    // on every poll while still catching genuine changes.
    const ds = data.devServer;
    const prev = lastDevServerStateRef.current;
    const ourDevServerRunning = isDevServerRunningRef.current;
    if (ds) {
      const advanced = prev === null || ds.updatedAt > prev.updatedAt;
      const drifted =
        ds.running !== ourDevServerRunning ||
        (ds.running && ds.previewUrl && previews[0]?.baseUrl !== ds.previewUrl);
      if (advanced || drifted) {
        lastDevServerStateRef.current = {
          running: ds.running,
          previewUrl: ds.previewUrl,
          updatedAt: ds.updatedAt,
        };
        if (ds.running && ds.previewUrl && ds.port !== null) {
          setPreviews([{ port: ds.port, ready: true, baseUrl: ds.previewUrl }]);
          setActivePreviewIndex(0);
          setIsDevServerRunning(true);
          setPreviewReloadKey((k) => k + 1);
          // If the agent started the server while the user was on Code
          // tab, switch them to Preview so they actually see the result.
          if (currentView !== "preview") setCurrentView("preview");
        } else {
          // Stopped — clear the pane to a "stopped" empty state.
          setPreviews([]);
          setIsDevServerRunning(false);
        }
      }
    } else if (prev !== null) {
      // State key disappeared (e.g., TTL expired). Don't tear down a
      // working preview — just forget our baseline so any future change
      // re-triggers reconciliation.
      lastDevServerStateRef.current = null;
    }
  }, 2000, sandboxStatus === "ready");

  // Stable ref so the polling effect can read the latest isDevServerRunning
  // without needing to re-fire when that state flips.
  const isDevServerRunningRef = useRef(isDevServerRunning);
  isDevServerRunningRef.current = isDevServerRunning;

  // ── OAuth provider request polling ───────────────────────────────────
  // When the agent calls setupOAuthProvider, it creates a pending request in
  // the DB. We poll for it and show the OAuthProviderModal when one is found.
  //
  // NOTE: we deliberately do NOT gate on hasAuth here. setupAuth sets
  // authConfigured=true server-side but the workspace only reads it on mount.
  // If the user runs setupAuth then setupOAuthProvider in the same session,
  // hasAuth would still be false. Polling regardless is cheap (one indexed
  // DB read every 2.5s returning null most of the time).
  useWorkspacePoll(async (signal) => {
    const res = await fetch(
      `/api/projects/${projectId}/convex/oauth-provider-status`,
      { cache: "no-store", signal },
    );
    if (res.status === 429) return rateLimitDelayMs(res);
    if (!res.ok) return;
    const data = await res.json() as {
      ok: boolean;
      pending: { id: string; provider: string; convexSiteUrl: string | null } | null;
    };
    if (!signal.aborted && data.ok) {
      setPendingOAuthRequest(data.pending);
    }
  }, 2500, hasBackend && sandboxStatus === "ready");

  // ── Env-var request polling ──────────────────────────────────────────
  // When the agent calls requestEnvVar, it creates a pending request in the
  // DB. We poll for it and show the EnvVarModal when one is found. Not gated
  // on hasBackend — client (Vite) env vars work on frontend-only projects.
  useWorkspacePoll(async (signal) => {
    const res = await fetch(`/api/projects/${projectId}/env/request`, {
      cache: "no-store",
      signal,
    });
    if (res.status === 429) return rateLimitDelayMs(res);
    if (!res.ok) return;
    const data = await res.json() as {
      ok: boolean;
      pending: {
        id: string;
        target: "client" | "server";
        key: string;
        message: string | null;
        isSecret: boolean;
      } | null;
    };
    if (!signal.aborted && data.ok) {
      setPendingEnvVarRequest(data.pending);
    }
  }, 2500, sandboxStatus === "ready");

  // ── Agent-stop → dismiss pending OAuth request ────────────────────────
  // When the user clicks X while setupOAuthProvider is polling, we need to:
  //  1. Close the modal immediately.
  //  2. POST a dismiss to the DB so the server-side polling loop sees
  //     status='dismissed' on its next tick and returns instead of continuing
  //     to poll for another 5 minutes.
  useEffect(() => {
    const handleAgentStopped = () => {
      // Close modal immediately
      setPendingOAuthRequest((current) => {
        if (current) {
          // Fire-and-forget dismiss — non-fatal if it fails
          fetch(`/api/projects/${projectId}/convex/setup-oauth-provider`, {
            method: "DELETE",
          }).catch(() => {});
        }
        return null;
      });
      setPendingStripeRequest((current) => {
        if (current) {
          fetch(`/api/projects/${projectId}/stripe/connect-request`, {
            method: "DELETE",
          }).catch(() => {});
        }
        return null;
      });
      setPendingEnvVarRequest((current) => {
        if (current) {
          fetch(`/api/projects/${projectId}/env/request`, {
            method: "DELETE",
          }).catch(() => {});
        }
        return null;
      });
    };

    window.addEventListener("agent-user-stopped", handleAgentStopped);
    return () => window.removeEventListener("agent-user-stopped", handleAgentStopped);
  }, [projectId]);

  // ── Stripe-enabled poller ────────────────────────────────────────────
  // The agent's initializeStripePayments tool flips projects.stripe_enabled
  // server-side. On the OAuth path the user lands on this workspace with
  // ?stripe_connect=success and the effect below catches it — but on the
  // 'already-connected' path (user previously linked Stripe) there's no
  // navigation, just a tool result. Poll the project endpoint every 10s
  // while stripe is off so the tab appears without a manual refresh.
  // Once enabled, the poller stops (the enabled flag below guards it).
  // 10s (not 2-4s like the others): this GET hits the generic project
  // endpoint, which shares the interactive 'read' rate-limit budget rather
  // than a poll bucket — and it watches a rare one-shot flip, so slow is fine.
  useWorkspacePoll(async (signal) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      cache: "no-store",
      signal,
    });
    if (res.status === 429) return rateLimitDelayMs(res);
    if (!res.ok) return;
    const proj = await res.json();
    if (signal.aborted) return;
    if (proj?.stripeEnabled === true) {
      setStripeEnabled(true);
      if (proj.stripePaymentMode === "live" || proj.stripePaymentMode === "test") {
        setStripePaymentMode(proj.stripePaymentMode);
      }
    }
  }, 10_000, !stripeEnabled && sandboxStatus === "ready");

  // ── Stripe checkout iframe handoff ───────────────────────────────────
  // Stripe Checkout (and the Connect dashboard) refuse to load in an iframe.
  // The previewed app runs in our preview iframe, so the scaffolded
  // redirectToCheckout helper postMessages the URL up to us instead of
  // navigating. We validate it's an https *.stripe.com URL and show a card
  // with an "Open Checkout" button — clicking it is a top-level user gesture,
  // so the new tab isn't popup-blocked.
  //
  // OAuth (Google, GitHub, …) hits the same wall: the provider page refuses to
  // be framed, and a session completed in a popup wouldn't reach the framed app
  // anyway (storage partitioning). So the scaffolded startOAuthSignIn helper
  // posts botflow:open-auth, and we reopen the app itself in a new tab with
  // ?botflow_signin=<provider> so the flow runs — and the session lands — there.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: string; provider?: string } | null;
      if (!data || typeof data !== "object") return;

      if (data.type === "botflow:open-url" && typeof data.url === "string") {
        let parsed: URL;
        try {
          parsed = new URL(data.url);
        } catch {
          return;
        }
        // Only ever surface Stripe URLs — never a popup to an arbitrary origin.
        if (parsed.protocol !== "https:") return;
        if (parsed.host !== "stripe.com" && !parsed.host.endsWith(".stripe.com")) return;
        setCheckoutHandoffUrl(parsed.toString());
        return;
      }

      if (data.type === "botflow:open-auth" && typeof data.provider === "string") {
        // The target tab is the app itself, so trust only messages coming from
        // the sandbox's own origin and build the URL from that origin — never
        // from attacker-supplied data.
        if (!e.origin.endsWith(".vercel.run") && !e.origin.startsWith("http://localhost")) return;
        // Provider ids are short slugs ("google", "github", …). Reject anything
        // that isn't, so it can't be smuggled into the query string.
        if (!/^[a-z0-9_-]{1,32}$/.test(data.provider)) return;
        let origin: string;
        try {
          origin = new URL(e.origin).origin;
        } catch {
          return;
        }
        setAuthHandoff({
          provider: data.provider,
          url: origin + "/?botflow_signin=" + encodeURIComponent(data.provider),
        });
        return;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // ── Stripe OAuth success — react to ?stripe_connect=success ──────────
  // The OAuth callback redirects here after the user authorizes. Reload
  // project state so stripeEnabled flips and the Stripe tab appears.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const status = url.searchParams.get("stripe_connect");
    if (status !== "success") return;
    const mode = url.searchParams.get("mode");
    if (mode === "live" || mode === "test") setStripePaymentMode(mode);
    setStripeEnabled(true);
    setCurrentView("stripe");
    // Clear the param so a refresh doesn't keep re-flipping the tab.
    url.searchParams.delete("stripe_connect");
    url.searchParams.delete("mode");
    url.searchParams.delete("accountId");
    window.history.replaceState({}, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Stripe Connect request polling ───────────────────────────────────
  // Mirrors the Google OAuth poll above. The agent's initializeStripePayments
  // tool creates a pending row; we render the Connect modal when one exists.
  // Stops polling once the request resolves (server flips status), at which
  // point the response shape returns pending=null and we clear the modal.
  useWorkspacePoll(async (signal) => {
    const res = await fetch(
      `/api/projects/${projectId}/stripe/connect-request`,
      { cache: "no-store", signal },
    );
    if (res.status === 429) return rateLimitDelayMs(res);
    if (!res.ok) return;
    const data = (await res.json()) as {
      ok: boolean;
      pending: {
        id: string;
        mode: "test" | "live";
        authorizeUrl: string;
      } | null;
    };
    if (!signal.aborted && data.ok) {
      setPendingStripeRequest(data.pending);
    }
  }, 2500, hasBackend && sandboxStatus === "ready");

  // ── Agent working state (from AgentPanel's custom event) ─────────────
  // isInitialBuild latches on while the agent's FIRST turn runs and releases
  // when it ends — the preview veils itself only during that window.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { isBusy?: boolean; isFirstTurn?: boolean }
        | undefined;
      if (!detail) return;
      setIsAgentWorking(Boolean(detail.isBusy));
      setIsInitialBuild(Boolean(detail.isBusy && detail.isFirstTurn));
    };
    window.addEventListener("agent-busy-change", handler);
    return () => window.removeEventListener("agent-busy-change", handler);
  }, []);

  // ── Dev server ───────────────────────────────────────────────────────
  const handleStartDevServer = useCallback(async () => {
    if (isStartingServer) return;
    setIsStartingServer(true);
    try {
      // installFirst=true on every click is fine — pnpm short-circuits when
      // the lockfile is satisfied and node_modules already exist.
      const res = await fetch(`/api/projects/${projectId}/sandbox/devserver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: 5173, installFirst: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The route returns either { error, log } (timeout) or { error, stdout, stderr } (install fail)
        const detail = body.log
          ? `${body.error}\n\nLast log:\n${body.log}`
          : body.stderr
            ? `${body.error}\n\n${body.stderr}`
            : body.message || body.error || "Failed to start dev server";
        throw new Error(detail);
      }
      const { previewUrl, port, responseHeaders } = body as {
        previewUrl: string;
        port: number;
        responseHeaders?: Record<string, string>;
      };
      // Surface the proxy's response headers so we can diagnose iframe-blocking
      // directives (X-Frame-Options, CSP frame-ancestors, COEP/COOP, etc.) at
      // a glance. If the iframe shows "refused to connect", these tell us why.
      // Log each header on its own line so Chrome's console shows them flat
      // (logging the object alone makes it collapse to "Object").
      if (responseHeaders) {
        // eslint-disable-next-line no-console
        console.log("[botflow] === sandbox response headers ===");
        for (const [k, v] of Object.entries(responseHeaders)) {
          // eslint-disable-next-line no-console
          console.log(`  ${k}: ${v}`);
        }
        // eslint-disable-next-line no-console
        console.log("[botflow] === end headers ===");

        const blockers: string[] = [];
        if (responseHeaders["x-frame-options"]) {
          blockers.push(`X-Frame-Options: ${responseHeaders["x-frame-options"]}`);
        }
        const csp = responseHeaders["content-security-policy"];
        if (csp && csp.includes("frame-ancestors")) {
          blockers.push(`CSP frame-ancestors: ${csp}`);
        }
        if (blockers.length) {
          console.warn("[botflow] iframe-blocking headers detected:", blockers);
        }
      }
      setPreviews([{ port, ready: true, baseUrl: previewUrl }]);
      setActivePreviewIndex(0);
      setIsDevServerRunning(true);
      setPreviewReloadKey((k) => k + 1);
      setCurrentView("preview");
    } catch (err) {
      const description = err instanceof Error ? err.message : String(err);
      toast({ title: "Dev server failed to start", description: description.slice(0, 800) });
      console.error("Dev server start failed:", description);
    } finally {
      setIsStartingServer(false);
    }
  }, [projectId, isStartingServer, toast]);

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex bolt-bg text-fg">
      {/* OAuth credential modal — shown when agent calls setupOAuthProvider */}
      {pendingOAuthRequest && (
        <OAuthProviderModal
          requestId={pendingOAuthRequest.id}
          provider={pendingOAuthRequest.provider}
          convexSiteUrl={pendingOAuthRequest.convexSiteUrl}
          projectId={projectId}
          onClose={() => setPendingOAuthRequest(null)}
        />
      )}
      {/* Stripe Connect modal — shown when agent calls initializeStripePayments */}
      {pendingStripeRequest && (
        <StripeConnectModal
          requestId={pendingStripeRequest.id}
          projectId={projectId}
          mode={pendingStripeRequest.mode}
          authorizeUrl={pendingStripeRequest.authorizeUrl}
          onClose={() => setPendingStripeRequest(null)}
        />
      )}
      {/* Env-var entry modal — shown when agent calls requestEnvVar */}
      {pendingEnvVarRequest && (
        <EnvVarModal
          requestId={pendingEnvVarRequest.id}
          projectId={projectId}
          target={pendingEnvVarRequest.target}
          envKey={pendingEnvVarRequest.key}
          message={pendingEnvVarRequest.message}
          isSecret={pendingEnvVarRequest.isSecret}
          onClose={() => setPendingEnvVarRequest(null)}
        />
      )}
      {checkoutHandoffUrl && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] w-[min(440px,calc(100vw-2rem))] rounded-xl border border-border bg-neutral-900 text-white shadow-2xl">
          <div className="px-4 py-3 space-y-2.5">
            <div className="text-sm font-medium">Open Stripe Checkout in a new tab</div>
            <p className="text-xs leading-relaxed text-neutral-300">
              Stripe Checkout can&apos;t load inside the preview window. Click below to
              open it in a new tab. (In your published app it opens normally —
              this only happens in the preview.)
            </p>
            <div className="flex items-center justify-end gap-2 pt-0.5">
              <button
                onClick={() => setCheckoutHandoffUrl(null)}
                className="text-xs font-medium px-3 py-1.5 rounded-md text-neutral-300 hover:bg-white/10 transition-colors"
              >
                Dismiss
              </button>
              <button
                onClick={() => {
                  window.open(checkoutHandoffUrl, "_blank", "noopener,noreferrer");
                  setCheckoutHandoffUrl(null);
                }}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-accent text-accent-foreground hover:opacity-90 transition-opacity"
              >
                Open Checkout
                <ExternalLink size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
      {authHandoff && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] w-[min(440px,calc(100vw-2rem))] rounded-xl border border-border bg-neutral-900 text-white shadow-2xl">
          <div className="px-4 py-3 space-y-2.5">
            <div className="text-sm font-medium">Finish signing in in a new tab</div>
            <p className="text-xs leading-relaxed text-neutral-300">
              Sign-in can&apos;t complete inside the preview window. Click below to
              open your app in a new tab and continue — you&apos;ll be signed in
              there. (In your published app it works normally; this only happens
              in the preview.)
            </p>
            <div className="flex items-center justify-end gap-2 pt-0.5">
              <button
                onClick={() => setAuthHandoff(null)}
                className="text-xs font-medium px-3 py-1.5 rounded-md text-neutral-300 hover:bg-white/10 transition-colors"
              >
                Dismiss
              </button>
              <button
                onClick={() => {
                  window.open(authHandoff.url, "_blank", "noopener,noreferrer");
                  setAuthHandoff(null);
                }}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-accent text-accent-foreground hover:opacity-90 transition-opacity"
              >
                Open app
                <ExternalLink size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Agent sidebar. Hold the initial prompt until the sandbox is ready —
          otherwise the agent fires its first turn against an empty filesystem
          while the seed is still cloning, and tools fail. */}
      <div className="w-96 flex flex-col bg-elevated/70 backdrop-blur-sm">
        <AgentPanel
          className="h-full"
          projectId={projectId}
          initialPrompt={sandboxStatus === "ready" ? initialPrompt : undefined}
          platform="sandboxed-web"
        />
      </div>

      {/* Main column */}
      <div className="flex-1 flex flex-col">
        {bootError && (
          <div className="px-4 py-2 bg-red-900/80 border-b border-red-700 text-white text-xs flex items-center gap-3">
            <span className="font-semibold">Sandbox failed to start</span>
            <span className="opacity-80 flex-1 truncate">{bootError}</span>
            <button
              onClick={() => void bootSandbox()}
              className="px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-white text-xs font-medium"
            >
              Retry
            </button>
          </div>
        )}

        {/* Header */}
        <div className="h-12 flex items-center pr-2.5 gap-4 bg-surface backdrop-blur-sm">
          <Tabs
            options={
              [
                { value: "preview", text: "Preview" },
                { value: "code", text: "Code" },
                ...(hasBackend
                  ? [{ value: "database" as const, text: "Database" }]
                  : []),
                ...(stripeEnabled
                  ? [{ value: "stripe" as const, text: "Stripe" }]
                  : []),
              ] as TabOption<WorkspaceView>[]
            }
            selected={currentView}
            onSelect={setCurrentView}
          />

          {currentView === "stripe" && (
            <StripeModeToggle
              projectId={projectId}
              mode={stripePaymentMode}
              busy={stripeModeToggling}
              onToggle={async (next) => {
                if (next === stripePaymentMode || stripeModeToggling) return;
                setStripeModeToggling(true);
                try {
                  const res = await fetch(`/api/projects/${projectId}/stripe/mode`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ mode: next }),
                  });
                  const data = await res.json() as { ok: boolean; status?: string; authorizeUrl?: string; mode?: string; error?: string };
                  if (data.ok && (data.mode === "test" || data.mode === "live")) {
                    setStripePaymentMode(data.mode);
                    toast({ title: `Switched to ${data.mode} mode` });
                  } else if (data.status === "needs-connect" && data.authorizeUrl) {
                    toast({ title: `Connect Stripe in ${next} mode`, description: "Opening Stripe authorization…" });
                    window.open(data.authorizeUrl, "_blank");
                  } else {
                    toast({ title: "Mode switch failed", description: data.error ?? "Unknown error" });
                  }
                } finally {
                  setStripeModeToggling(false);
                }
              }}
            />
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={handleStartDevServer}
            disabled={isStartingServer || sandboxStatus !== "ready"}
            className={cn(
              "flex items-center gap-2 font-bold text-md",
              isDevServerRunning
                ? "text-green-400 hover:text-green-300 hover:bg-green-400/10"
                : "text-green-400 hover:text-green-300 hover:bg-green-400/10",
            )}
            title={isDevServerRunning ? "Restart dev server" : "Start dev server"}
          >
            {isStartingServer ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Play size={16} fill="currentColor" />
            )}
            <span>
              {isStartingServer
                ? "Starting..."
                : isDevServerRunning
                  ? "Restart"
                  : "Start"}
            </span>
          </Button>

          {currentView === "code" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSidebar(!showSidebar)}
              className="text-muted hover:text-fg bolt-hover"
              title={showSidebar ? "Hide explorer" : "Show explorer"}
            >
              <PanelLeft size={16} />
            </Button>
          )}

          {currentView === "code" && selectedFile && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted">/</span>
              <span className="text-fg font-medium bg-elevated/70 px-2 py-1 rounded flex items-center gap-2">
                {selectedFile.split("/").pop()}
                {hasUnsavedChanges && (
                  <span
                    className="w-2 h-2 rounded-full bg-orange-500"
                    title="Unsaved changes"
                  />
                )}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSaveFile}
                className="text-muted hover:text-fg bolt-hover"
                title="Save file"
              >
                <Save size={16} />
                <span className="ml-1">Save</span>
              </Button>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            {currentView === "database" && hasBackend && (
              <button
                onClick={() => window.open(`/workspace/${projectId}/database`, "_blank")}
                className="flex items-center gap-1.5 text-sm text-muted hover:text-fg border border-border rounded-md px-3 py-1 bolt-hover"
                title="Open database in new tab"
              >
                <ArrowUpRight size={14} />
                Open in new tab
              </button>
            )}
            {currentView === "preview" && (
              <button
                onClick={() => setEditMode((v) => !v)}
                className={cn(
                  "flex items-center gap-1.5 text-sm border rounded-full px-3 py-1 transition-colors",
                  editMode
                    ? "border-accent text-accent bg-accent/10"
                    : "border-border text-muted hover:text-fg",
                )}
                title="Toggle visual edit mode"
              >
                <MousePointer2 size={15} />
                Edit
              </button>
            )}
            {currentView === "preview" && (
              <div className="flex items-center gap-2 border border-border rounded-full px-3 py-1 min-w-[220px]">
                <button
                  onClick={() =>
                    setPreviewDevice((prev) =>
                      prev === "desktop"
                        ? "tablet"
                        : prev === "tablet"
                          ? "mobile"
                          : prev === "mobile"
                            ? "responsive"
                            : prev === "responsive"
                              ? "figma"
                              : "desktop",
                    )
                  }
                  className="text-muted hover:text-fg"
                  title={`Device: ${previewDevice}`}
                >
                  {previewDevice === "desktop" && <Monitor size={16} />}
                  {previewDevice === "tablet" && <Tablet size={16} />}
                  {previewDevice === "mobile" && <Smartphone size={16} />}
                  {previewDevice === "responsive" && <AppWindow size={16} />}
                  {previewDevice === "figma" && <Frame size={16} />}
                </button>
                <Input
                  className="flex-1 bg-transparent outline-none text-sm text-fg placeholder:text-muted"
                  value={previewPath}
                  onChange={(e) => setPreviewPath(e.target.value)}
                  placeholder="/"
                />
                <button
                  onClick={() => {
                    const baseUrl = previews[activePreviewIndex]?.baseUrl;
                    if (!baseUrl) return;
                    const path = previewPath.startsWith("/")
                      ? previewPath
                      : "/" + previewPath;
                    window.open(
                      `/preview-popup?url=${encodeURIComponent(buildPreviewUrl(baseUrl, path))}`,
                      "_blank",
                    );
                  }}
                  className="text-muted hover:text-fg"
                  title="Open preview in new tab"
                >
                  <ArrowUpRight size={16} />
                </button>
                <button
                  onClick={() => setPreviewReloadKey((k) => k + 1)}
                  className="text-muted hover:text-fg"
                  title="Refresh preview"
                >
                  <RefreshCw size={15} />
                </button>
              </div>
            )}
            <UserButton />
            <div className="relative">
              <Button
                ref={publishBtnRef}
                variant="default"
                size="sm"
                className={cn(
                  "font-bold text-sm text-white",
                  cloudflareProjectName && "bg-green-600 hover:bg-green-700",
                )}
                onClick={() => setPublishOpen((v) => !v)}
                title={cloudflareProjectName ? "Manage deployment" : "Publish to Cloudflare Pages"}
              >
                <Globe size={14} className="mr-1.5" />
                {cloudflareProjectName ? "Published" : "Publish"}
              </Button>
              {cloudflareProjectName && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-green-500 border-2 border-surface pointer-events-none" />
              )}
            </div>
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 min-h-0 relative bg-surface">
          {/* Code view */}
          <div
            className={cn(
              "absolute inset-0",
              currentView === "code" ? "flex flex-col" : "hidden",
              "rounded-xl border border-border overflow-hidden",
            )}
          >
            <div className="flex-1 min-h-0 flex">
              {showSidebar && (
                <div className="w-80 bolt-border border-r flex flex-col backdrop-blur-sm">
                  <div className="p-2 bolt-border border-b">
                    <Tabs
                      options={
                        [
                          { value: "files", text: "Files" },
                          { value: "search", text: "Search" },
                          { value: "env", text: "ENV" },
                          { value: "git", text: "Git" },
                        ] as TabOption<"files" | "search" | "env" | "git">[]
                      }
                      selected={sidebarTab}
                      onSelect={(v) => setSidebarTab(v as "files" | "search" | "env" | "git")}
                      stretch
                    />
                  </div>
                  <div className="flex-1 overflow-auto modern-scrollbar">
                    {sidebarTab === "files" ? (
                      <FileTree
                        files={files}
                        selectedFile={selectedFile}
                        onFileSelect={handleFileSelect}
                      />
                    ) : sidebarTab === "search" ? (
                      <FileSearch
                        projectId={projectId}
                        onOpenFile={(path) => {
                          setCurrentView("code");
                          handleFileSelect(path);
                        }}
                      />
                    ) : sidebarTab === "env" ? (
                      <EnvPanel projectId={projectId} />
                    ) : (
                      <SandboxGitHubPanel
                        projectId={projectId}
                        githubRepoOwner={githubRepoOwner}
                        githubRepoName={githubRepoName}
                        githubDefaultBranch={githubDefaultBranch}
                        onRepoLinked={(owner, name, branch) => {
                          setGithubRepoOwner(owner);
                          setGithubRepoName(name);
                          setGithubDefaultBranch(branch);
                        }}
                        onRepoUnlinked={() => {
                          setGithubRepoOwner(null);
                          setGithubRepoName(null);
                          setGithubDefaultBranch(null);
                        }}
                      />
                    )}
                  </div>
                </div>
              )}
              <div className="flex-1 min-h-0 relative">
                <div className="absolute inset-0 bg-elevated/90 backdrop-blur-sm">
                  {imageBlobUrl ? (
                    <ImageViewer
                      src={imageBlobUrl}
                      filename={selectedFile ?? ""}
                      byteLength={imageByteLength}
                    />
                  ) : (
                    <CodeEditor
                      value={fileContent}
                      onChange={handleContentChange}
                      language={getLanguageFromFilename(selectedFile || "")}
                      filename={selectedFile}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Terminal — always mounted, persists across tab switches.
                Wired to the sandbox via /api/projects/:id/sandbox/exec. */}
            <div className="h-64 bolt-border border-t bg-elevated backdrop-blur-sm">
              <PersistentTerminal projectId={projectId} ready={sandboxStatus === "ready"} />
            </div>
          </div>

          {/* Database view */}
          {currentView === "database" && hasBackend && (
            <div className="absolute inset-0 pb-2.5 pr-2.5">
              <div className="w-full h-full rounded-xl border border-border overflow-hidden">
                <ConvexDashboard projectId={projectId} />
              </div>
            </div>
          )}

          {/* Stripe view */}
          {currentView === "stripe" && stripeEnabled && (
            <div className="absolute inset-0 pr-2.5 pb-2.5">
              <StripeTab
                projectId={projectId}
                mode={stripePaymentMode}
                onOpenFullDashboard={async () => {
                  try {
                    const secretRes = await fetch(`/api/projects/${projectId}`);
                    const proj = await secretRes.json();
                    const secret = proj?.stripeWebhookSecret as string | undefined;
                    if (!secret) {
                      toast({ title: "Couldn't open dashboard", description: "Project secret missing." });
                      return;
                    }
                    const res = await fetch(`/api/projects/${projectId}/stripe/dashboard-link`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json", "X-Botflow-Project-Secret": secret },
                      body: "{}",
                    });
                    const data = await res.json() as { url?: string; error?: string };
                    if (data.url) window.open(data.url, "_blank");
                    else toast({ title: "Couldn't open dashboard", description: data.error ?? "Unknown error" });
                  } catch (err) {
                    toast({ title: "Couldn't open dashboard", description: err instanceof Error ? err.message : String(err) });
                  }
                }}
                onDisconnected={(disconnectedMode) => {
                  // The disconnected mode is no longer linked. If it's the mode
                  // this project is on, the tab can't load anymore — flip Stripe
                  // off and leave the tab so the user can re-connect.
                  if (disconnectedMode === stripePaymentMode) {
                    setStripeEnabled(false);
                    setCurrentView("preview");
                  }
                  toast({
                    title: "Stripe disconnected",
                    description: `Your Stripe account was disconnected from ${disconnectedMode} mode.`,
                  });
                }}
              />
            </div>
          )}

          {/* Preview view */}
          <div
            className={cn(
              "absolute inset-0 pb-2.5 pr-2.5",
              currentView === "preview" ? "block" : "hidden",
            )}
          >
            <Preview
              previews={previews}
              activePreviewIndex={activePreviewIndex}
              onActivePreviewChange={setActivePreviewIndex}
              showHeader={false}
              currentPath={previewPath}
              selectedDevice={previewDevice}
              isLandscape={false}
              reloadKey={previewReloadKey}
              isDevServerRunning={isDevServerRunning}
              isInstalling={false}
              isStartingServer={isStartingServer}
              onToggleDevServer={handleStartDevServer}
              platform="sandboxed-web"
              projectId={projectId}
              htmlSnapshotUrl={htmlSnapshotUrl}
              isAgentWorking={isAgentWorking}
              isInitialBuild={isInitialBuild}
              editMode={editMode}
              onElementSelected={(sel) => {
                if (sel) {
                  console.log("[visual-editor] selected:", sel.tag, sel.loc, sel);
                }
              }}
            />
          </div>
        </div>
      </div>

      <SandboxPublishPanel
        projectId={projectId}
        isOpen={publishOpen}
        onClose={() => setPublishOpen(false)}
        anchorRef={publishBtnRef}
        cloudflareProjectName={cloudflareProjectName}
        cloudflareDeploymentUrl={cloudflareDeploymentUrl}
        isPublic={isPublic}
        publicSlug={publicSlug}
        publicDescription={publicDescription}
        onPublicChanged={(next, slug) => {
          setIsPublic(next);
          if (slug !== undefined) setPublicSlug(slug);
        }}
        onPublished={(name, url) => {
          setCloudflareProjectName(name || cloudflareProjectName);
          setCloudflareDeploymentUrl(url);
        }}
        onUnpublished={() => {
          setCloudflareProjectName(null);
          setCloudflareDeploymentUrl(null);
        }}
        canUseCustomDomain={canUseCustomDomain}
        managedDomainsEnabled={managedDomainsEnabled}
        managedDomainId={managedDomainId}
        managedDomainHostname={managedDomainHostname}
        onManagedDomainChanged={(id, host) => {
          setManagedDomainId(id);
          setManagedDomainHostname(host);
        }}
        customDomain={customDomain}
        customDomainStatus={customDomainStatus}
        onCustomDomainChanged={(d, s) => {
          setCustomDomain(d);
          setCustomDomainStatus(s);
        }}
      />
    </div>
  );
}

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    jsx: "javascript",
    tsx: "typescript",
    json: "json",
    md: "markdown",
    html: "html",
    css: "css",
    scss: "scss",
    py: "python",
    rb: "ruby",
    php: "php",
    java: "java",
    cpp: "cpp",
    c: "c",
    go: "go",
    rs: "rust",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
    sql: "sql",
  };
  return map[ext || ""] || "plaintext";
}
