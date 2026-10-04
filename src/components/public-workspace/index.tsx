"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@/components/auth";
import {
  Eye,
  Code2,
  Star,
  Loader2,
  Sparkles,
  RefreshCw,
  ExternalLink,
  ArrowLeft,
  Copy,
  Check,
} from "lucide-react";
import { CodeEditor } from "@/components/workspace/code-editor";
import { FileTree } from "@/components/workspace/file-tree";
import { TemplateForkModal } from "./template-fork-modal";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  getProjectPlatformLabel,
  type ProjectPlatform,
} from "@/lib/project-platform";

export interface PublicProjectData {
  project: {
    id: string;
    name: string;
    platform: ProjectPlatform;
    publicSlug: string;
    publicDescription: string | null;
    thumbnailUrl: string | null;
    starCount: number;
    publishedAt: string | null;
    createdAt: string;
    author: { name: string; imageUrl: string | null };
    hasStarred: boolean;
    isOwner: boolean;
    /** Live Cloudflare Pages deployment — iframed read-only. */
    deployedUrl: string | null;
    /** Whether a source bundle exists (drives the Code tab + "Use as template"). */
    hasSource: boolean;
    /** Whether the template needs a Convex backend (drives the fork modal). */
    usesConvex: boolean;
  };
}

interface PublicWorkspaceProps {
  data: PublicProjectData;
  isSignedIn: boolean;
}

interface SourceFile {
  path: string;
  content: string;
}

type Tab = "preview" | "code";

function buildFileTree(files: SourceFile[]): Record<string, { type: "file" | "folder" }> {
  const tree: Record<string, { type: "file" | "folder" }> = {};
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      tree["/" + parts.slice(0, i).join("/")] = { type: "folder" };
    }
    tree[f.path] = { type: "file" };
  }
  return tree;
}

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "javascript", ts: "typescript", jsx: "javascript", tsx: "typescript",
    json: "json", md: "markdown", html: "html", css: "css", scss: "scss",
    py: "python", rb: "ruby", php: "php", java: "java", cpp: "cpp", c: "c",
    go: "go", rs: "rust", sh: "shell", yml: "yaml", yaml: "yaml", xml: "xml", sql: "sql",
  };
  return map[ext || ""] || "plaintext";
}

