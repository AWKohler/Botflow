'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { SignedIn, SignedOut, SignInButton, UserButton } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import {
  Plus,
  Laptop,
  Cog,
  Calendar,
  Layers,
  MoreVertical,
  Trash2,
  ExternalLink,
  Database,
  Globe,
  Star,
  Copy,
  Check,
} from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { SettingsModal } from '@/components/settings/SettingsModal';
import type { Project } from '@/db/schema';
import { getProjectPlatformLabel } from '@/lib/project-platform';

export default function ProjectsPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [thumbnailErrors, setThumbnailErrors] = useState<Record<string, true>>({});
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadProjects(allowRetry: boolean) {
      try {
        const res = await fetch('/api/projects');
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as Project[];
          if (cancelled) return;
          setProjects(data);
          setLoadError(null);
        } else if (res.status === 429 && allowRetry) {
          // Rate-limited — transient by definition, so retry once after the
          // server's Retry-After before showing an error. Return early WITHOUT
          // clearing `loading`, so the skeleton (not "No projects yet") shows
          // while we wait.
          const retryAfter = Math.min(
            Math.max(Number(res.headers.get('Retry-After')) || 5, 1),
            30,
          );
          setTimeout(() => void loadProjects(false), retryAfter * 1000);
          return;
        } else if (res.status === 429) {
          setLoadError('Too many requests right now — wait a few seconds and retry.');
        } else {
          const body = await res.json().catch(() => ({}));
          setLoadError(body.error ?? 'Failed to load projects');
        }
      } catch (error) {
        console.error('Failed to load projects:', error);
        if (cancelled) return;
        setLoadError('Failed to load projects');
      }
      if (!cancelled) setLoading(false);
    }
    loadProjects(true);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDeleteProject = async (projectId: string) => {
    if (!window.confirm('Are you sure you want to delete this project? This action cannot be undone.')) {
      return;
    }

    setDeletingId(projectId);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      if (res.ok) {
        setProjects((prev) => prev.filter((p) => p.id !== projectId));
      }
    } catch (error) {
      console.error('Failed to delete project:', error);
    } finally {
      setDeletingId(null);
      setOpenMenuId(null);
    }
  };


  const handleCopyShareLink = async (project: Project) => {
    if (!project.publicSlug) return;
    const url = `${window.location.origin}/p/${project.publicSlug}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedSlug(project.id);
      window.setTimeout(() => setCopiedSlug((s) => (s === project.id ? null : s)), 1800);
    } catch {
      toast({ title: 'Could not copy link' });
    }
  };

  const openProject = (projectId: string) => {
    setOpenMenuId(null);
    router.push(`/workspace/${projectId}`);
  };

  const openDatabaseManager = (projectId: string) => {
    setOpenMenuId(null);
    window.open(`/workspace/${projectId}/database`, '_blank', 'noopener,noreferrer');
  };

  const formatDate = (date: Date | string) => {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <div className="antialiased text-fg bg-bg min-h-screen">
      <div className="relative isolate overflow-hidden min-h-screen">
        <div className="pointer-events-none absolute inset-0 -z-10">
          <div
            className="absolute -top-1/3 -left-1/4 h-[80vh] w-[80vw] rounded-full blur-3xl opacity-50"
            style={{
              background:
                'radial-gradient(circle, color-mix(in oklab, var(--sand-accent) 26%, transparent) 0%, transparent 68%)',
            }}
          />
          <div
            className="absolute top-1/3 left-1/2 h-[90vh] w-[80vw] -translate-x-1/2 rounded-full blur-3xl opacity-40"
            style={{
              background:
                'radial-gradient(circle, color-mix(in oklab, var(--sand-text-muted) 20%, transparent) 0%, transparent 72%)',
            }}
          />
        </div>

        <header className="relative">
          <div className="mx-auto max-w-7xl px-6 py-5">
            <div className="grid grid-cols-3 items-center">
              <Link className="flex items-center gap-3" href="/">
                <img src="/brand/botflow-glyph.svg" alt="" className="h-8 w-8" />
                <img
                  src="/brand/botflow-wordmark.svg"
                  alt="Botflow"
                  className="h-5 w-auto botflow-wordmark-invert"
                />
              </Link>

              <nav className="hidden md:flex items-center justify-center gap-7 text-sm text-muted">
                <a className="text-fg font-medium" href="/projects">My Projects</a>
                <a className="hover:text-fg transition" href="/explore">Explore</a>
                <a className="hover:text-fg transition" href="/domains">Domains</a>
                <a className="hover:text-fg transition" href="/pricing">Pricing</a>
                <a className="hover:text-fg transition" href="/docs">Docs</a>
              </nav>

              <div className="flex items-center justify-end gap-2">
                <SignedOut>
                  <SignInButton>
                    <button className="inline-flex items-center rounded-xl border border-border bg-elevated px-3.5 py-2 text-sm font-medium text-fg shadow-sm hover:bg-soft transition">
                      Log in
                    </button>
                  </SignInButton>
                </SignedOut>
                <SignedIn>
                  <button
                    onClick={() => setShowSettings(true)}
                    className="inline-flex items-center justify-center rounded-xl border border-border bg-elevated px-2.5 py-2 text-sm text-fg shadow-sm hover:bg-soft transition"
                    title="Settings"
                    aria-label="Settings"
                  >
                    <Cog className="h-4 w-4" />
                  </button>
                  <UserButton afterSignOutUrl="/" />
                </SignedIn>
              </div>
            </div>
          </div>
        </header>

        <main className="relative">
          <div className="mx-auto max-w-7xl px-6 py-8">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h1 className="text-3xl font-semibold tracking-tight">My Projects</h1>
                <p className="mt-1 text-muted">
                  {projects.length} project{projects.length !== 1 ? 's' : ''}
                </p>
              </div>
              <Link
                href="/"
                className="inline-flex items-center gap-2 rounded-xl bg-fg px-4 py-2.5 text-sm font-medium text-bg shadow-md hover:opacity-90 transition"
              >
                <Plus className="h-4 w-4" />
                New Project
              </Link>
            </div>

            <SignedOut>
              <div className="text-center py-20">
                <p className="text-muted mb-4">Please sign in to view your projects.</p>
                <SignInButton>
                  <button className="inline-flex items-center rounded-xl bg-fg px-4 py-2.5 text-sm font-medium text-bg shadow-md hover:opacity-90 transition">
                    Sign In
                  </button>
                </SignInButton>
              </div>
            </SignedOut>

            <SignedIn>
              {loading ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {[...Array(4)].map((_, i) => (
                    <div
                      key={i}
                      className="rounded-2xl border border-border bg-surface backdrop-blur-sm animate-pulse"
                    >
                      <div className="aspect-video bg-elevated rounded-t-2xl"></div>
                      <div className="p-4">
                        <div className="h-5 bg-elevated rounded w-3/4 mb-2"></div>
                        <div className="h-4 bg-elevated rounded w-1/2"></div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : loadError ? (
                <div className="text-center py-20">
                  <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-elevated mb-4">
                    <Layers className="h-8 w-8 text-muted" />
                  </div>
                  <h2 className="text-xl font-semibold mb-2">Unable to load projects</h2>
                  <p className="text-muted mb-6">{loadError}</p>
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="inline-flex items-center gap-2 rounded-xl bg-fg px-4 py-2.5 text-sm font-medium text-bg shadow-md hover:opacity-90 transition"
                  >
                    Retry
                  </button>
                </div>
              ) : projects.length === 0 ? (
                <div className="text-center py-20">
                  <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-elevated mb-4">
                    <Layers className="h-8 w-8 text-muted" />
                  </div>
                  <h2 className="text-xl font-semibold mb-2">No projects yet</h2>
                  <p className="text-muted mb-6">Create your first project to get started.</p>
                  <Link
                    href="/"
                    className="inline-flex items-center gap-2 rounded-xl bg-fg px-4 py-2.5 text-sm font-medium text-bg shadow-md hover:opacity-90 transition"
                  >
                    <Plus className="h-4 w-4" />
                    Create Project
                  </Link>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {projects.map((project) => {
                    const hasDatabase = Boolean((project.userConvexUrl || project.convexDeployUrl) && (project.userConvexDeployKey || project.convexDeployKey));
                    const thumbnailFailed = Boolean(thumbnailErrors[project.id]);

                    return (
                      <div
                        key={project.id}
                        className={cn(
                          'group relative rounded-2xl border border-border bg-surface backdrop-blur-sm shadow-sm hover:shadow-lg transition-all duration-200 cursor-pointer',
                          openMenuId === project.id ? 'z-40' : 'z-0'
                        )}
                        onClick={() => openProject(project.id)}
                      >
                        <div className="aspect-video relative overflow-hidden rounded-t-2xl bg-gradient-to-br from-elevated to-bg">
                          {project.thumbnailUrl && !thumbnailFailed ? (
                            <img
                              src={project.thumbnailUrl}
                              alt={project.name}
                              className="w-full h-full object-cover object-top"
                              onError={() => {
                                setThumbnailErrors((prev) => ({ ...prev, [project.id]: true }));
                              }}
                            />
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <div className="flex flex-col items-center text-muted">
                                <Laptop className="h-10 w-10 mb-2" />
                                <span className="text-xs">No preview</span>
                              </div>
                            </div>
                          )}

                          <div className="absolute top-3 left-3">
                            <span className="inline-flex items-center gap-1 rounded-full bg-surface text-fg px-2 py-1 text-xs font-medium backdrop-blur-sm">
                              <Laptop className="h-3 w-3" />
                              {getProjectPlatformLabel(project.platform)}
                            </span>
                          </div>

                          {project.isPublic && (
                            <div className="absolute top-3 right-3">
                              <span className="inline-flex items-center gap-1 rounded-full bg-accent/90 px-2 py-1 text-xs font-medium text-[var(--sand-accent-contrast)] backdrop-blur-sm shadow-sm">
                                <Globe className="h-3 w-3" />
                                Public
                                {(project.starCount ?? 0) > 0 && (
                                  <>
                                    <span className="mx-0.5 opacity-60">·</span>
                                    <Star className="h-3 w-3 fill-current" />
                                    {project.starCount}
                                  </>
                                )}
                              </span>
                            </div>
                          )}

                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                            <span className="inline-flex items-center gap-2 rounded-full bg-surface px-4 py-2 text-sm font-medium shadow-lg text-fg">
                              <ExternalLink className="h-4 w-4" />
                              Open
                            </span>
                          </div>
                        </div>

                        <div className="p-4">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <h3 className="font-medium text-fg truncate" title={project.name}>
                                {project.name}
                              </h3>
                              <div className="flex items-center gap-2 mt-1 text-xs text-muted">
                                <Calendar className="h-3 w-3" />
                                <span>{formatDate(project.lastOpened)}</span>
                                <span className="opacity-40">•</span>
                                <span className="truncate">{project.model}</span>
                              </div>
                            </div>

                            <div className="relative">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenMenuId(openMenuId === project.id ? null : project.id);
                                }}
                                className="inline-flex items-center justify-center h-8 w-8 rounded-full hover:bg-elevated transition"
                                aria-label="Open project actions"
                              >
                                <MoreVertical className="h-4 w-4 text-muted" />
                              </button>

                              {openMenuId === project.id && (
                                <div
                                  className="absolute right-0 top-full mt-1 w-60 rounded-xl border border-border bg-surface shadow-lg z-50 py-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    onClick={() => openProject(project.id)}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-fg hover:bg-elevated"
                                  >
                                    <ExternalLink className="h-4 w-4" />
                                    Open
                                  </button>
                                  <button
                                    onClick={() => openDatabaseManager(project.id)}
                                    disabled={!hasDatabase}
                                    className={cn(
                                      'w-full flex items-center gap-2 px-3 py-2 text-sm',
                                      hasDatabase
                                        ? 'text-fg hover:bg-elevated'
                                        : 'text-muted cursor-not-allowed opacity-60'
                                    )}
                                  >
                                    <Database className="h-4 w-4" />
                                    Open Database Manager
                                  </button>
                                  {/* Public visibility is controlled from the
                                      project's Publish popover (deploy-gated), not here. */}
                                  {project.isPublic && project.publicSlug && (
                                    <>
                                      <div className="my-1 h-px bg-border" />
                                      <button
                                        onClick={() => handleCopyShareLink(project)}
                                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-fg hover:bg-elevated"
                                      >
                                        {copiedSlug === project.id ? (
                                          <>
                                            <Check className="h-4 w-4" />
                                            Copied!
                                          </>
                                        ) : (
                                          <>
                                            <Copy className="h-4 w-4" />
                                            Copy share link
                                          </>
                                        )}
                                      </button>
                                      <a
                                        href={`/p/${project.publicSlug}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={() => setOpenMenuId(null)}
                                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-fg hover:bg-elevated"
                                      >
                                        <ExternalLink className="h-4 w-4" />
                                        View public page
                                      </a>
                                    </>
                                  )}
                                  <div className="my-1 h-px bg-border" />
                                  <button
                                    onClick={() => handleDeleteProject(project.id)}
                                    disabled={deletingId === project.id}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-500/10"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                    {deletingId === project.id ? 'Deleting...' : 'Delete'}
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SignedIn>
          </div>
        </main>
        {openMenuId && (
          <div className="fixed inset-0 z-30" onClick={() => setOpenMenuId(null)} />
        )}
      </div>

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}
