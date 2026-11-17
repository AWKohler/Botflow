"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { AlertTriangle, Sparkles, Search as SearchIcon } from "lucide-react";
import { ShowcaseCard, type ShowcaseProject } from "@/components/showcase/ShowcaseCard";
import { AppShell } from "@/components/site/AppShell";
import { buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { TextInput } from "@/components/ui/field";
import { Tabs } from "@/components/ui/tabs";
import { isSwiftPlatformEnabled } from "@/lib/project-platform";
import { serif } from "@/components/landing/fonts";
import { cn } from "@/lib/utils";

type SortKey = "top" | "recent";
type PlatformFilter = "all" | "web" | "swift";

export default function ExplorePage() {
  const [projects, setProjects] = useState<ShowcaseProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("top");
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("sort", sort);
      params.set("limit", "48");
      if (platform !== "all") params.set("platform", platform);
      const res = await fetch(`/api/public/projects?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      const body = await res.json();
      setProjects(body.projects ?? []);
    } catch (err) {
      console.error(err);
      setError("Something went wrong on our side. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [sort, platform]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = query.trim()
    ? projects.filter((p) => {
        const q = query.toLowerCase();
        return (
          p.name.toLowerCase().includes(q) ||
          (p.publicDescription?.toLowerCase().includes(q)) ||
          p.author.name.toLowerCase().includes(q)
        );
      })
    : projects;

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl text-center">
        <h1 className={cn(serif.className, "text-4xl leading-[1.08] tracking-tight sm:text-5xl")}>
          What people are building <em className={serif.className} style={{ color: "var(--sand-accent)" }}>with Botflow</em>
        </h1>
        <p className="mt-3 text-base leading-relaxed text-muted">
          Open any public project, read the code, and remix it into your own workspace.
        </p>
      </div>

      {/* Controls */}
      <div className="mt-10 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <div className="relative max-w-md flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <TextInput
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, author or description"
            aria-label="Search public projects"
            className="pl-9"
          />
        </div>

        <div className="flex items-center gap-2 sm:ml-auto">
          <Tabs
            options={[
              { value: 'top', text: 'Top' },
              { value: 'recent', text: 'Recent' },
            ]}
            selected={sort}
            onSelect={setSort}
          />
          <Tabs
            options={[
              { value: 'all', text: 'All' },
              { value: 'web', text: 'Web' },
              ...(isSwiftPlatformEnabled() ? [{ value: 'swift' as const, text: 'Swift' }] : []),
            ]}
            selected={platform}
            onSelect={setPlatform}
          />
        </div>
      </div>

      {/* Grid */}
      <div className="mt-8">
        {loading ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="animate-pulse overflow-hidden rounded-xl border border-border bg-surface">
                <div className="aspect-[16/10] bg-elevated" />
                <div className="space-y-2 p-4">
                  <div className="h-4 w-3/4 rounded bg-elevated" />
                  <div className="h-3 w-1/2 rounded bg-elevated" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <EmptyState
            icon={AlertTriangle}
            tone="danger"
            title="Couldn’t load projects"
            description={error}
            action={
              <button type="button" onClick={load} className={buttonClass({ variant: 'secondary' })}>
                Try again
              </button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            className="rounded-xl border border-dashed border-border-strong bg-surface py-20"
            icon={Sparkles}
            title={query.trim() ? 'No matches' : 'Nothing here yet'}
            description={
              query.trim()
                ? 'Try a different search term.'
                : 'Once creators start publishing, their work will show up here.'
            }
            action={
              <Link href="/" className={buttonClass({ variant: 'primary' })}>
                Build something of your own
              </Link>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((p) => (
              <ShowcaseCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
