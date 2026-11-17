"use client";

import { useState } from "react";
import Link from "next/link";
import { Star, Laptop } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  getProjectPlatformLabel,
  type ProjectPlatform,
} from "@/lib/project-platform";

export interface ShowcaseProject {
  id: string;
  name: string;
  platform: ProjectPlatform;
  publicSlug: string;
  publicDescription: string | null;
  thumbnailUrl: string | null;
  htmlSnapshotUrl: string | null;
  starCount: number;
  author: { name: string; imageUrl: string | null };
  hasStarred: boolean;
}

export function ShowcaseCard({ project, compact = false }: { project: ShowcaseProject; compact?: boolean }) {
  // thumbnailUrl is a PNG screenshot; htmlSnapshotUrl is an HTML doc and
  // must not be used as an <img> src. Match the projects page behavior.
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = project.thumbnailUrl;
  // Swift keeps its own label; everything else (web/sandboxed-web and legacy
  // mobile/multiplatform rows) is surfaced as "Web".
  const Icon = Laptop;

  return (
    <Link
      href={`/p/${project.publicSlug}`}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xs transition-[border-color,box-shadow] duration-150",
        "hover:border-border-strong hover:shadow-md"
      )}
    >
      <div className="relative aspect-[16/10] overflow-hidden border-b border-border bg-elevated">
        {thumb && !thumbFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt={project.name}
            onError={() => setThumbFailed(true)}
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-subtle">
            <Icon className="h-7 w-7" strokeWidth={1.5} />
          </div>
        )}

        {/* Platform chip */}
        <div className="absolute left-2.5 top-2.5">
          <Badge className="bg-bg/90 text-fg backdrop-blur-sm">
            {getProjectPlatformLabel(project.platform)}
          </Badge>
        </div>

        {/* Stars chip */}
        {project.starCount > 0 && (
          <div className="absolute right-2.5 top-2.5">
            <Badge tone={project.hasStarred ? "accent" : "neutral"} className="bg-bg/90 backdrop-blur-sm">
              <Star className={cn("h-3 w-3", project.hasStarred && "fill-current")} />
              {project.starCount}
            </Badge>
          </div>
        )}
      </div>

      <div className={cn("p-4 flex-1 flex flex-col", compact && "p-3")}>
        <h3 className="truncate text-[15px] font-medium text-fg" title={project.name}>
          {project.name}
        </h3>
        {project.publicDescription && !compact && (
          <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted">{project.publicDescription}</p>
        )}
        <div className="mt-3 flex items-center gap-2 text-[13px] text-muted">
          {project.author.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={project.author.imageUrl} alt="" className="h-5 w-5 rounded-full border border-border" />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-5 w-5 items-center justify-center rounded-full border border-border bg-elevated text-[10px] font-medium uppercase text-muted"
            >
              {project.author.name.trim().charAt(0)}
            </div>
          )}
          <span className="truncate">{project.author.name}</span>
        </div>
      </div>
    </Link>
  );
}
