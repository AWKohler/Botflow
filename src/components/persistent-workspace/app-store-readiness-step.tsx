"use client";

// "App Store Readiness" — the optional wizard step between Apple Developer and
// Submit. A background, button-driven readiness agent (not a chat): the user
// clicks "Run readiness check" and three things happen against the project's
// sandbox / App Store Connect:
//
//   1. Pre-flight  — GET  .../preflight  runs the rejection checklist and paints
//                    pass/warn/fail rows with a remediation per non-passing item.
//   2. Metadata    — POST .../metadata   drafts name/subtitle/description/keywords
//                    (editable), then POST .../push-metadata ships the approved
//                    text to App Store Connect.
//   3. Icon        — POST .../icon       generates a 1024px icon from a short
//                    prompt and writes it into the app for the next build.
//
// Server contracts (built in parallel — see the route handlers under
// /api/projects/[id]/app-store-readiness/*):
//   GET  .../preflight
//        → { items: Array<{ id, label, status:'pass'|'warn'|'fail', detail, fix? }>,
//            summary: { pass, warn, fail } }
//   POST .../icon          { prompt }   (≤160 chars, enforced here too)
//        → { iconDataUrl, creditsCharged, writtenTo } | { error, insufficientCredits? }
//   POST .../metadata      { appName? }
//        → { metadata:{ name, subtitle, description, keywords }, creditsCharged }
//          | { error, insufficientCredits? }
//   POST .../push-metadata { bundleId, marketingVersion, name?, subtitle?,
//                            description?, keywords? }
//        → { pushed:string[], warnings:string[] }
//          | 400 { error, missingCredentials? } | 409 { error, appRecordMissing? }
//
// Persistence: the edited metadata + last icon prompt are mirrored to
// localStorage (`app-store-readiness:{projectId}`) so they survive close/reopen.
// There are NO secrets in this step — nothing sensitive is ever stored.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ImageIcon,
  Loader2,
  Sparkles,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

// ── Contracts (mirror the route handlers) ────────────────────────────────────

type CheckStatus = "pass" | "warn" | "fail";

interface PreflightItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

interface PreflightReport {
  items: PreflightItem[];
  summary: { pass: number; warn: number; fail: number };
}

interface DraftedMetadata {
  name: string;
  subtitle: string;
  description: string;
  keywords: string;
}

interface PushResult {
  pushed: string[];
  warnings: string[];
}

interface AppStoreReadinessStepProps {
  projectId: string;
  appName: string;
  bundleId: string;
  marketingVersion: string;
}

// ── Field limits (Apple's) ────────────────────────────────────────────────────

const ICON_PROMPT_MAX = 160;
const META_MAX = { name: 30, subtitle: 30, keywords: 100, description: 4000 } as const;

const EMPTY_META: DraftedMetadata = { name: "", subtitle: "", description: "", keywords: "" };

// Human-readable labels for the field keys push-metadata echoes back in `pushed`.
const PUSHED_LABELS: Record<string, string> = {
  name: "Name",
  subtitle: "Subtitle",
  description: "Description",
  keywords: "Keywords",
};

interface PersistedReadiness {
  metadata?: Partial<DraftedMetadata>;
  iconPrompt?: string;
}

function clampMeta(m: Partial<DraftedMetadata> | undefined): DraftedMetadata {
  return {
    name: (m?.name ?? "").slice(0, META_MAX.name),
    subtitle: (m?.subtitle ?? "").slice(0, META_MAX.subtitle),
    keywords: (m?.keywords ?? "").slice(0, META_MAX.keywords),
    description: (m?.description ?? "").slice(0, META_MAX.description),
  };
}

// True once any metadata field carries text — gates the editable form + push.
function hasMeta(m: DraftedMetadata): boolean {
  return Boolean(m.name || m.subtitle || m.description || m.keywords);
}

// ── Component ────────────────────────────────────────────────────────────────

