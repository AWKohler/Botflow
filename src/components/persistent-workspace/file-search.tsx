"use client";

import { Input } from "@/components/ui/input";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface FileSearchProps {
  projectId: string;
  onOpenFile: (path: string) => void;
}

type Result = {
  file: string;
  line: number;
  text: string;
};

export function FileSearch({ projectId, onOpenFile }: FileSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchIdRef = useRef(0);

  const runSearch = useCallback(async (q: string) => {
    if (!q || q.length < 2) {
      setResults([]);
      setSearching(false);
      setError(null);
      return;
    }
    const id = ++searchIdRef.current;
    setSearching(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/sandbox/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: q, maxResults: 200, caseInsensitive: true }),
      });

      if (id !== searchIdRef.current) return; // canceled

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Search failed (${res.status})`);
        setResults([]);
        return;
      }

      const data = await res.json() as { results: Result[] };
      setResults(data.results ?? []);
    } catch (e) {
      if (id !== searchIdRef.current) return;
      setError(e instanceof Error ? e.message : "Search failed");
      setResults([]);
    } finally {
      if (id === searchIdRef.current) setSearching(false);
    }
  }, [projectId]);

  useEffect(() => {
    const h = setTimeout(() => runSearch(query), 300);
    return () => clearTimeout(h);
  }, [query, runSearch]);

  return (
    <div className="p-2 text-sm">
      <div className="mb-2">
        <div className="flex items-center gap-2 bg-surface border border-border shadow rounded-lg px-3 py-2">
          <span className="text-muted">🔍</span>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files (ripgrep)"
            className="flex-1 bg-transparent outline-none"
          />
        </div>
        <div className="mt-1 text-xs text-muted">
          {error
            ? <span className="text-red-400">{error}</span>
            : searching
              ? "Searching…"
              : results.length > 0
                ? `${results.length} results`
                : query.length < 2
                  ? "Type at least 2 characters"
                  : "No results"}
        </div>
      </div>

      <div className="space-y-1 overflow-auto max-h-full">
        {results.map((r, idx) => (
          <button
            key={`${r.file}:${r.line}:${idx}`}
            onClick={() => onOpenFile(r.file)}
            className={cn(
              "w-full text-left px-2 py-2 rounded-md border border-transparent hover:border-border hover:bg-elevated/60 bolt-hover",
            )}
            title={`${r.file}:${r.line}`}
          >
            <div className="text-muted text-xs truncate">{r.file}</div>
            <div className="text-fg truncate font-mono text-xs">{r.text}</div>
            <div className="text-muted text-[10px]">line {r.line}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
