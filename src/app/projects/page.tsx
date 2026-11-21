'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { SignedIn, SignedOut, SignInButton } from '@/components/auth';
import { cn } from '@/lib/utils';
import {
  Plus,
  Laptop,
  Smartphone,
  Layers,
  MoreHorizontal,
  Trash2,
  ExternalLink,
  Database,
  Globe,
  Star,
  Copy,
  Check,
  AlertTriangle,
  PauseCircle,
} from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { AppShell } from '@/components/site/AppShell';
import { PageHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { buttonClass } from '@/components/ui/button';
import { Menu, MenuItem, MenuSeparator, menuItemClass } from '@/components/ui/menu';
import { MODEL_CONFIGS } from '@/lib/agent/models';
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
    <AppShell>
      <PageHeader
        title="Projects"
        description={
          loading || loadError
            ? 'Everything you have built with Botflow.'
            : `${projects.length} project${projects.length !== 1 ? 's' : ''}`
        }
        action={
          // With no projects yet, the empty state below carries the one action.
          !loading && !loadError && projects.length === 0 ? undefined : (
            <Link href="/" className={buttonClass({ variant: 'primary' })}>
              <Plus className="h-4 w-4" />
              New project
            </Link>
          )
        }
      />

      <div className="mt-8">
        <SignedOut>
          <EmptyState
            icon={Layers}
            title="Sign in to see your projects"
            description="Your projects are tied to your account."
            action={
              <SignInButton>
                <button className={buttonClass({ variant: 'primary' })}>Sign in</button>
              </SignInButton>
            }
          />
        </SignedOut>

        <SignedIn>
          {loading ? (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="animate-pulse overflow-hidden rounded-xl border border-border bg-surface">
                  <div className="aspect-video bg-elevated" />
                  <div className="space-y-2 p-4">
                    <div className="h-4 w-3/4 rounded bg-elevated" />
                    <div className="h-3 w-1/2 rounded bg-elevated" />
                  </div>
                </div>
              ))}
            </div>
          ) : loadError ? (
            <EmptyState
              icon={AlertTriangle}
              tone="danger"
              title="Couldn’t load your projects"
              description={loadError}
              action={
                <button type="button" onClick={() => window.location.reload()} className={buttonClass({ variant: 'secondary' })}>
                  Try again
                </button>
              }
            />
          ) : projects.length === 0 ? (
            <EmptyState
              className="rounded-xl border border-dashed border-border-strong bg-surface py-20"
              icon={Layers}
              title="No projects yet"
              description="Describe an app and Botflow builds it. Your projects will show up here."
              action={
                <Link href="/" className={buttonClass({ variant: 'primary' })}>
                  <Plus className="h-4 w-4" />
                  Create your first project
                </Link>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {projects.map((project) => {
                const hasDatabase = Boolean((project.userConvexUrl || project.convexDeployUrl) && (project.userConvexDeployKey || project.convexDeployKey));
                const thumbnailFailed = Boolean(thumbnailErrors[project.id]);
                const modelLabel = MODEL_CONFIGS[project.model as keyof typeof MODEL_CONFIGS]?.displayName ?? project.model;

                return (
                  <div
                    key={project.id}
                    className={cn(
                      'group relative cursor-pointer rounded-xl border border-border bg-surface shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-md',
                      openMenuId === project.id ? 'z-40' : 'z-0'
                    )}
                    onClick={() => openProject(project.id)}
                  >
                    <div className="relative aspect-video overflow-hidden rounded-t-[11px] border-b border-border bg-elevated">
                      {project.thumbnailUrl && !thumbnailFailed ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={project.thumbnailUrl}
                          alt=""
                          className="h-full w-full object-cover object-top"
                          onError={() => {
                            setThumbnailErrors((prev) => ({ ...prev, [project.id]: true }));
                          }}
                        />
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-subtle">
                          {project.platform === 'swift' ? (
                            <Smartphone className="h-7 w-7" strokeWidth={1.5} />
                          ) : (
                            <Laptop className="h-7 w-7" strokeWidth={1.5} />
                          )}
                          <span className="text-xs">No preview yet</span>
                        </div>
                      )}

                      <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
                        <Badge className="bg-bg text-fg shadow-sm ring-1 ring-black/5">
                          {getProjectPlatformLabel(project.platform)}
                        </Badge>
                        {/* Convex usage guardrail badge (managed backends only) */}
                        {project.backendType === 'platform' && project.convexStatus === 'paused' && (
                          <Badge tone="danger">
                            <PauseCircle className="h-3 w-3" />
                            Backend paused
                          </Badge>
                        )}
                        {project.backendType === 'platform' && project.convexStatus === 'warned' && (
                          <Badge tone="warning">
                            <AlertTriangle className="h-3 w-3" />
                            High usage
                          </Badge>
                        )}
                      </div>

                      {project.isPublic && (
                        <div className="absolute right-2.5 top-2.5">
                          <Badge tone="accent" className="bg-bg/90 backdrop-blur-sm">
                            <Globe className="h-3 w-3" />
                            Public
                            {(project.starCount ?? 0) > 0 && (
                              <>
                                <span className="opacity-50">·</span>
                                <Star className="h-3 w-3 fill-current" />
                                {project.starCount}
                              </>
                            )}
                          </Badge>
                        </div>
                      )}
                    </div>

                    <div className="flex items-start justify-between gap-2 p-4">
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-[15px] font-medium text-fg" title={project.name}>
                          {project.name}
                        </h3>
                        <p className="mt-1 truncate text-[13px] text-muted">
                          {formatDate(project.lastOpened)}
                          <span className="mx-1.5 text-subtle">·</span>
                          {modelLabel}
                        </p>
                      </div>

                      {/* Not `relative`: the menu anchors to the card, so it opens
                          below the card instead of over its own title and date. */}
                      <div className="-mr-1.5 -mt-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuId(openMenuId === project.id ? null : project.id);
                          }}
                          className={buttonClass({ variant: 'ghost', size: 'icon-sm' })}
                          aria-label="Open project actions"
                          aria-haspopup="menu"
                          aria-expanded={openMenuId === project.id}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>

                        {openMenuId === project.id && (
                          <Menu
                            className="absolute right-2 top-full z-50 -mt-1.5 w-56"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MenuItem onClick={() => openProject(project.id)}>
                              <ExternalLink className="h-4 w-4 text-muted" />
                              Open
                            </MenuItem>
                            <MenuItem onClick={() => openDatabaseManager(project.id)} disabled={!hasDatabase}>
                              <Database className="h-4 w-4 text-muted" />
                              Open database
                            </MenuItem>
                            {/* Public visibility is controlled from the
                                project's Publish popover (deploy-gated), not here. */}
                            {project.isPublic && project.publicSlug && (
                              <>
                                <MenuSeparator />
                                <MenuItem onClick={() => handleCopyShareLink(project)}>
                                  {copiedSlug === project.id ? (
                                    <>
                                      <Check className="h-4 w-4 text-success" />
                                      Link copied
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="h-4 w-4 text-muted" />
                                      Copy share link
                                    </>
                                  )}
                                </MenuItem>
                                <a
                                  href={`/p/${project.publicSlug}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  role="menuitem"
                                  onClick={() => setOpenMenuId(null)}
                                  className={menuItemClass}
                                >
                                  <Globe className="h-4 w-4 text-muted" />
                                  View public page
                                </a>
                              </>
                            )}
                            <MenuSeparator />
                            <MenuItem
                              tone="danger"
                              onClick={() => handleDeleteProject(project.id)}
                              disabled={deletingId === project.id}
                            >
                              <Trash2 className="h-4 w-4" />
                              {deletingId === project.id ? 'Deleting…' : 'Delete project'}
                            </MenuItem>
                          </Menu>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SignedIn>
      </div>

      {openMenuId && (
        <div className="fixed inset-0 z-30" onClick={() => setOpenMenuId(null)} />
      )}
    </AppShell>
  );
}
