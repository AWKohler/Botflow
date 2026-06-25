"use client";

/**
 * GitHub panel for sandboxed-web projects.
 *
 * This is intentionally NOT a port of `src/components/workspace/github-panel.tsx`.
 * The webcontainer version reconstructs git semantics over the REST API
 * because WebContainer can't run `git`; we have real git in the sandbox, so
 * the UX is simpler:
 *
 *   • Disconnected (no GitHub OAuth token): "Connect GitHub" button.
 *   • Connected, no repo linked: list user's repos, or create a new one.
 *   • Connected, repo linked: status summary, "Save to GitHub", "Get latest".
 *
 * Phase A: connection + repo selection + link/unlink only. Save/Get-latest
 * land in Phase B.
 */
import { Input } from "@/components/ui/input";
import { useCallback, useEffect, useState } from "react";
import {
  GitBranch,
  ExternalLink,
  LogOut,
  Loader2,
  Lock,
  Globe,
  Plus,
  RefreshCw,
  Search,
  ArrowDown,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { ConflictModal, type ConflictBlob } from "./conflict-modal";

interface GitHubAccountStatus {
  connected: boolean;
  username: string | null;
  avatarUrl: string | null;
}

interface GitHubRepo {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  isPrivate?: boolean;
}

interface SandboxStatus {
  branch: string;
  ahead: number;
  behind: number;
  hasMerging: boolean;
  files: {
    added: string[];
    modified: string[];
    deleted: string[];
    untracked: string[];
    renamed: Array<{ from: string; to: string }>;
    conflicted: string[];
  };
  isClean: boolean;
}

interface GitHubPanelProps {
  projectId: string;
  githubRepoOwner: string | null;
  githubRepoName: string | null;
  githubDefaultBranch: string | null;
  onRepoLinked: (owner: string, name: string, branch: string) => void;
  onRepoUnlinked: () => void;
}

export function SandboxGitHubPanel({
  projectId,
  githubRepoOwner,
  githubRepoName,
  githubDefaultBranch,
  onRepoLinked,
  onRepoUnlinked,
}: GitHubPanelProps) {
  const { toast } = useToast();
  const [account, setAccount] = useState<GitHubAccountStatus | null>(null);
  const [loadingAccount, setLoadingAccount] = useState(true);

  // For the connected-but-not-linked state
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");
  const [createMode, setCreateMode] = useState(false);
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState(false);

  // Status of the working tree (only when a repo is linked)
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  // Commit + push state
  const [commitMessage, setCommitMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [pulling, setPulling] = useState(false);

  // Conflict modal state
  const [conflictModal, setConflictModal] = useState<{
    branch: string;
    conflicts: string[];
    blobs: Record<string, ConflictBlob>;
  } | null>(null);

  const isLinked = Boolean(githubRepoOwner && githubRepoName);

  // ── Account status ────────────────────────────────────────────────────
  const refreshAccount = useCallback(async () => {
    setLoadingAccount(true);
    try {
      const res = await fetch("/api/oauth/github/status");
      if (res.ok) {
        const data = await res.json();
        setAccount({
          connected: Boolean(data.connected),
          username: data.username ?? null,
          avatarUrl: data.avatarUrl ?? null,
        });
      } else {
        setAccount({ connected: false, username: null, avatarUrl: null });
      }
    } catch {
      setAccount({ connected: false, username: null, avatarUrl: null });
    } finally {
      setLoadingAccount(false);
    }
  }, []);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  // Detect ?github_connected=1 after the OAuth roundtrip so the panel refreshes.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("github_connected")) {
      url.searchParams.delete("github_connected");
      window.history.replaceState({}, document.title, url.toString());
      void refreshAccount();
    }
  }, [refreshAccount]);

  // ── Repo list ─────────────────────────────────────────────────────────
  const loadRepos = useCallback(async () => {
    setLoadingRepos(true);
    try {
      const res = await fetch("/api/github/repos");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast({ title: "Failed to load repositories", description: err.error ?? `HTTP ${res.status}` });
        return;
      }
      setRepos(await res.json());
    } catch (e) {
      toast({ title: "Failed to load repositories", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoadingRepos(false);
    }
  }, [toast]);

  useEffect(() => {
    if (account?.connected && !isLinked) void loadRepos();
  }, [account?.connected, isLinked, loadRepos]);

  // ── Status (only when linked) ────────────────────────────────────────
  // `withFetch` does a `git fetch origin` first so the behind count
  // reflects commits that landed on GitHub since the last refresh.
  // The refresh button always passes withFetch=true; the background
  // poll alternates so we get periodic remote awareness without
  // hammering GitHub on every render.
  const refreshStatus = useCallback(
    async (withFetch = false) => {
      if (!isLinked) return;
      setStatusLoading(true);
      try {
        const url = `/api/projects/${projectId}/github/sandbox/status${withFetch ? "?fetch=1" : ""}`;
        const res = await fetch(url, { method: "POST" });
        if (res.ok) {
          const data = await res.json();
          setStatus(data.status ?? null);
        } else if (res.status === 409) {
          setStatus(null);
          toast({
            title: "Sandbox missing .git directory",
            description: "Re-link the repository to re-clone.",
          });
        } else {
          const err = await res.json().catch(() => ({}));
          toast({ title: "Failed to read git status", description: err.error ?? `HTTP ${res.status}` });
        }
      } catch (e) {
        toast({ title: "Failed to read git status", description: e instanceof Error ? e.message : String(e) });
      } finally {
        setStatusLoading(false);
      }
    },
    [isLinked, projectId, toast],
  );

  useEffect(() => {
    if (!isLinked) return;
    // Initial load fetches so the UI immediately reflects remote-side
    // commits made since the last open.
    void refreshStatus(true);
    // Periodic background fetch so the panel learns about new remote
    // commits without the user clicking refresh. 60s is gentle on
    // GitHub's rate limits while still feeling live.
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshStatus(true);
    }, 60_000);
    // Also re-fetch as soon as the tab regains focus — common case is
    // "I just made a commit on GitHub in another tab".
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [isLinked, refreshStatus]);

  // ── Actions ──────────────────────────────────────────────────────────
  const connectGitHub = useCallback(() => {
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = `/api/oauth/github/start?returnTo=${encodeURIComponent(returnTo)}`;
  }, []);

  const disconnectGitHub = useCallback(async () => {
    if (!confirm("Disconnect your GitHub account?")) return;
    try {
      const res = await fetch("/api/oauth/github/disconnect", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshAccount();
      toast({ title: "GitHub disconnected" });
    } catch (e) {
      toast({ title: "Disconnect failed", description: e instanceof Error ? e.message : String(e) });
    }
  }, [refreshAccount, toast]);

  const linkRepo = useCallback(
    async (repo: { owner: string; name: string; defaultBranch: string }) => {
      setLinking(true);
      try {
        const res = await fetch(`/api/projects/${projectId}/github/sandbox/link`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner: repo.owner,
            name: repo.name,
            defaultBranch: repo.defaultBranch,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        onRepoLinked(repo.owner, repo.name, repo.defaultBranch);
        toast({
          title: "Repository linked",
          description: data.repo?.wasEmpty
            ? "Pushed your initial commit to GitHub."
            : "Linked. Click 'Save to GitHub' to push your local files.",
        });
        // Nudge the agent to ask the user how they want commits handled.
        // AgentPanel listens for this and sends a [system-note] message,
        // which both renders as a chip and triggers an agent turn (the
        // link-route DB insert alone doesn't kick off a turn).
        window.dispatchEvent(
          new CustomEvent("github-linked", {
            detail: {
              projectId,
              owner: repo.owner,
              name: repo.name,
            },
          }),
        );
      } catch (e) {
        toast({ title: "Link failed", description: e instanceof Error ? e.message : String(e) });
      } finally {
        setLinking(false);
      }
    },
    [onRepoLinked, projectId, toast],
  );

  const createAndLink = useCallback(async () => {
    if (!newRepoName.trim()) return;
    setCreating(true);
    try {
      const createRes = await fetch("/api/github/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newRepoName.trim(),
          isPrivate: newRepoPrivate,
        }),
      });
      const created = await createRes.json();
      if (!createRes.ok) throw new Error(created.error ?? `HTTP ${createRes.status}`);
      await linkRepo({
        owner: created.owner,
        name: created.name,
        defaultBranch: created.defaultBranch ?? "main",
      });
      setCreateMode(false);
      setNewRepoName("");
    } catch (e) {
      toast({ title: "Create repository failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setCreating(false);
    }
  }, [linkRepo, newRepoName, newRepoPrivate, toast]);

  const saveToGitHub = useCallback(
    async (opts: { force?: boolean } = {}) => {
      const message = commitMessage.trim();
      const hasChanges =
        status &&
        (status.files.added.length +
          status.files.modified.length +
          status.files.deleted.length +
          status.files.untracked.length >
          0);
      // No staged changes is OK — we still push existing commits.
      // But if there are changes AND no message, complain.
      if (hasChanges && !message) {
        toast({ title: "Write a commit message", description: "Describe what you changed in a short sentence." });
        return;
      }
      setSaving(true);
      try {
        // 1. Commit (only if there are changes)
        if (hasChanges) {
          const commitRes = await fetch(`/api/projects/${projectId}/github/sandbox/commit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
          });
          const commitData = await commitRes.json();
          if (!commitRes.ok) {
            throw new Error(commitData.error ?? `HTTP ${commitRes.status}`);
          }
        }

        // 2. Push
        const pushRes = await fetch(`/api/projects/${projectId}/github/sandbox/push`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: opts.force === true }),
        });
        const pushData = await pushRes.json();
        if (!pushRes.ok) {
          if (pushData.code === "non-fast-forward") {
            toast({
              title: "Remote has new changes",
              description: "Click 'Get latest from GitHub' first, then save again.",
            });
            return;
          }
          throw new Error(pushData.error ?? `HTTP ${pushRes.status}`);
        }

        setCommitMessage("");
        toast({ title: "Saved to GitHub" });
        await refreshStatus();
      } catch (e) {
        toast({ title: "Save failed", description: e instanceof Error ? e.message : String(e) });
      } finally {
        setSaving(false);
      }
    },
    [commitMessage, projectId, refreshStatus, status, toast],
  );

  const pullFromGitHub = useCallback(async () => {
    setPulling(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/github/sandbox/pull`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        // Concatenate the high-level message and stderr so the user (and
        // we, debugging) can see what git actually said.
        const errMsg = data.error ?? `HTTP ${res.status}`;
        const stderr = (data.stderr as string | undefined) ?? "";
        throw new Error(stderr ? `${errMsg}\n\n${stderr.slice(-600)}` : errMsg);
      }
      if (data.clean) {
        toast({ title: data.changed ? "Pulled latest from GitHub" : "Already up to date" });
      } else {
        setConflictModal({
          branch: data.branch,
          conflicts: data.conflicts as string[],
          blobs: data.conflictBlobs as Record<string, ConflictBlob>,
        });
      }
      await refreshStatus();
    } catch (e) {
      toast({ title: "Pull failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setPulling(false);
    }
  }, [projectId, refreshStatus, toast]);

  const unlinkRepo = useCallback(async () => {
    if (!confirm("Unlink this repository from the project?")) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/github/sandbox/link`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      onRepoUnlinked();
      setStatus(null);
      toast({ title: "Repository unlinked" });
    } catch (e) {
      toast({ title: "Unlink failed", description: e instanceof Error ? e.message : String(e) });
    }
  }, [onRepoUnlinked, projectId, toast]);

  // ── Render ───────────────────────────────────────────────────────────
  if (loadingAccount) {
    return (
      <div className="flex items-center justify-center p-6 text-muted">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }

  // Disconnected
  if (!account?.connected) {
    return (
      <div className="p-4 space-y-3 text-sm">
        <div className="flex items-center gap-2 text-fg">
          <GitBranch size={14} className="text-muted" />
          <span className="font-medium">GitHub</span>
        </div>
        <p className="text-muted text-xs leading-relaxed">
          Connect your GitHub account to save this project to a repository, share it,
          or back up your work.
        </p>
        <Button size="sm" onClick={connectGitHub} className="w-full">
          Connect GitHub
        </Button>
      </div>
    );
  }

  // Connected, no repo linked
  if (!isLinked) {
    return (
      <div className="p-3 space-y-3 text-sm">
        <AccountHeader account={account} onDisconnect={disconnectGitHub} />

        {createMode ? (
          <div className="space-y-2 rounded-lg border border-border bg-elevated p-3">
            <div className="text-xs font-medium text-fg">Create new repository</div>
            <Input
              type="text"
              value={newRepoName}
              onChange={(e) => setNewRepoName(e.target.value)}
              placeholder="my-project"
              className="w-full px-2 py-1.5 text-sm rounded-md bg-surface border border-border focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setNewRepoPrivate(true)}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded-md border",
                  newRepoPrivate
                    ? "border-accent text-accent bg-accent/10"
                    : "border-border text-muted hover:text-fg",
                )}
              >
                <Lock size={11} />
                Private
              </button>
              <button
                type="button"
                onClick={() => setNewRepoPrivate(false)}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded-md border",
                  !newRepoPrivate
                    ? "border-accent text-accent bg-accent/10"
                    : "border-border text-muted hover:text-fg",
                )}
              >
                <Globe size={11} />
                Public
              </button>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                onClick={createAndLink}
                disabled={!newRepoName.trim() || creating || linking}
                className="flex-1"
              >
                {creating || linking ? <Loader2 size={12} className="animate-spin" /> : "Create"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreateMode(false)} disabled={creating}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Button size="sm" onClick={() => setCreateMode(true)} className="w-full">
              <Plus size={12} className="mr-1" /> Create new repository
            </Button>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-surface border border-border">
                <Search size={11} className="text-muted shrink-0" />
                <Input
                  type="text"
                  value={repoFilter}
                  onChange={(e) => setRepoFilter(e.target.value)}
                  placeholder="Filter repositories…"
                  className="flex-1 text-xs bg-transparent focus:outline-none placeholder:text-muted"
                />
                {loadingRepos && <Loader2 size={11} className="animate-spin text-muted" />}
              </div>
              <RepoList
                repos={repos.filter((r) => r.fullName.toLowerCase().includes(repoFilter.toLowerCase()))}
                onPick={linkRepo}
                disabled={linking}
              />
            </div>
          </>
        )}
      </div>
    );
  }

  // Connected, repo linked
  const totalChanged = status
    ? status.files.added.length + status.files.modified.length + status.files.deleted.length + status.files.untracked.length
    : 0;
  const conflictCount = status?.files.conflicted.length ?? 0;

  return (
    <div className="p-3 space-y-3 text-sm">
      <AccountHeader account={account} onDisconnect={disconnectGitHub} />

      {/* Repo card */}
      <div className="rounded-lg border border-border bg-elevated p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <GitBranch size={12} className="shrink-0 text-muted" />
            <span className="text-xs font-medium truncate">
              {githubRepoOwner}/{githubRepoName}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <a
              href={`https://github.com/${githubRepoOwner}/${githubRepoName}`}
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:text-fg"
              title="Open on GitHub"
            >
              <ExternalLink size={11} />
            </a>
            <button
              type="button"
              onClick={unlinkRepo}
              className="text-muted hover:text-red-400"
              title="Unlink"
            >
              <LogOut size={11} />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <GitBranch size={10} />
            {status?.branch ?? githubDefaultBranch ?? "main"}
          </span>
          <button
            type="button"
            onClick={() => void refreshStatus(true)}
            className="hover:text-fg"
            title="Refresh status (fetches latest from GitHub)"
            disabled={statusLoading}
          >
            <RefreshCw size={11} className={statusLoading ? "animate-spin" : undefined} />
          </button>
        </div>

        {status && !status.isClean && (
          <div className="space-y-1 text-[11px]">
            {conflictCount > 0 && (
              <div className="text-red-400">
                {conflictCount} file{conflictCount === 1 ? "" : "s"} with merge conflicts
              </div>
            )}
            {totalChanged > 0 && (
              <div className="text-muted">
                {totalChanged} changed file{totalChanged === 1 ? "" : "s"}
              </div>
            )}
            {(status.ahead > 0 || status.behind > 0) && (
              <div className="text-muted">
                {status.ahead > 0 && <span>↑ {status.ahead} ahead</span>}
                {status.ahead > 0 && status.behind > 0 && " · "}
                {status.behind > 0 && <span>↓ {status.behind} behind</span>}
              </div>
            )}
          </div>
        )}

        {status?.isClean && (
          <div className="text-[11px] text-muted">
            {status.ahead > 0 || status.behind > 0
              ? `${status.ahead > 0 ? `↑ ${status.ahead} ahead` : ""}${status.ahead > 0 && status.behind > 0 ? " · " : ""}${status.behind > 0 ? `↓ ${status.behind} behind` : ""}`
              : "Up to date"}
          </div>
        )}
      </div>

      {/* Save to GitHub */}
      <div className="space-y-2">
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="What did you change?"
          rows={2}
          className="w-full px-2 py-1.5 text-xs rounded-md bg-surface border border-border focus:outline-none focus:ring-1 focus:ring-accent resize-none"
          disabled={saving || pulling || Boolean(status?.hasMerging)}
        />
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={() => void saveToGitHub()}
            disabled={saving || pulling || Boolean(status?.hasMerging)}
            className="flex-1"
            title="Commit your changes and push to GitHub"
          >
            {saving ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <>
                <Upload size={11} className="mr-1" />
                Save to GitHub
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void pullFromGitHub()}
            disabled={saving || pulling}
            title="Pull the latest from GitHub"
          >
            {pulling ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <ArrowDown size={11} />
            )}
          </Button>
        </div>
        {status?.hasMerging && (
          <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 px-2.5 py-2 text-[11px] text-yellow-400">
            Merge in progress — finish resolving conflicts before saving.
          </div>
        )}
      </div>

      {/* Open PR — only when working on a non-default branch */}
      {status && status.branch && githubDefaultBranch && status.branch !== githubDefaultBranch && (
        <OpenPrLink
          projectId={projectId}
          owner={githubRepoOwner!}
          name={githubRepoName!}
          headBranch={status.branch}
          baseBranch={githubDefaultBranch}
        />
      )}

      {/* Conflict modal — opens when pull surfaces conflicts */}
      {conflictModal && (
        <ConflictModal
          projectId={projectId}
          branch={conflictModal.branch}
          conflicts={conflictModal.conflicts}
          conflictBlobs={conflictModal.blobs}
          onClose={() => setConflictModal(null)}
          onResolved={() => {
            void refreshStatus();
          }}
        />
      )}
    </div>
  );
}

function OpenPrLink({
  projectId,
  owner,
  name,
  headBranch,
  baseBranch,
}: {
  projectId: string;
  owner: string;
  name: string;
  headBranch: string;
  baseBranch: string;
}) {
  const { toast } = useToast();
  const [opening, setOpening] = useState(false);

  const handle = async () => {
    const title = window.prompt(
      `Open a PR for ${headBranch} → ${baseBranch}?\n\nPR title:`,
      `Update from ${headBranch}`,
    );
    if (!title) return;
    setOpening(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/github/sandbox/open-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, headBranch, baseBranch }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      window.open(data.url, "_blank", "noopener");
      toast({
        title: data.alreadyExists ? "PR already exists" : "PR opened",
        description: data.url,
      });
    } catch (e) {
      toast({
        title: "Open PR failed",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setOpening(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handle()}
      disabled={opening}
      className="w-full text-[11px] text-muted hover:text-accent px-2 py-1.5 rounded-md border border-dashed border-border hover:border-accent/40 transition-colors"
    >
      {opening ? "Opening PR…" : `Open pull request for \`${headBranch}\` → \`${baseBranch}\``}
    </button>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function AccountHeader({
  account,
  onDisconnect,
}: {
  account: GitHubAccountStatus;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        {account.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={account.avatarUrl}
            alt={account.username ?? ""}
            className="w-5 h-5 rounded-full"
          />
        ) : (
          <div className="w-5 h-5 rounded-full bg-soft" />
        )}
        <span className="text-xs text-fg truncate">{account.username ?? "Connected"}</span>
      </div>
      <button
        type="button"
        onClick={onDisconnect}
        className="text-[11px] text-muted hover:text-fg"
      >
        Sign out
      </button>
    </div>
  );
}

function RepoList({
  repos,
  onPick,
  disabled,
}: {
  repos: GitHubRepo[];
  onPick: (r: { owner: string; name: string; defaultBranch: string }) => void;
  disabled: boolean;
}) {
  if (repos.length === 0) {
    return (
      <div className="text-[11px] text-muted px-2 py-3 text-center">
        No repositories.
      </div>
    );
  }
  return (
    <div className="max-h-[280px] overflow-y-auto modern-scrollbar rounded-md border border-border bg-elevated divide-y divide-border">
      {repos.map((r) => (
        <button
          key={r.fullName}
          type="button"
          disabled={disabled}
          onClick={() => onPick({ owner: r.owner, name: r.name, defaultBranch: r.defaultBranch })}
          className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="min-w-0 flex items-center gap-1.5">
            {r.isPrivate ? (
              <Lock size={10} className="shrink-0 text-muted" />
            ) : (
              <Globe size={10} className="shrink-0 text-muted" />
            )}
            <span className="text-xs truncate">{r.fullName}</span>
          </div>
          <span className="text-[10px] text-muted shrink-0">{r.defaultBranch}</span>
        </button>
      ))}
    </div>
  );
}
