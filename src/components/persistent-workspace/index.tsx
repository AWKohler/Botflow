"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useToast } from "@/components/ui/toast";
import { CodeEditor } from "@/components/workspace/code-editor";
import { FileTree } from "@/components/workspace/file-tree";
import { EnvPanel } from "@/components/workspace/env-panel";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { Button } from "@/components/ui/button";
import { Tabs, TabOption } from "@/components/ui/tabs";
import { UserButton } from "@clerk/nextjs";
import { cn } from "@/lib/utils";
import { FileSearch } from "./file-search";
import { SwiftSimulatorPreview } from "./swift-simulator-preview";
import { SwiftPipWindow } from "./swift-pip-window";
import { IPhoneDeviceRunner } from "./iphone-device-runner";
import { PublishToAppStore } from "./publish-to-app-store";
import { ConvexDashboard } from "@/components/convex/ConvexDashboard";
import { RevenueCatTab } from "./revenuecat-tab";
import { REVENUECAT_ENABLED } from "@/lib/feature-flags";
import { PanelLeft, Play, Save, Loader2, Database, Rocket, Smartphone, Tablet, RotateCw, ArrowUpRight, Globe } from "lucide-react";
import type { ProjectPlatform } from "@/lib/project-platform";
import { DeviceFrame, type DeviceModelUI, type OrientationUI } from "./device-frame";
import {
  loadDevicePref,
  saveDevicePref,
  loadOrientationPref,
  saveOrientationPref,
} from "./swift-preview-prefs";

const PersistentTerminal = dynamic(
  () => import("./terminal").then((m) => m.PersistentTerminal),
  { ssr: false, loading: () => <div className="h-full w-full bg-elevated" /> },
);

type WorkspaceView = "preview" | "code" | "database" | "revenuecat";
type SandboxStatus = "idle" | "booting" | "ready" | "error";
type FileEntry = { type: "file" | "folder" };

// Minimal project row shape the workspace needs for backend awareness.
type ProjectRow = {
  name: string;
  platform: string;
  backendType: string;
  convexDeployUrl: string | null;
  userConvexUrl: string | null;
  revenuecatStatus?: string;
  swiftScreenshotIphoneUrl?: string | null;
  swiftScreenshotIpadUrl?: string | null;
};

interface PersistentWorkspaceProps {
  projectId: string;
  initialPrompt?: string;
  platform?: ProjectPlatform;
}