export function AppStoreReadinessStep({
  projectId,
  appName,
  bundleId,
  marketingVersion,
}: AppStoreReadinessStepProps) {
  const { toast } = useToast();
  const storageKey = `app-store-readiness:${projectId}`;

  // ── Pre-flight ──
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);

  // ── Metadata (drafted, then edited) ──
  const [metadata, setMetadata] = useState<DraftedMetadata>(EMPTY_META);
  const [metaDrafting, setMetaDrafting] = useState(false);
  const [metaCredits, setMetaCredits] = useState<number | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  // ── Push to App Store Connect ──
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<PushResult | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  // Distinct inline nudges keep the copy specific to the failure mode.
  const [appRecordMissing, setAppRecordMissing] = useState(false);
  const [missingCredentials, setMissingCredentials] = useState(false);

  // ── Icon ──
  const [iconPrompt, setIconPrompt] = useState("");
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null);
  const [iconCredits, setIconCredits] = useState<number | null>(null);
  const [iconGenerating, setIconGenerating] = useState(false);
  const [iconUploading, setIconUploading] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);
  // Whether the last-set icon actually landed in the project (writtenTo != null).
  const [iconWritten, setIconWritten] = useState(false);
  const iconFileRef = useRef<HTMLInputElement | null>(null);

  // ── Credits: a single friendly "out of credits" banner, set by whichever
  //    action hit a 402. Cleared when any action is retried. ──
  const [outOfCredits, setOutOfCredits] = useState(false);

  const [initialized, setInitialized] = useState(false);

  // ── Hydrate persisted edits on mount (NEVER secrets — there are none here). ──
  useEffect(() => {
    let saved: PersistedReadiness = {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) saved = JSON.parse(raw) as PersistedReadiness;
    } catch {
      /* localStorage blocked or corrupted — start clean */
    }
    if (saved.metadata) setMetadata(clampMeta(saved.metadata));
    if (typeof saved.iconPrompt === "string") {
      setIconPrompt(saved.iconPrompt.slice(0, ICON_PROMPT_MAX));
    }
    setInitialized(true);
  }, [storageKey]);

  // ── Persist edited metadata + icon prompt (post-hydrate). ──
  useEffect(() => {
    if (!initialized) return;
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ metadata, iconPrompt } satisfies PersistedReadiness),
      );
    } catch {
      /* localStorage blocked — values still live for this session */
    }
  }, [initialized, storageKey, metadata, iconPrompt]);

  const setMetaField = useCallback(
    (key: keyof DraftedMetadata, value: string) => {
      setMetadata((m) => ({ ...m, [key]: value.slice(0, META_MAX[key]) }));
    },
    [],
  );

  // Latest metadata, readable inside callbacks without widening their deps —
  // lets us skip the PAID re-draft when the user already has a listing.
  const metadataRef = useRef(metadata);
  useEffect(() => {
    metadataRef.current = metadata;
  }, [metadata]);

  // Draft the store listing via the paid model endpoint. Skips the charge when
  // metadata already exists (persisted or edited) unless `force` — re-running
  // the checklist must never silently re-bill. The "Redraft" action forces it.
  const draftMetadata = useCallback(
    async (force: boolean) => {
      if (!force && hasMeta(metadataRef.current)) return;
      setMetaDrafting(true);
      setMetaError(null);
      setOutOfCredits(false);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/app-store-readiness/metadata`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ appName: appName.trim() || undefined }),
          },
        );
        const data = (await res.json().catch(() => ({}))) as {
          metadata?: DraftedMetadata;
          creditsCharged?: number;
          error?: string;
          insufficientCredits?: boolean;
        };
        if (res.ok && data.metadata) {
          // Forced redraft replaces; an opportunistic draft only fills when the
          // listing is empty so it never clobbers edits the user already made.
          setMetadata((cur) =>
            force || !hasMeta(cur) ? clampMeta(data.metadata) : cur,
          );
          setMetaCredits(data.creditsCharged ?? null);
        } else if (res.status === 402 || data.insufficientCredits) {
          setOutOfCredits(true);
        } else {
          setMetaError(data.error || `Couldn't draft metadata (HTTP ${res.status}).`);
        }
      } catch {
        setMetaError("Network error drafting metadata.");
      } finally {
        setMetaDrafting(false);
      }
    },
    [projectId, appName],
  );

  // ── Run readiness check: preflight + (first-time) metadata draft, concurrently. ──
  const runReadinessCheck = useCallback(async () => {
    if (checking || metaDrafting) return;
    setChecking(true);
    setPreflightError(null);
    setOutOfCredits(false);

    const preflight = (async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/app-store-readiness/preflight`,
          { cache: "no-store" },
        );
        const data = (await res.json().catch(() => ({}))) as
          | (PreflightReport & { error?: string })
          | { error?: string };
        if (res.ok && "items" in data && Array.isArray(data.items)) {
          setReport({ items: data.items, summary: data.summary });
        } else {
          setPreflightError(
            ("error" in data && data.error) || `Pre-flight failed (HTTP ${res.status}).`,
          );
        }
      } catch {
        setPreflightError("Network error running the pre-flight checks.");
      } finally {
        setChecking(false);
      }
    })();

    // draftMetadata owns its own spinner and skips the charge when a listing
    // already exists, so re-running the checklist only re-runs preflight.
    await Promise.all([preflight, draftMetadata(false)]);
  }, [checking, metaDrafting, projectId, draftMetadata]);

  // ── Generate icon. ──
  const generateIcon = useCallback(async () => {
    const prompt = iconPrompt.trim();
    if (!prompt || iconGenerating || iconUploading) return;
    if (prompt.length > ICON_PROMPT_MAX) {
      setIconError(`Keep the prompt under ${ICON_PROMPT_MAX} characters.`);
      return;
    }
    setIconGenerating(true);
    setIconError(null);
    setOutOfCredits(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/app-store-readiness/icon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        iconDataUrl?: string;
        creditsCharged?: number;
        writtenTo?: string | null;
        error?: string;
        insufficientCredits?: boolean;
      };
      if (res.ok && data.iconDataUrl) {
        setIconDataUrl(data.iconDataUrl);
        setIconCredits(data.creditsCharged ?? null);
        setIconWritten(Boolean(data.writtenTo));
        toast({
          title: "Icon generated",
          description: data.writtenTo
            ? "Saved into your app — the next build will use it."
            : "Generated, but couldn't write it into the project.",
        });
      } else if (res.status === 402 || data.insufficientCredits) {
        setOutOfCredits(true);
      } else {
        setIconError(data.error || `Couldn't generate the icon (HTTP ${res.status}).`);
      }
    } catch {
      setIconError("Network error generating the icon.");
    } finally {
      setIconGenerating(false);
    }
  }, [iconPrompt, iconGenerating, iconUploading, projectId, toast]);

  // ── Upload your own icon (no model, no credits — normalized server-side). ──
  const uploadIcon = useCallback(
    async (file: File | undefined) => {
      if (!file || iconUploading || iconGenerating) return;
      setIconUploading(true);
      setIconError(null);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/projects/${projectId}/app-store-readiness/icon-upload`, {
          method: "POST",
          body: form,
        });
        const data = (await res.json().catch(() => ({}))) as {
          iconDataUrl?: string;
          writtenTo?: string | null;
          error?: string;
        };
        if (res.ok && data.iconDataUrl) {
          setIconDataUrl(data.iconDataUrl);
          setIconCredits(null); // uploads are free
          setIconWritten(Boolean(data.writtenTo));
          toast({
            title: "Icon set",
            description: data.writtenTo
              ? "Saved into your app — the next build will use it."
              : "Uploaded, but couldn't write it into the project.",
          });
        } else {
          setIconError(data.error || `Couldn't set the icon (HTTP ${res.status}).`);
        }
      } catch {
        setIconError("Network error uploading the icon.");
      } finally {
        setIconUploading(false);
        if (iconFileRef.current) iconFileRef.current.value = "";
      }
    },
    [iconUploading, iconGenerating, projectId, toast],
  );

  // ── Push approved metadata to App Store Connect. ──
  const pushMetadata = useCallback(async () => {
    if (pushing || !hasMeta(metadata)) return;
    setPushing(true);
    setPushError(null);
    setPushResult(null);
    setAppRecordMissing(false);
    setMissingCredentials(false);
    setOutOfCredits(false);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/app-store-readiness/push-metadata`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bundleId: bundleId.trim(),
            marketingVersion: marketingVersion.trim(),
            // Only send non-empty fields; the route ignores blanks anyway.
            ...(metadata.name.trim() ? { name: metadata.name.trim() } : {}),
            ...(metadata.subtitle.trim() ? { subtitle: metadata.subtitle.trim() } : {}),
            ...(metadata.description.trim() ? { description: metadata.description.trim() } : {}),
            ...(metadata.keywords.trim() ? { keywords: metadata.keywords.trim() } : {}),
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        pushed?: string[];
        warnings?: string[];
        error?: string;
        appRecordMissing?: boolean;
        missingCredentials?: boolean;
        insufficientCredits?: boolean;
      };
      if (res.ok && Array.isArray(data.pushed)) {
        setPushResult({ pushed: data.pushed, warnings: data.warnings ?? [] });
        const names = data.pushed.map((k) => PUSHED_LABELS[k] ?? k).join(", ");
        toast({
          title: "Pushed to App Store Connect",
          description: names ? `Updated ${names}.` : "Metadata sent.",
        });
      } else if (res.status === 402 || data.insufficientCredits) {
        setOutOfCredits(true);
      } else if (res.status === 409 && data.appRecordMissing) {
        setAppRecordMissing(true);
      } else if (res.status === 400 && data.missingCredentials) {
        setMissingCredentials(true);
      } else {
        setPushError(data.error || `Push failed (HTTP ${res.status}).`);
      }
    } catch {
      setPushError("Network error pushing metadata.");
    } finally {
      setPushing(false);
    }
  }, [pushing, metadata, projectId, bundleId, marketingVersion, toast]);

  const metaReady = hasMeta(metadata);
  const runDisabled = checking || metaDrafting;
  const runBusy = checking || metaDrafting;

  return (
    <div className="space-y-5">
      <p className="text-xs leading-5 text-muted">
        Optional but recommended. A quick automated pass that catches the App
        Store rejections AI-built apps hit most, drafts your store listing, and
        can generate an app icon — all before you submit. Nothing here blocks
        publishing; skip it any time with <span className="font-medium text-fg">Continue to submit</span>.
      </p>

      {/* Out-of-credits banner (shared across actions). */}
      {outOfCredits && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          You&apos;re out of credits this week. Your weekly credits will refresh — try
          again then, or upgrade for more.
        </div>
      )}

      {/* ── Run readiness check ── */}
      <div>
        <Button
          size="sm"
          className="gap-2 font-semibold"
          disabled={runDisabled}
          onClick={() => void runReadinessCheck()}
        >
          {runBusy ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              Running checks…
            </>
          ) : (
            <>
              <Sparkles size={13} />
              {report ? "Re-run readiness check" : "Run readiness check"}
            </>
          )}
        </Button>
        <p className="mt-1.5 text-[11px] leading-4 text-muted">
          Runs the pre-flight checklist and drafts your store listing at the same
          time.
        </p>
      </div>

      {/* ── Pre-flight checklist ── */}
      <PreflightChecklist
        report={report}
        loading={checking}
        error={preflightError}
      />

      {/* ── Icon subsection ── */}
      <section className="space-y-3 rounded-md border border-border bg-elevated/40 p-3">
        <div className="flex items-center gap-2">
          <ImageIcon size={14} className="shrink-0 text-accent" />
          <h3 className="text-sm font-semibold text-fg">App icon</h3>
        </div>
        <p className="text-[11px] leading-4 text-muted">
          Describe the icon you want. We generate a 1024px icon and write it into
          your app so the <span className="font-medium text-fg">next build</span> picks it up.
        </p>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <label htmlFor="readiness-icon-prompt" className="text-xs font-medium text-fg">
              Icon prompt
            </label>
            <span
              className={cn(
                "text-[10px] tabular-nums",
                iconPrompt.length >= ICON_PROMPT_MAX ? "text-amber-400" : "text-muted",
              )}
            >
              {iconPrompt.length}/{ICON_PROMPT_MAX}
            </span>
          </div>
          <input
            id="readiness-icon-prompt"
            type="text"
            value={iconPrompt}
            maxLength={ICON_PROMPT_MAX}
            onChange={(e) => setIconPrompt(e.target.value.slice(0, ICON_PROMPT_MAX))}
            placeholder="A minimal teal compass on a dark gradient, rounded, flat"
            className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-fg outline-none focus:ring-2 focus:ring-border"
          />
        </div>

        <div className="flex items-start gap-3">
          <Button
            size="sm"
            variant="outline"
            className="gap-2 font-semibold"
            disabled={!iconPrompt.trim() || iconGenerating || iconUploading}
            onClick={() => void generateIcon()}
          >
            {iconGenerating ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles size={13} />
                {iconDataUrl ? "Regenerate icon" : "Generate icon"}
              </>
            )}
          </Button>

          <input
            ref={iconFileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => void uploadIcon(e.target.files?.[0])}
          />
          <Button
            size="sm"
            variant="ghost"
            className="gap-2"
            disabled={iconUploading || iconGenerating}
            onClick={() => iconFileRef.current?.click()}
            title="Use your own icon (we resize to 1024px + flatten transparency)"
          >
            {iconUploading ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                Uploading…
              </>
            ) : (
              <>
                <UploadCloud size={13} />
                Upload your own
              </>
            )}
          </Button>

          {iconDataUrl && (
            <div className="flex items-center gap-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={iconDataUrl}
                alt="Generated app icon"
                className="h-14 w-14 rounded-[14px] border border-border object-cover shadow-sm"
              />
              <div className="text-[11px] leading-4 text-muted">
                {iconWritten ? (
                  <div className="flex items-center gap-1 text-green-500">
                    <CheckCircle2 size={12} className="shrink-0" />
                    Saved into your app
                  </div>
                ) : (
                  <div className="flex items-center gap-1 text-amber-400">
                    <AlertTriangle size={12} className="shrink-0" />
                    Generated, but not saved — try again
                  </div>
                )}
                {iconCredits != null && (
                  <div className="mt-0.5">{iconCredits} credits</div>
                )}
              </div>
            </div>
          )}
        </div>

        {iconError && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-snug text-red-400">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {iconError}
          </div>
        )}
      </section>

      {/* ── Metadata subsection ── */}
      <section className="space-y-3 rounded-md border border-border bg-elevated/40 p-3">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="shrink-0 text-accent" />
          <h3 className="text-sm font-semibold text-fg">Store listing</h3>
          {metaCredits != null && (
            <span className="ml-auto text-[10px] text-muted">{metaCredits} credits</span>
          )}
          {metaReady && (
            <button
              type="button"
              onClick={() => void draftMetadata(true)}
              disabled={metaDrafting}
              className={cn(
                "inline-flex items-center gap-1 text-[11px] font-medium text-accent transition hover:text-accent/80 disabled:opacity-50",
                metaCredits == null && "ml-auto",
              )}
              title="Generate a fresh AI draft — uses credits and replaces the current listing"
            >
              {metaDrafting ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Sparkles size={11} />
              )}
              Redraft
            </button>
          )}
        </div>

        {metaError && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-snug text-red-400">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {metaError}
          </div>
        )}

        {!metaReady ? (
          <p className="text-[11px] leading-4 text-muted">
            {metaDrafting ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" />
                Drafting your name, subtitle, description and keywords…
              </span>
            ) : (
              <>Run the readiness check above to draft an editable store listing here.</>
            )}
          </p>
        ) : (
          <>
            <p className="text-[11px] leading-4 text-muted">
              Drafted from your app — edit anything, then push it to your App Store
              Connect listing.
            </p>

            <MetaField
              id="readiness-meta-name"
              label="Name"
              value={metadata.name}
              max={META_MAX.name}
              onChange={(v) => setMetaField("name", v)}
              placeholder="App name as shown on the store"
            />
            <MetaField
              id="readiness-meta-subtitle"
              label="Subtitle"
              value={metadata.subtitle}
              max={META_MAX.subtitle}
              onChange={(v) => setMetaField("subtitle", v)}
              placeholder="Short tagline under the name"
            />
            <MetaField
              id="readiness-meta-keywords"
              label="Keywords"
              value={metadata.keywords}
              max={META_MAX.keywords}
              onChange={(v) => setMetaField("keywords", v)}
              placeholder="comma,separated,keywords"
              mono
            />

            <div>
              <div className="mb-1.5 flex items-baseline justify-between">
                <label htmlFor="readiness-meta-description" className="text-xs font-medium text-fg">
                  Description
                </label>
                <span
                  className={cn(
                    "text-[10px] tabular-nums",
                    metadata.description.length >= META_MAX.description
                      ? "text-amber-400"
                      : "text-muted",
                  )}
                >
                  {metadata.description.length}/{META_MAX.description}
                </span>
              </div>
              <textarea
                id="readiness-meta-description"
                value={metadata.description}
                maxLength={META_MAX.description}
                onChange={(e) => setMetaField("description", e.target.value)}
                rows={6}
                placeholder="What your app does, who it's for, why it's great…"
                className="w-full resize-y rounded-lg border border-border bg-elevated px-3 py-2 text-sm leading-5 text-fg outline-none focus:ring-2 focus:ring-border modern-scrollbar"
              />
            </div>

            {/* Push result / failure-mode nudges. */}
            {pushResult && (
              <div className="space-y-2 rounded-md border border-green-500/30 bg-green-500/10 p-3">
                <div className="flex items-start gap-2 text-xs text-fg">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-green-500" />
                  <span>
                    {pushResult.pushed.length > 0 ? (
                      <>
                        Pushed:{" "}
                        <span className="font-medium">
                          {pushResult.pushed.map((k) => PUSHED_LABELS[k] ?? k).join(", ")}
                        </span>
                        .
                      </>
                    ) : (
                      <>Sent to App Store Connect.</>
                    )}
                  </span>
                </div>
                {pushResult.warnings.length > 0 && (
                  <ul className="space-y-1 pl-6 text-[11px] leading-4 text-amber-400">
                    {pushResult.warnings.map((w, i) => (
                      <li key={i} className="list-disc">
                        {w}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {appRecordMissing && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-400">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                Create your app record first (in the Submit step), then push.
              </div>
            )}

            {missingCredentials && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-400">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                Connect your App Store Connect key first (Apple Developer step), then
                push.
              </div>
            )}

            {pushError && (
              <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-snug text-red-400">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                {pushError}
              </div>
            )}

            <Button
              size="sm"
              className="gap-2 font-semibold"
              disabled={pushing || !metaReady}
              onClick={() => void pushMetadata()}
            >
              {pushing ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Pushing…
                </>
              ) : (
                <>
                  <UploadCloud size={13} />
                  Push to App Store Connect
                </>
              )}
            </Button>
          </>
        )}
      </section>
    </div>
  );
}

// ── Pre-flight checklist ──────────────────────────────────────────────────────

const STATUS_META: Record<
  CheckStatus,
  { icon: typeof CheckCircle2; tone: string; row: string }
> = {
  pass: { icon: CheckCircle2, tone: "text-green-500", row: "border-border bg-elevated/40" },
  warn: { icon: AlertTriangle, tone: "text-amber-400", row: "border-amber-500/30 bg-amber-500/10" },
  fail: { icon: XCircle, tone: "text-red-400", row: "border-red-500/30 bg-red-500/10" },
};

function PreflightChecklist({
  report,
  loading,
  error,
}: {
  report: PreflightReport | null;
  loading: boolean;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-snug text-red-400">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        {error}
      </div>
    );
  }

  if (!report) {
    if (loading) {
      return (
        <div className="flex h-20 items-center justify-center gap-2 rounded-md border border-border bg-elevated/40 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" />
          Scanning your project…
        </div>
      );
    }
    return null;
  }

  const { summary } = report;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2.5 text-xs">
        <span className="font-medium text-fg">Pre-flight</span>
        <span className="flex items-center gap-2 text-[11px] tabular-nums text-muted">
          <span className={cn(summary.fail > 0 && "text-red-400")}>{summary.fail} fail</span>
          <span aria-hidden>·</span>
          <span className={cn(summary.warn > 0 && "text-amber-400")}>{summary.warn} warn</span>
          <span aria-hidden>·</span>
          <span className={cn(summary.pass > 0 && "text-green-500")}>{summary.pass} pass</span>
        </span>
        {loading && <Loader2 size={12} className="ml-auto animate-spin text-muted" />}
      </div>

      <ul className="space-y-1.5">
        {report.items.map((item) => {
          const meta = STATUS_META[item.status];
          const Icon = meta.icon;
          return (
            <li
              key={item.id}
              className={cn("rounded-md border px-3 py-2", meta.row)}
            >
              <div className="flex items-start gap-2">
                <Icon size={14} className={cn("mt-0.5 shrink-0", meta.tone)} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-fg">{item.label}</div>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted">{item.detail}</p>
                  {item.status !== "pass" && item.fix && (
                    <p className="mt-1 text-[11px] leading-4 text-fg/80">
                      <span className="font-medium text-fg">Fix: </span>
                      {item.fix}
                    </p>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── A single short metadata field with a live character counter. ──────────────

function MetaField({
  id,
  label,
  value,
  max,
  onChange,
  placeholder,
  mono,
}: {
  id: string;
  label: string;
  value: string;
  max: number;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label htmlFor={id} className="text-xs font-medium text-fg">
          {label}
        </label>
        <span
          className={cn(
            "text-[10px] tabular-nums",
            value.length >= max ? "text-amber-400" : "text-muted",
          )}
        >
          {value.length}/{max}
        </span>
      </div>
      <input
        id={id}
        type="text"
        value={value}
        maxLength={max}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={!mono}
        className={cn(
          "w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-fg outline-none focus:ring-2 focus:ring-border",
          mono && "font-mono",
        )}
      />
    </div>
  );
}