export function PublicWorkspace({ data, isSignedIn }: PublicWorkspaceProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { project } = data;

  // Only show the Code tab + "Use as template" when there's a source bundle.
  const hasSource = project.hasSource;

  const [tab, setTab] = useState<Tab>("preview");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sourceFiles, setSourceFiles] = useState<SourceFile[] | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [stars, setStars] = useState(project.starCount);
  const [hasStarred, setHasStarred] = useState(project.hasStarred);
  const [starring, setStarring] = useState(false);
  const [forkModalOpen, setForkModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const fileTree = useMemo(() => buildFileTree(sourceFiles ?? []), [sourceFiles]);
  const textFileMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of sourceFiles ?? []) map[f.path] = f.content;
    return map;
  }, [sourceFiles]);

  // Lazily pull the source bundle the first time the Code tab is opened.
  const sourceRequested = useRef(false);
  useEffect(() => {
    if (tab !== "code" || !hasSource || sourceRequested.current) return;
    sourceRequested.current = true;
    setSourceLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/public/projects/${project.publicSlug}/source`);
        const body = (await res.json()) as { files?: SourceFile[] };
        setSourceFiles(body.files ?? []);
      } catch {
        setSourceFiles([]);
      } finally {
        setSourceLoading(false);
      }
    })();
  }, [tab, hasSource, project.publicSlug]);

  // Auto-select an interesting file once source loads.
  useEffect(() => {
    if (selectedFile || !sourceFiles?.length) return;
    const preferred = ["/src/App.tsx", "/src/App.jsx", "/src/main.tsx", "/src/index.tsx", "/index.html", "/package.json"];
    for (const p of preferred) {
      if (textFileMap[p]) { setSelectedFile(p); return; }
    }
    setSelectedFile(sourceFiles[0].path);
  }, [sourceFiles, selectedFile, textFileMap]);

  const handleStar = useCallback(async () => {
    if (!isSignedIn) {
      router.push(`/sign-in?redirect_url=${encodeURIComponent(`/p/${project.publicSlug}`)}`);
      return;
    }
    if (starring) return;
    setStarring(true);
    const prev = { stars, hasStarred };
    setHasStarred(!hasStarred);
    setStars(hasStarred ? Math.max(stars - 1, 0) : stars + 1);
    try {
      const res = await fetch(`/api/public/projects/${project.publicSlug}/star`, { method: "POST" });
      if (!res.ok) throw new Error("Failed");
      const body = await res.json();
      setHasStarred(Boolean(body.starred));
      setStars(body.starCount ?? 0);
    } catch (err) {
      setStars(prev.stars);
      setHasStarred(prev.hasStarred);
      toast({ title: "Could not update star", description: err instanceof Error ? err.message : undefined });
    } finally {
      setStarring(false);
    }
  }, [isSignedIn, router, project.publicSlug, starring, stars, hasStarred, toast]);

  // "Use as template" → open the creation modal (which routes to /start so the
  // new project goes through the real naming + Convex provisioning + gating
  // flow). Signed-out users sign in first and return with ?fork=1.
  const handleUseAsTemplate = useCallback(() => {
    if (!isSignedIn) {
      router.push(`/sign-in?redirect_url=${encodeURIComponent(`/p/${project.publicSlug}?fork=1`)}`);
      return;
    }
    setForkModalOpen(true);
  }, [isSignedIn, router, project.publicSlug]);

  // Auto-open the fork modal after sign-in / Convex connect (?fork=1).
  useEffect(() => {
    if (!isSignedIn || !hasSource) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("fork") === "1") {
      url.searchParams.delete("fork");
      window.history.replaceState({}, "", url.toString());
      setForkModalOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({ title: "Could not copy link" });
    }
  }, [toast]);

  return (
    <div className="antialiased text-fg bg-bg min-h-screen flex flex-col">
      <header className="relative z-30 border-b border-border bg-surface/80 backdrop-blur-sm">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-6 py-3">
          <div className="flex items-center gap-3">
            <Link href="/explore" className="hidden md:inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted hover:text-fg hover:bg-elevated transition">
              <ArrowLeft className="h-4 w-4" />
              Explore
            </Link>

            <div className="flex items-center gap-3 min-w-0 flex-1">
              {project.author.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={project.author.imageUrl} alt="" className="h-8 w-8 rounded-full border border-border shrink-0" />
              ) : (
                <div className="h-8 w-8 rounded-full bg-elevated border border-border shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <h1 className="font-semibold text-fg truncate" title={project.name}>{project.name}</h1>
                  <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-elevated px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted shrink-0">
                    {getProjectPlatformLabel(project.platform)}
                  </span>
                </div>
                <p className="text-xs text-muted truncate">by {project.author.name}</p>
              </div>
            </div>

            {/* Tab switcher — Code only when a source bundle exists */}
            <div className="inline-flex items-center rounded-xl border border-border bg-bg p-0.5 shadow-sm">
              <button
                onClick={() => setTab("preview")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  tab === "preview" ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
                )}
              >
                <Eye className="h-4 w-4" />
                Preview
              </button>
              {hasSource && (
                <button
                  onClick={() => setTab("code")}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                    tab === "code" ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
                  )}
                >
                  <Code2 className="h-4 w-4" />
                  Code
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleStar}
                disabled={starring}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-medium transition",
                  hasStarred
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-border bg-elevated text-fg hover:bg-soft"
                )}
                title={hasStarred ? "Unstar" : "Star"}
              >
                <Star className={cn("h-4 w-4", hasStarred && "fill-current")} />
                <span className="tabular-nums">{stars}</span>
              </button>

              <button
                onClick={handleCopyLink}
                className="hidden sm:inline-flex items-center justify-center rounded-xl border border-border bg-elevated h-[34px] w-[34px] text-fg hover:bg-soft transition"
                title="Copy share link"
                aria-label="Copy share link"
              >
                {copied ? <Check className="h-4 w-4 text-accent" /> : <Copy className="h-4 w-4" />}
              </button>

              {hasSource && (
                <button
                  onClick={handleUseAsTemplate}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-fg px-3.5 py-1.5 text-sm font-medium text-bg shadow-md hover:opacity-90 transition"
                >
                  <Sparkles className="h-4 w-4" />
                  Use as template
                </button>
              )}

              <SignedOut>
                <SignInButton>
                  <button className="hidden md:inline-flex items-center rounded-xl border border-border bg-elevated px-3 py-1.5 text-sm font-medium text-fg hover:bg-soft transition">
                    Log in
                  </button>
                </SignInButton>
              </SignedOut>
              <SignedIn>
                <UserButton afterSignOutUrl="/" />
              </SignedIn>
            </div>
          </div>

          {project.publicDescription && (
            <p className="mt-2 pl-11 text-sm text-muted line-clamp-2">{project.publicDescription}</p>
          )}
        </div>
      </header>

      <main className="flex-1 relative overflow-hidden">
        {tab === "preview" ? (
          <PreviewPane deployedUrl={project.deployedUrl} reloadKey={reloadKey} onReload={() => setReloadKey((k) => k + 1)} />
        ) : (
          <CodePane
            files={fileTree}
            selectedFile={selectedFile}
            onFileSelect={setSelectedFile}
            content={selectedFile ? textFileMap[selectedFile] ?? "" : ""}
            loading={sourceLoading}
          />
        )}
      </main>

      {forkModalOpen && (
        <TemplateForkModal
          slug={project.publicSlug}
          sourceName={project.name}
          usesConvex={project.usesConvex}
          onClose={() => setForkModalOpen(false)}
        />
      )}
    </div>
  );
}

function PreviewPane({
  deployedUrl,
  reloadKey,
  onReload,
}: {
  deployedUrl: string | null;
  reloadKey: number;
  onReload: () => void;
}) {
  if (!deployedUrl) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-bg text-muted text-sm">
        This project isn&apos;t deployed.
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col bg-bg">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface">
        <button
          onClick={onReload}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-elevated text-muted hover:text-fg transition"
          title="Reload preview"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1 mx-1 flex items-center rounded-md bg-elevated border border-border px-3 py-1 text-xs">
          <span className="text-muted truncate">{deployedUrl}</span>
        </div>
        <a
          href={deployedUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-elevated text-muted hover:text-fg transition"
          title="Open in new tab"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      <div className="relative flex-1 bg-white overflow-hidden">
        <iframe
          key={reloadKey}
          src={deployedUrl}
          className="absolute inset-0 w-full h-full bg-white"
          sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts allow-downloads"
          title="Public project preview"
        />
      </div>
    </div>
  );
}

export function PublicWorkspaceGuard({ data, isSignedIn }: PublicWorkspaceProps) {
  // The public view is fully static (iframe + read-only editor) — no device
  // gate or WebContainer needed.
  return <PublicWorkspace data={data} isSignedIn={isSignedIn} />;
}

function CodePane({
  files,
  selectedFile,
  onFileSelect,
  content,
  loading,
}: {
  files: Record<string, { type: "file" | "folder" }>;
  selectedFile: string | null;
  onFileSelect: (path: string) => void;
  content: string;
  loading: boolean;
}) {
  return (
    <div className="absolute inset-0 flex bg-bg">
      <aside className="w-64 shrink-0 border-r border-border bg-surface flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-border">
          <div className="text-[11px] uppercase tracking-wide font-medium text-muted">Files</div>
        </div>
        <div className="flex-1 overflow-y-auto modern-scrollbar">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading source…
            </div>
          ) : (
            <FileTree files={files} selectedFile={selectedFile} onFileSelect={onFileSelect} />
          )}
        </div>
      </aside>
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface">
          <div className="text-sm text-muted">{selectedFile ?? "No file selected"}</div>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-elevated px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
            Read-only
          </span>
        </div>
        <div className="flex-1 min-h-0">
          {selectedFile ? (
            <CodeEditor
              value={content}
              onChange={() => {}}
              language={getLanguageFromFilename(selectedFile)}
              filename={selectedFile}
              disabled
            />
          ) : (
            <div className="h-full flex items-center justify-center text-muted text-sm">
              {loading ? "Loading…" : "Select a file to view"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