export function PersistentWorkspace({
  projectId,
  initialPrompt,
  platform,
}: PersistentWorkspaceProps) {
  const { toast } = useToast();

  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus>("idle");
  const [bootError, setBootError] = useState<string | null>(null);

  const [files, setFiles] = useState<Record<string, FileEntry>>({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<"files" | "search" | "env">("files");
  const [currentView, setCurrentView] = useState<WorkspaceView>("code");
  // When a build-error row is clicked, we open the file and ask the editor to
  // reveal a specific line. The counter is bumped on every click so that
  // re-clicking the SAME row still triggers a reveal (Monaco won't otherwise
  // re-run a reveal if the line number didn't change).
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const [revealNonce, setRevealNonce] = useState(0);

  // ── Preview Stop/Play ───────────────────────────────────────────────────
  // The simulator NEVER starts on its own — compiling and simulator slots are
  // expensive and Swift has no HMR, so there's nothing to keep warm. Every
  // mount (new project, re-open, refresh) starts stopped; the session only
  // provisions when the user presses Play or the agent requests a start via
  // the simulator tools.
  const [previewStopped, setPreviewStopped] = useState<boolean>(true);

  const initializedRef = useRef(false);

  // "Publish to App Store" wizard (Swift projects only). The component stays
  // mounted while the workspace lives so wizard state survives close/reopen.
  const [publishOpen, setPublishOpen] = useState(false);

  // Project row (fetched client-side) — drives backend-aware UI. Null until loaded.
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [deployingBackend, setDeployingBackend] = useState(false);
  const hasBackend = project != null && project.backendType !== "none";
  const backendProvisioned =
    project != null && Boolean(project.convexDeployUrl || project.userConvexUrl);
  // RevenueCat (iOS in-app purchases) — requires a Convex backend.
  const revenuecatStatus =
    (project?.revenuecatStatus as "none" | "connecting" | "connected" | undefined) ?? "none";
  const revenuecatEnabled = REVENUECAT_ENABLED && hasBackend && revenuecatStatus !== "none";

  const refreshFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/sandbox/files`);
      if (!res.ok) return;
      const data = await res.json() as { files: Record<string, FileEntry> };
      setFiles(data.files ?? {});
    } catch (e) {
      console.warn("Failed to load files", e);
    }
  }, [projectId]);

  const refreshProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (res.ok) setProject((await res.json()) as ProjectRow);
    } catch (e) {
      console.warn("Failed to load project", e);
    }
  }, [projectId]);

  // Load the project row once on mount so we know platform/backendType.
  useEffect(() => {
    void refreshProject();
  }, [refreshProject]);

  // ── Agent simulator requests ────────────────────────────────────────────
  // The agent's startSimulator/stopSimulator tools publish a short-lived
  // desired action to Redis (it can't own the stream — this browser does).
  // Poll for it while the workspace is open and honor it. The GET consumes
  // the action server-side, so it fires exactly once.
  useEffect(() => {
    if (platform !== "swift") return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/swift-preview/state`, {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          desired: { action: "start" | "stop"; requestedAt: number } | null;
        };
        if (cancelled || !data.desired) return;
        if (data.desired.action === "start") {
          setPreviewStopped(false);
          setCurrentView("preview");
        } else {
          setPreviewStopped(true);
          // Pick up the screenshot the unmounting preview just uploaded.
          for (const ms of [1000, 3000, 7000]) {
            setTimeout(() => void refreshProject(), ms);
          }
        }
      } catch {
        // Network blip — next tick catches up.
      }
    };

    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [platform, projectId, refreshProject]);

  // Deploy the Convex backend (zips /convex, pushes to the worker; auto-
  // provisions a platform backend on first call). `silent` is used by the
  // one-time provision-on-mount so we don't spam toasts.
  const deployBackend = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      setDeployingBackend(true);
      if (!silent) {
        toast({ title: "Deploying backend…", description: "Pushing your Convex functions." });
      }
      try {
        const res = await fetch(`/api/projects/${projectId}/convex/deploy`, { method: "POST" });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean; message?: string; error?: string;
        };
        if (!res.ok || body.ok === false) {
          throw new Error(body.message || body.error || `HTTP ${res.status}`);
        }
        await refreshProject();
        if (!silent) {
          toast({
            title: "Backend deployed",
            description: "Rebuild the preview to connect to the latest backend.",
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Deploy failed";
        if (!silent) toast({ title: "Backend deploy failed", description: msg });
        else console.warn("[swift backend auto-provision]", msg);
      } finally {
        setDeployingBackend(false);
      }
    },
    [projectId, refreshProject, toast],
  );

  // One-time provision-on-mount: once the sandbox is seeded and we know this is
  // a Swift project with a backend that has never been provisioned, deploy it
  // once so the first preview connects to a live deployment.
  const autoProvisionRef = useRef(false);
  useEffect(() => {
    if (autoProvisionRef.current) return;
    if (sandboxStatus !== "ready") return;
    if (!project || project.platform !== "swift" || project.backendType === "none") return;
    if (project.convexDeployUrl || project.userConvexUrl) return; // already provisioned
    autoProvisionRef.current = true;
    void deployBackend({ silent: true });
  }, [sandboxStatus, project, deployBackend]);

  // ── RevenueCat status poller ────────────────────────────────────────────────
  // The agent's initializeRevenueCatPayments tool flips revenuecat_status to
  // 'connecting' server-side. Poll the project row while it's still 'none' so the
  // Payments tab appears without a manual refresh. Stops once non-'none'.
  useEffect(() => {
    if (!REVENUECAT_ENABLED || !hasBackend) return;
    if (revenuecatStatus !== "none") return;
    if (sandboxStatus !== "ready") return;
    const timer = setInterval(() => {
      void refreshProject();
    }, 4000);
    return () => clearInterval(timer);
  }, [hasBackend, revenuecatStatus, sandboxStatus, refreshProject]);

  // Auto-open the Payments tab once, only on the live none→connecting transition
  // (when the agent just enabled it). Opening an already-connected project must
  // NOT yank the view, so we baseline from the first real project load.
  const prevRcStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!project) return;
    const now = (project.revenuecatStatus as string | undefined) ?? "none";
    if (prevRcStatusRef.current === null) {
      prevRcStatusRef.current = now; // baseline on first load — no auto-open
      return;
    }
    if (prevRcStatusRef.current === "none" && now === "connecting") {
      setCurrentView("revenuecat");
    }
    prevRcStatusRef.current = now;
  }, [project]);

  // Boot sandbox + seed + load files
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    let cancelled = false;
    (async () => {
      setSandboxStatus("booting");
      setBootError(null);
      try {
        const sessionRes = await fetch(`/api/projects/${projectId}/sandbox/session`, { method: "POST" });
        if (!sessionRes.ok) throw new Error(await sessionRes.text() || "Failed to start sandbox");
        if (cancelled) return;

        const seedRes = await fetch(`/api/projects/${projectId}/sandbox/seed`, { method: "POST" });
        if (seedRes.ok) {
          const { seeded } = await seedRes.json() as { seeded: boolean };
          if (seeded) toast({ title: "Project initialized", description: "Seeded the starter template." });
        }
        if (cancelled) return;

        await refreshFiles();
        if (cancelled) return;
        setSandboxStatus("ready");
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to start sandbox";
        setBootError(msg);
        setSandboxStatus("error");
        toast({ title: "Sandbox error", description: msg });
      }
    })();

    return () => { cancelled = true; };
  }, [projectId, refreshFiles, toast]);

  const handleFileSelect = useCallback(async (filePath: string) => {
    if (files[filePath]?.type !== "file") return;
    try {
      const res = await fetch(`/api/projects/${projectId}/sandbox/files?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        toast({ title: "Failed to read file", description: await res.text() });
        return;
      }
      const data = await res.json() as { content: string; binary: boolean };
      if (data.binary) {
        toast({ title: "Binary file", description: "Binary files cannot be edited here." });
        return;
      }
      setSelectedFile(filePath);
      setFileContent(data.content);
      setHasUnsavedChanges(false);
    } catch (e) {
      console.error("Failed to read file:", e);
    }
  }, [projectId, files, toast]);

  /** Click-to-jump from the build Issues panel. Open the file in the editor
   * and ask Monaco to reveal `line`. Includes a path normalization step so
   * diagnostics emitted as `Sources/Foo.swift` match our file map's keys
   * (which start with `/`). */
  const handleOpenFromIssues = useCallback(
    async (path: string, line: number): Promise<void> => {
      // Diagnostic paths are project-relative without a leading slash; the
      // file map keys are absolute-style. Try both.
      const candidates = [path.startsWith("/") ? path : `/${path}`, path];
      const target = candidates.find((p) => files[p]?.type === "file") ?? candidates[0];
      setCurrentView("code");
      await handleFileSelect(target);
      setRevealLine(line);
      setRevealNonce((n) => n + 1);
    },
    [files, handleFileSelect],
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
      toast({ title: "Save failed", description: err instanceof Error ? err.message : "Unknown error" });
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

  // Warn before leaving (tab close / refresh / external navigation) when the
  // open file has unsaved edits, so work isn't lost. The listener is only armed
  // while changes are pending, so there's no prompt during normal navigation.
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = ""; // Chrome requires returnValue to be set to show the prompt
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedChanges]);

  return (
    <div className="h-screen flex bolt-bg text-fg">
      {/* Agent sidebar */}
      <div className="w-96 flex flex-col bg-elevated/70 backdrop-blur-sm">
        <AgentPanel
          className="h-full"
          projectId={projectId}
          initialPrompt={initialPrompt}
          platform={platform ?? "swift"}
        />
      </div>

      {/* Main column */}
      <div className="flex-1 flex flex-col">
        {bootError && (
          <div className="px-4 py-2 bg-red-900/80 border-b border-red-700 text-white text-xs flex items-center gap-3">
            <span className="font-semibold">Sandbox failed to start</span>
            <span className="opacity-80">{bootError}</span>
          </div>
        )}

        {/* Header */}
        <div className="h-12 flex items-center pr-2.5 gap-4 bg-surface backdrop-blur-sm">
          <Tabs
            options={
              [
                { value: "preview", text: "Preview" },
                { value: "code", text: "Code" },
                ...(hasBackend ? [{ value: "database", text: "Database" }] : []),
                ...(revenuecatEnabled ? [{ value: "revenuecat", text: "Payments" }] : []),
              ] as TabOption<WorkspaceView>[]
            }
            selected={currentView}
            onSelect={setCurrentView}
          />

          {currentView === "code" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSidebar((v) => !v)}
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
                  <span className="w-2 h-2 rounded-full bg-orange-500" title="Unsaved changes" />
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
            <div className="text-xs text-muted flex items-center gap-1.5 px-2 py-1 rounded-md bg-elevated">
              {sandboxStatus === "booting" ? (
                <>
                  <Loader2 size={12} className="animate-spin text-blue-500" />
                  <span>Booting sandbox…</span>
                </>
              ) : sandboxStatus === "ready" ? (
                <>
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  <span>Sandbox ready</span>
                </>
              ) : sandboxStatus === "error" ? (
                <>
                  <div className="w-2 h-2 rounded-full bg-red-500" />
                  <span>Sandbox error</span>
                </>
              ) : null}
            </div>

            {/* Convex Deploy + dashboard — Database tab only. Sits between the
                sandbox status indicator and the user button. */}
            {currentView === "database" && hasBackend && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void deployBackend()}
                  disabled={deployingBackend}
                  className="text-muted hover:text-fg"
                  title="Deploy Convex backend"
                >
                  {deployingBackend ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Rocket size={16} />
                  )}
                  <span className="ml-1">{deployingBackend ? "Deploying…" : "Deploy"}</span>
                </Button>
                <button
                  onClick={() => window.open(`/workspace/${projectId}/database`, "_blank")}
                  className="flex items-center gap-1.5 text-sm text-muted hover:text-fg border border-border rounded-md px-3 py-1 bolt-hover"
                  title="Open database in new tab"
                >
                  <ArrowUpRight size={14} />
                  Open in new tab
                </button>
              </>
            )}

            {/* Run on iPhone — Preview tab only, left of the user button. */}
            {platform === "swift" && currentView === "preview" && (
              <IPhoneDeviceRunner projectId={projectId} />
            )}

            <UserButton
              afterSignOutUrl="/"
              appearance={{ elements: { userButtonAvatarBox: "w-8 h-8" } }}
            />

            <Button
              variant="default"
              size="sm"
              className="font-bold text-sm text-white"
              onClick={() =>
                platform === "swift"
                  ? setPublishOpen(true)
                  : toast({ title: "Coming soon", description: "Publishing for persistent projects isn't available yet." })
              }
              title={platform === "swift" ? "Publish to App Store" : "Publish (coming soon)"}
            >
              <Globe size={14} className="mr-1.5" />
              Publish
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 relative bg-surface">
          {/* Code view — inset 10px from the bottom/right to match the
              Preview/Database/Payments cards (which use `pb-2.5 pr-2.5`); flush
              to the header (top) and agent sidebar (left). */}
          <div
            className={cn(
              "absolute top-0 left-0 right-2.5 bottom-2.5",
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
                        ] as TabOption<"files" | "search" | "env">[]
                      }
                      selected={sidebarTab}
                      onSelect={(v) => setSidebarTab(v as "files" | "search" | "env")}
                      stretch
                    />
                  </div>
                  <div className="flex-1 overflow-auto modern-scrollbar">
                    {sidebarTab === "files" ? (
                      sandboxStatus === "booting" ? (
                        <div className="flex items-center justify-center py-8 text-muted text-xs gap-2">
                          <Loader2 size={14} className="animate-spin" />
                          Loading files…
                        </div>
                      ) : (
                        <FileTree
                          files={files}
                          selectedFile={selectedFile}
                          onFileSelect={handleFileSelect}
                        />
                      )
                    ) : sidebarTab === "search" ? (
                      <FileSearch
                        projectId={projectId}
                        onOpenFile={(path) => {
                          setCurrentView("code");
                          handleFileSelect(path);
                        }}
                      />
                    ) : (
                      <EnvPanel projectId={projectId} />
                    )}
                  </div>
                </div>
              )}
              <div className="flex-1 min-h-0 relative">
                <div className="absolute inset-0 bg-elevated/90 backdrop-blur-sm">
                  {selectedFile ? (
                    <CodeEditor
                      value={fileContent}
                      onChange={handleContentChange}
                      language={getLanguageFromFilename(selectedFile)}
                      filename={selectedFile}
                      revealLine={revealLine ?? undefined}
                      revealNonce={revealNonce}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-muted text-sm">
                      {sandboxStatus === "ready"
                        ? "Select a file to edit"
                        : sandboxStatus === "booting"
                          ? "Booting sandbox…"
                          : "Sandbox not ready"}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Terminal */}
            <div className="h-64 bolt-border border-t bg-elevated backdrop-blur-sm">
              <PersistentTerminal projectId={projectId} ready={sandboxStatus === "ready"} />
            </div>
          </div>

          {/* Payments view — RevenueCat link-out / setup wizard (Convex backend
              required, so it only renders when revenuecatEnabled). */}
          {revenuecatEnabled && (
            <div
              className={cn(
                "absolute inset-0 pb-2.5 pr-2.5",
                currentView === "revenuecat" ? "block" : "hidden",
              )}
            >
              <div className="w-full h-full rounded-xl border border-border overflow-hidden bg-elevated/60">
                <RevenueCatTab
                  projectId={projectId}
                  status={revenuecatStatus === "connected" ? "connected" : "connecting"}
                  onChanged={() => void refreshProject()}
                />
              </div>
            </div>
          )}

          {/* Preview view — empty container.  The actual <SwiftSimulatorPreview/>
              is rendered ONCE below in a stable React-tree position so it stays
              mounted across tab switches (and survives drag in/out of PIP). */}
          {/* Database view — embedded Convex dashboard (reuses ConvexDashboard). */}
          {hasBackend && (
            <div
              className={cn(
                "absolute inset-0 pb-2.5 pr-2.5",
                currentView === "database" ? "block" : "hidden",
              )}
            >
              <div className="w-full h-full rounded-xl border border-border overflow-hidden bg-elevated/60">
                {backendProvisioned ? (
                  <ConvexDashboard projectId={projectId} />
                ) : (
                  <div className="flex flex-col items-center justify-center w-full h-full text-sm text-muted gap-3 px-6 text-center">
                    <Database size={22} />
                    <p className="text-fg font-semibold">Backend not provisioned yet</p>
                    <p className="max-w-xs">
                      Deploy your Convex backend to create the deployment and open the
                      database dashboard.
                    </p>
                    <Button
                      size="sm"
                      onClick={() => void deployBackend()}
                      disabled={deployingBackend}
                    >
                      {deployingBackend ? "Provisioning…" : "Provision & deploy backend"}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div
            className={cn(
              "absolute inset-0",
              currentView === "preview" ? "block" : "hidden",
            )}
          >
            {platform === "swift" ? (
              previewStopped ? (
                <StoppedPreviewPlaceholder
                  onPlay={() => setPreviewStopped(false)}
                  screenshots={{
                    iphone: project?.swiftScreenshotIphoneUrl ?? null,
                    ipad: project?.swiftScreenshotIpadUrl ?? null,
                  }}
                />
              ) : (
                // Empty slot — preview is in the persistent mount below.
                <div className="absolute inset-0 pb-2.5 pr-2.5" />
              )
            ) : (
              <div className="absolute inset-0 pb-2.5 pr-2.5">
                <div className="w-full h-full rounded-xl border border-border overflow-hidden bg-elevated/60 flex items-center justify-center">
                  <div className="text-center text-muted text-sm max-w-sm px-6">
                    <p className="text-fg font-semibold mb-2">No preview</p>
                    <p>
                      Persistent projects build remotely. Use the agent and terminal to
                      develop, then publish to your build target.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/*
            Persistent simulator preview mount. The React tree position of this
            element NEVER changes — that's what keeps the WS session alive when
            the user toggles Preview ↔ Code. Visual placement is CSS-driven:

              • currentView === "preview" : the wrapper fills the Preview slot
                (matching the empty-container layout above).
              • currentView === "code"    : the simulator renders inside a
                fixed-position SwiftPipWindow at the user's saved rect.

            Unmounting only happens when previewStopped flips true, at which
            point the existing cleanup effect DELETEs the session.
          */}
          {platform === "swift" && !previewStopped && (
            // Single render path. SwiftPipWindow stays at the same React tree
            // position; only its internal layout changes when `mode` flips
            // between "full" and "pip". That's what keeps the inner
            // <SwiftSimulatorPreview/> instance — and its WS session — alive
            // across tab switches.
            <SwiftPipWindow
              projectId={projectId}
              mode={currentView === "preview" ? "full" : "pip"}
            >
              <SwiftSimulatorPreview
                projectId={projectId}
                mode={currentView === "preview" ? "full" : "pip"}
                onOpenFile={handleOpenFromIssues}
                onStop={() => {
                  setPreviewStopped(true);
                  // The Stop grab uploads a fresh screenshot — refetch the
                  // project row a few times so the stopped placeholder picks it
                  // up even on a slow upload (toBlob + POST can outlast one
                  // fixed delay).
                  for (const ms of [1000, 3000, 7000]) {
                    setTimeout(() => void refreshProject(), ms);
                  }
                }}
                onExpand={() => setCurrentView("preview")}
                screenshots={{
                  iphone: project?.swiftScreenshotIphoneUrl ?? null,
                  ipad: project?.swiftScreenshotIpadUrl ?? null,
                }}
              />
            </SwiftPipWindow>
          )}
        </div>
      </div>

      {/* Publish to App Store wizard — Swift projects only. Always mounted (not
          gated on publishOpen) so an in-flight publish build keeps its state
          across close/reopen; polling pauses while closed and resumes on open. */}
      {platform === "swift" && (
        <PublishToAppStore
          projectId={projectId}
          projectName={project?.name ?? ""}
          open={publishOpen}
          onClose={() => setPublishOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Shown in the Preview tab when the simulator is stopped. Renders the actual
 * device bezel (switched-off / black screen) with a Play button on top, plus a
 * device + orientation picker — so the user can choose the device BEFORE the
 * session provisions. The selection is persisted (and read back by the live
 * preview on start), so the preview always comes up on the last-used device.
 */
function StoppedPreviewPlaceholder({
  onPlay,
  screenshots,
}: {
  onPlay: () => void;
  /** Last-seen simulator screenshots per device family. When present for the
   *  picked device, rendered blurred inside the bezel (instead of the black
   *  switched-off screen) to make Play feel like "resume". */
  screenshots?: { iphone?: string | null; ipad?: string | null };
}) {
  const [device, setDevice] = useState<DeviceModelUI>(loadDevicePref);
  const [orientation, setOrientation] = useState<OrientationUI>(loadOrientationPref);
  const screenshotUrl =
    device === "iPad-Pro" ? screenshots?.ipad : screenshots?.iphone;

  const pickDevice = (d: DeviceModelUI): void => {
    if (d === device) return;
    setDevice(d);
    saveDevicePref(d);
    // Match the live preview's switchDevice(): both devices come up portrait,
    // landscape is reached via the toggle. Keeps the placeholder and the running
    // preview consistent so a session never starts in an unexpected orientation.
    setOrientation("portrait");
    saveOrientationPref("portrait");
  };
  const toggleOrientation = (): void => {
    const next: OrientationUI = orientation === "portrait" ? "landscape" : "portrait";
    setOrientation(next);
    saveOrientationPref(next);
  };

  return (
    <div className="absolute inset-0 flex flex-col gap-2 pb-2.5 pr-2.5">
      {/* Picker bar — choose the device/orientation before starting. */}
      <div className="flex h-9 flex-shrink-0 items-center rounded-xl border border-border bg-elevated/60 px-3">
        <span className="text-[11px] text-muted">
          Preview stopped — pick a device, then press play
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center gap-0.5 rounded-md border border-border bg-elevated p-0.5">
            {([
              { id: "iPhone-16-Pro" as DeviceModelUI, label: "iPhone", Icon: Smartphone },
              { id: "iPad-Pro" as DeviceModelUI, label: "iPad", Icon: Tablet },
            ]).map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => pickDevice(id)}
                className={cn(
                  "flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] transition",
                  device === id ? "bg-accent text-bg" : "text-muted hover:text-fg",
                )}
              >
                <Icon size={12} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={toggleOrientation}
            className="flex items-center gap-1.5 rounded-md border border-border bg-elevated px-2 py-1 text-[11px] text-muted hover:text-fg"
            title={`Rotate to ${orientation === "portrait" ? "landscape" : "portrait"}`}
          >
            <RotateCw size={12} />
            <span className="capitalize">{orientation}</span>
          </button>
        </div>
      </div>

      {/* Device bezel (off) with a Play button overlaid on the screen.
          `flex flex-col` is required so DeviceFrame's `flex-1` root gets a
          bounded height (otherwise it grows to the device's own size). */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-elevated/60">
        <DeviceFrame
          deviceModel={device}
          orientation={orientation}
          overlay={
            <button
              type="button"
              onClick={onPlay}
              className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full bg-accent text-bg shadow-xl transition hover:scale-105"
              title="Start the simulator"
            >
              <Play size={30} className="ml-1 fill-current" />
            </button>
          }
        >
          {screenshotUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={screenshotUrl}
              alt=""
              // object-contain mirrors the live canvas's max-w/h letterboxing,
              // so the screenshot sits exactly where the stream will.
              className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
              style={{ filter: "blur(7px) brightness(0.75)" }}
            />
          ) : (
            <></>
          )}
        </DeviceFrame>
      </div>
    </div>
  );
}

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    json: "json", md: "markdown",
    html: "html", css: "css", scss: "scss",
    py: "python", rb: "ruby", php: "php",
    java: "java", cpp: "cpp", c: "c",
    go: "go", rs: "rust", sh: "shell",
    yml: "yaml", yaml: "yaml",
    xml: "xml", sql: "sql",
    swift: "swift",
  };
  return map[ext ?? ""] ?? "plaintext";
}
