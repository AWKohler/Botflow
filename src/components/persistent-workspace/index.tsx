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
import { ConvexDashboard } from "@/components/convex/ConvexDashboard";
import { PanelLeft, Play, Save, Loader2, Database, Rocket } from "lucide-react";
import type { ProjectPlatform } from "@/lib/project-platform";

const PersistentTerminal = dynamic(
  () => import("./terminal").then((m) => m.PersistentTerminal),
  { ssr: false, loading: () => <div className="h-full w-full bg-elevated" /> },
);

type WorkspaceView = "preview" | "code" | "database";
type SandboxStatus = "idle" | "booting" | "ready" | "error";
type FileEntry = { type: "file" | "folder" };

// Minimal project row shape the workspace needs for backend awareness.
type ProjectRow = {
  name: string;
  platform: string;
  backendType: string;
  convexDeployUrl: string | null;
  userConvexUrl: string | null;
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

  // ── Preview Stop/Play persistence ──────────────────────────────────────────
  // When the user explicitly clicks Stop, we DELETE the session AND remember
  // they did, so reloading the page (or just re-mounting the workspace)
  // doesn't silently spin a new simulator. Cleared when they click Play.
  // Per-project key so different projects' choices don't interfere.
  const stoppedKey = `swift-preview:stopped:${projectId}`;
  const [previewStopped, setPreviewStoppedState] = useState(false);
  // Read the persisted flag exactly once on mount (SSR-safe).
  useEffect(() => {
    try {
      setPreviewStoppedState(
        window.localStorage.getItem(stoppedKey) === "true",
      );
    } catch {
      /* localStorage blocked — fine */
    }
  }, [stoppedKey]);
  const setPreviewStopped = useCallback(
    (next: boolean): void => {
      setPreviewStoppedState(next);
      try {
        if (next) window.localStorage.setItem(stoppedKey, "true");
        else window.localStorage.removeItem(stoppedKey);
      } catch {
        /* localStorage blocked — state still applies for this tab */
      }
    },
    [stoppedKey],
  );

  const initializedRef = useRef(false);

  // Project row (fetched client-side) — drives backend-aware UI. Null until loaded.
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [deployingBackend, setDeployingBackend] = useState(false);
  const hasBackend = project != null && project.backendType !== "none";
  const backendProvisioned =
    project != null && Boolean(project.convexDeployUrl || project.userConvexUrl);

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

            <UserButton
              afterSignOutUrl="/"
              appearance={{ elements: { userButtonAvatarBox: "w-8 h-8" } }}
            />

            {platform === "swift" && <IPhoneDeviceRunner />}

            {hasBackend && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void deployBackend()}
                disabled={deployingBackend}
                className="text-muted hover:text-fg bolt-hover"
                title="Deploy Convex backend"
              >
                {deployingBackend ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Rocket size={16} />
                )}
                <span className="ml-1">{deployingBackend ? "Deploying…" : "Deploy"}</span>
              </Button>
            )}

            <Button
              variant="default"
              size="sm"
              className="font-bold text-sm"
              onClick={() => toast({ title: "Coming soon", description: "Publishing for persistent projects isn't available yet." })}
              title="Publish (coming soon)"
            >
              Publish
            </Button>
          </div>
        </div>

        {/* Content */}
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
                <StoppedPreviewPlaceholder onPlay={() => setPreviewStopped(false)} />
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
                onStop={() => setPreviewStopped(true)}
                onExpand={() => setCurrentView("preview")}
              />
            </SwiftPipWindow>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Placeholder shown in the Preview tab when the user has explicitly stopped
 * the simulator. Click Play to re-provision a new session.
 */
function StoppedPreviewPlaceholder({ onPlay }: { onPlay: () => void }) {
  return (
    <div className="absolute inset-0 pb-2.5 pr-2.5">
      <div className="flex h-full w-full items-center justify-center rounded-xl border border-border bg-elevated/60">
        <div className="flex flex-col items-center gap-3 text-center text-muted">
          <button
            type="button"
            onClick={onPlay}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-bg shadow-lg transition hover:scale-105"
            title="Start the simulator"
          >
            <Play size={26} className="ml-1 fill-current" />
          </button>
          <div>
            <p className="font-semibold text-fg">Preview stopped</p>
            <p className="mt-1 max-w-xs px-6 text-xs">
              Click play to start a new simulator session.
            </p>
          </div>
        </div>
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
