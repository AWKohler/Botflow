"use client";

import { Input } from "@/components/ui/input";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { Sparkles, Flame, Clock, Search as SearchIcon } from "lucide-react";
import { ShowcaseCard, type ShowcaseProject } from "@/components/showcase/ShowcaseCard";
import { cn } from "@/lib/utils";
import { isSwiftPlatformEnabled } from "@/lib/project-platform";

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
      setError(err instanceof Error ? err.message : "Failed to load");
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
    <div className="antialiased text-fg bg-bg min-h-screen">
      <div className="relative isolate">
        {/* Background gradient */}
        <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <div
            className="absolute -top-1/3 -left-1/4 h-[80vh] w-[80vw] rounded-full blur-3xl opacity-40"
            style={{
              background:
                'radial-gradient(circle, color-mix(in oklab, var(--sand-accent) 28%, transparent) 0%, transparent 68%)',
            }}
          />
          <div
            className="absolute top-1/4 left-1/2 h-[90vh] w-[80vw] -translate-x-1/2 rounded-full blur-3xl opacity-30"
            style={{
              background:
                'radial-gradient(circle, color-mix(in oklab, var(--sand-text-muted) 20%, transparent) 0%, transparent 72%)',
            }}
          />
        </div>

        {/* Nav */}
        <header className="relative">
          <div className="mx-auto max-w-7xl px-6 py-5">
            <div className="grid grid-cols-3 items-center">
              <Link className="flex items-center gap-3" href="/">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/botflow-glyph.svg" alt="" className="h-8 w-8" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/brand/botflow-wordmark.svg"
                  alt="Botflow"
                  className="h-5 w-auto botflow-wordmark-invert"
                />
              </Link>
              <nav className="hidden md:flex items-center justify-center gap-7 text-sm text-muted">
                <a className="hover:text-fg transition" href="/projects">My Projects</a>
                <a className="text-fg font-medium" href="/explore">Explore</a>
                <a className="hover:text-fg transition" href="/pricing">Pricing</a>
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
                  <UserButton afterSignOutUrl="/" />
                </SignedIn>
              </div>
            </div>
          </div>
        </header>

        {/* Hero */}
        <section className="relative">
          <div className="mx-auto max-w-7xl px-6 py-12 sm:py-16">
            <div className="text-center max-w-2xl mx-auto">
              <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight">
                What people are building with{" "}
                <span style={{ color: "var(--sand-accent)" }}>Botflow</span>
              </h1>
              <p className="mt-4 text-muted text-lg">
                Explore public projects. Open any one, see the code, and remix it into your own workspace with one click.
              </p>
            </div>

            {/* Controls */}
            <div className="mt-10 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <div className="relative flex-1 max-w-md">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
                <Input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, author, description…"
                  className="w-full rounded-xl border border-border bg-elevated pl-9 pr-3 py-2 text-sm placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 transition"
                />
              </div>

              <div className="flex items-center gap-2">
                <div className="inline-flex items-center rounded-xl border border-border bg-elevated p-0.5">
                  <button
                    onClick={() => setSort("top")}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                      sort === "top" ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
                    )}
                  >
                    <Flame className="h-4 w-4" />
                    Top
                  </button>
                  <button
                    onClick={() => setSort("recent")}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                      sort === "recent" ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
                    )}
                  >
                    <Clock className="h-4 w-4" />
                    Recent
                  </button>
                </div>

                <div className="inline-flex items-center rounded-xl border border-border bg-elevated p-0.5">
                  <button
                    onClick={() => setPlatform("all")}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                      platform === "all" ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
                    )}
                  >
                    All
                  </button>
                  <button
                    onClick={() => setPlatform("web")}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                      platform === "web" ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
                    )}
                  >
                    Web
                  </button>
                  {isSwiftPlatformEnabled() && (
                    <button
                      onClick={() => setPlatform("swift")}
                      className={cn(
                        "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                        platform === "swift" ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
                      )}
                    >
                      Swift
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Grid */}
            <div className="mt-10">
              {loading ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {[...Array(8)].map((_, i) => (
                    <div key={i} className="rounded-2xl border border-border bg-surface overflow-hidden animate-pulse">
                      <div className="aspect-[16/10] bg-elevated" />
                      <div className="p-4">
                        <div className="h-4 bg-elevated rounded w-3/4 mb-2" />
                        <div className="h-3 bg-elevated rounded w-1/2" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : error ? (
                <div className="text-center py-20">
                  <p className="text-muted">{error}</p>
                  <button
                    onClick={load}
                    className="mt-4 inline-flex items-center gap-2 rounded-xl bg-fg px-4 py-2 text-sm font-medium text-bg shadow-md hover:opacity-90 transition"
                  >
                    Retry
                  </button>
                </div>
              ) : filtered.length === 0 ? (
                <div className="text-center py-20">
                  <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-elevated mb-4">
                    <Sparkles className="h-8 w-8 text-muted" />
                  </div>
                  <h2 className="text-xl font-semibold mb-2">
                    {query.trim() ? "No matches" : "Nothing here yet"}
                  </h2>
                  <p className="text-muted mb-6">
                    {query.trim()
                      ? "Try a different search term."
                      : "Once creators start publishing, their work will show up here."}
                  </p>
                  <Link
                    href="/"
                    className="inline-flex items-center gap-2 rounded-xl bg-fg px-4 py-2 text-sm font-medium text-bg shadow-md hover:opacity-90 transition"
                  >
                    Build something of your own
                  </Link>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {filtered.map((p) => (
                    <ShowcaseCard key={p.id} project={p} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
