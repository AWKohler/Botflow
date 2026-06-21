"use client";

// "Publish to App Store" wizard — three-step modal flow behind the workspace's
// Publish button (Swift projects only):
//
//   Step 1 — App Info       : name / marketing version / bundle id (persisted
//                             per-project in localStorage).
//   Step 2 — Apple Developer: App Store Connect API key status; inline connect
//                             form when no key is on file (auto-skipped when
//                             already connected).
//   Step 3 — Submit         : waits for the App Store Connect app record
//                             (guided one-time creation panel), then submits a
//                             distribution build and tracks archive → export →
//                             upload progress with a live log tail.
//
// Server contracts (built in parallel — see future/app-store-submission.md):
//   GET  /api/user/apple-credentials
//        → { connected, keyId(masked)|null, teamId|null, teamName|null }
//   POST /api/user/apple-credentials               { issuerId, keyId, p8, teamId? }
//   GET  /api/projects/{id}/swift-publish/app-status?bundleId=X&name=Y
//        → { found, ascAppId?, appName? }  (also registers the bundle id as a
//          side effect so it appears in Apple's "New App" dropdown — labelled
//          with &name, which the wizard always sends)
//   POST /api/projects/{id}/swift-publish/submit   { bundleId, marketingVersion, appName? }
//        → { buildId, state, buildNumber, marketingVersion, bundleId }
//   GET  /api/projects/{id}/swift-publish/build/{buildId}
//        → { buildId, state, logs, diagnostics, error?, durationMs?,
//            apple?: { processed, processingState? } }
//
// Upload vs Apple processing: build state 'succeeded' means the binary was
// UPLOADED and accepted — NOT that Apple finished processing it. After
// 'succeeded' we keep polling and read apple.processingState:
//   absent / 'PROCESSING' (processed:false) → Apple still processing (spinner)
//   'VALID'                                 → ready in TestFlight (success)
//   'INVALID' / 'FAILED'                    → Apple rejected processing (failure)

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  Rocket,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { AppStoreReadinessStep } from "./app-store-readiness-step";

// ── Types matching the swift-publish server contracts ───────────────────────

type WizardStep = 1 | 2 | 3 | 4;

interface AppleCredsState {
  loaded: boolean;
  connected: boolean;
  keyId: string | null; // masked by the server
  teamId: string | null;
  teamName: string | null;
}

type PublishBuildState =
  | "queued"
  | "building"
  | "exporting"
  | "uploading"
  | "succeeded"
  | "failed";

interface PublishLogLine {
  line: string;
  stream: "stdout" | "stderr";
  at: number;
}

interface PublishDiagnostic {
  severity?: "error" | "warning";
  message: string;
  file?: string | null;
  line?: number | null;
}

interface PublishBuildSummary {
  buildId: string;
  state: PublishBuildState;
  // Echoed back from submit; not always present on early build/{id} polls.
  buildNumber?: string;
  marketingVersion?: string;
  bundleId?: string;
  logs?: PublishLogLine[];
  diagnostics?: PublishDiagnostic[];
  error?: string;
  durationMs?: number;
  // Present only after upload succeeds; may still be absent if Apple's
  // processing-state lookup hasn't resolved yet.
  apple?: { processed: boolean; processingState?: string };
}

interface AppStatusState {
  checked: boolean;
  found: boolean;
  appName?: string;
  ascAppId?: string;
}

interface PublishToAppStoreProps {
  projectId: string;
  projectName: string;
  open: boolean;
  onClose: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const APP_NAME_MAX = 30;
const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;
const BUNDLE_ID_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
// After 'succeeded' (= uploaded) we keep polling for Apple's processing state —
// but not forever. Past the cap we stop and point the user at App Store Connect.
const MAX_PROCESSING_POLLS = 60; // ~5 minutes at 5s

const ASC_APPS_URL = "https://appstoreconnect.apple.com/apps";

function ascTestFlightUrl(ascAppId: string): string {
  return `https://appstoreconnect.apple.com/apps/${ascAppId}/testflight/ios`;
}

function ascAppUrl(ascAppId: string | undefined): string {
  return ascAppId
    ? `https://appstoreconnect.apple.com/apps/${ascAppId}/distribution`
    : ASC_APPS_URL;
}

function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}

function defaultBundleId(projectName: string, projectId: string): string {
  return `io.botflow.${slugifyName(projectName)}-${projectId.slice(0, 4)}`;
}

function sanitizeBundleIdInput(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.-]/g, "");
}

// Apple's New App form wants a SKU: any unique internal id, never shown
// publicly. The bundle id (dots→dashes) is a stable, collision-free default.
function suggestSku(bundleId: string, appName: string): string {
  const fromBundle = bundleId.trim().replace(/\./g, "-");
  return fromBundle || slugifyName(appName);
}

const WIZARD_STEPS: Array<{ n: WizardStep; label: string }> = [
  { n: 1, label: "App Info" },
  { n: 2, label: "Apple Developer" },
  { n: 3, label: "App Store Readiness" },
  { n: 4, label: "Submit" },
];

// Vertical tracker: Queued → Building → Exporting → Uploading →
// Processing (Apple) → Done. "processing" maps to state==='succeeded' while
// Apple is still processing; "done" maps to processingState==='VALID'.
type ProgressKey =
  | "queued"
  | "building"
  | "exporting"
  | "uploading"
  | "processing"
  | "done";

const PROGRESS_STEPS: Array<{ key: ProgressKey; label: string; hint: string }> = [
  { key: "queued", label: "Queued", hint: "Waiting for the build Mac" },
  { key: "building", label: "Building", hint: "Archiving and signing for distribution" },
  { key: "exporting", label: "Exporting", hint: "Exporting the signed .ipa" },
  { key: "uploading", label: "Uploading", hint: "Uploading to App Store Connect" },
  { key: "processing", label: "Processing (Apple)", hint: "Apple is processing your build (usually 1–5 min)" },
  { key: "done", label: "Done", hint: "Ready in TestFlight" },
];

// ── Publish phase: a single source of truth derived from the build summary ────
//
//   idle       — no build yet (submit gate)
//   running    — queued | building | exporting | uploading
//   processing — uploaded, Apple still processing (absent / PROCESSING)
//   timeout    — uploaded, still processing past the poll cap (non-error)
//   valid      — Apple processing finished VALID → in TestFlight
//   rejected   — Apple processing finished INVALID/FAILED → Apple rejected it
//   failed     — host-agent caught a build/bundle failure (carries build.error)
type PublishPhase =
  | "idle"
  | "running"
  | "processing"
  | "timeout"
  | "valid"
  | "rejected"
  | "failed";

function appleProcessingState(build: PublishBuildSummary): string | undefined {
  return build.apple?.processingState?.toUpperCase();
}

function derivePhase(
  build: PublishBuildSummary | null,
  processingPolls: number,
): PublishPhase {
  if (!build) return "idle";
  if (build.state === "failed") return "failed";
  if (build.state !== "succeeded") return "running";
  // 'succeeded' === uploaded. Read Apple's processing state.
  const ps = appleProcessingState(build);
  if (ps === "VALID") return "valid";
  if (ps === "INVALID" || ps === "FAILED") return "rejected";
  // absent / PROCESSING / processed:false → still processing.
  if (processingPolls >= MAX_PROCESSING_POLLS) return "timeout";
  return "processing";
}

// Index into PROGRESS_STEPS for the *active* step of a given phase.
function progressIndexForState(state: PublishBuildState): number {
  switch (state) {
    case "queued": return 0;
    case "building": return 1;
    case "exporting": return 2;
    case "uploading": return 3;
    case "succeeded": return 4; // "Processing (Apple)"
    case "failed": return 0; // caller substitutes the last active state
  }
}

function isTerminal(state: PublishBuildState): boolean {
  return state === "succeeded" || state === "failed";
}

// Once a build exists the wizard should stay put: it's still "live" while
// running, while Apple processes, and even on a terminal Apple result (the
// user is reading the success/failure panel). Only "idle" frees navigation.
function phaseIsLive(phase: PublishPhase): boolean {
  return phase === "running" || phase === "processing";
}

// ── Component ────────────────────────────────────────────────────────────────

export function PublishToAppStore({
  projectId,
  projectName,
  open,
  onClose,
}: PublishToAppStoreProps) {
  const { toast } = useToast();
  const storageKey = `swift-publish:${projectId}`;

  const [step, setStep] = useState<WizardStep>(1);
  // Set when the user explicitly navigates back to Step 2 — suppresses the
  // "already connected → auto-advance" jump so they can actually look at it.
  const step2ManualRef = useRef(false);

  // ── Step 1 state (persisted per-project) ──
  const [initialized, setInitialized] = useState(false);
  const [appName, setAppName] = useState("");
  const [marketingVersion, setMarketingVersion] = useState("1.0.0");
  const [bundleId, setBundleId] = useState("");
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // ── Step 2 state (Apple credentials) ──
  const [creds, setCreds] = useState<AppleCredsState>({
    loaded: false,
    connected: false,
    keyId: null,
    teamId: null,
    teamName: null,
  });
  const [p8, setP8] = useState("");
  const [p8FileName, setP8FileName] = useState("");
  const [keyIdInput, setKeyIdInput] = useState("");
  const [issuerIdInput, setIssuerIdInput] = useState("");
  const [teamIdInput, setTeamIdInput] = useState("");
  const [appleSaving, setAppleSaving] = useState(false);
  const [appleError, setAppleError] = useState("");

  // ── Step 3 state (app record + build) ──
  const [appStatus, setAppStatus] = useState<AppStatusState>({ checked: false, found: false });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [build, setBuild] = useState<PublishBuildSummary | null>(null);
  const [pollNonce, setPollNonce] = useState(0);
  const [logOpen, setLogOpen] = useState(false);
  const lastActiveStateRef = useRef<PublishBuildState>("queued");
  const processingPollsRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  // Bumped on every open/close transition so an async .p8 file read that resolves
  // after the modal closed — or closed and reopened — is discarded, not applied.
  const readGenRef = useRef(0);

  // ── Step 1: load persisted values (or defaults) on first open ──
  useEffect(() => {
    if (!open || initialized) return;
    let saved: Partial<{ appName: string; marketingVersion: string; bundleId: string }> = {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) saved = JSON.parse(raw) as typeof saved;
    } catch {
      /* localStorage blocked or corrupted — fall back to defaults */
    }
    setAppName(
      typeof saved.appName === "string" && saved.appName
        ? saved.appName.slice(0, APP_NAME_MAX)
        : (projectName || "My App").slice(0, APP_NAME_MAX),
    );
    setMarketingVersion(
      typeof saved.marketingVersion === "string" && saved.marketingVersion
        ? saved.marketingVersion
        : "1.0.0",
    );
    setBundleId(
      typeof saved.bundleId === "string" && saved.bundleId
        ? saved.bundleId
        : defaultBundleId(projectName, projectId),
    );
    setInitialized(true);
  }, [open, initialized, storageKey, projectName, projectId]);

  // Persist Step-1 fields whenever they change (post-init).
  useEffect(() => {
    if (!initialized) return;
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ appName, marketingVersion, bundleId }),
      );
    } catch {
      /* localStorage blocked — values still live for this session */
    }
  }, [initialized, storageKey, appName, marketingVersion, bundleId]);

  // ── Step 2: fetch credential status on open ──
  const refreshCreds = useCallback(async () => {
    try {
      const res = await fetch("/api/user/apple-credentials", { cache: "no-store" });
      if (!res.ok) {
        setCreds((c) => ({ ...c, loaded: true }));
        return;
      }
      const data = (await res.json()) as {
        connected?: boolean;
        keyId?: string | null;
        teamId?: string | null;
        teamName?: string | null;
      };
      setCreds({
        loaded: true,
        connected: Boolean(data.connected),
        keyId: data.keyId ?? null,
        teamId: data.teamId ?? null,
        teamName: data.teamName ?? null,
      });
    } catch {
      setCreds((c) => ({ ...c, loaded: true }));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshCreds();
  }, [open, refreshCreds]);

  // Auto-advance Step 2 when already connected — unless the user deliberately
  // clicked back to look at it.
  useEffect(() => {
    if (step !== 2) return;
    if (!creds.loaded || !creds.connected) return;
    if (step2ManualRef.current) return;
    setStep(3);
  }, [step, creds.loaded, creds.connected]);

  // ── Escape to close ──
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // ── Submit step: poll app-status every 5s until the app record is found ──
  useEffect(() => {
    if (!open || step !== 4) return;
    if (appStatus.found) return;
    if (build) return; // a build implies the record existed at submit time
    if (!bundleId) return;

    let cancelled = false;
    let timer: number | undefined;

    const check = async (): Promise<void> => {
      try {
        // Always pass &name: the route registers the bundle id as a side effect
        // and labels it with this name so it shows up (and is recognisable) in
        // Apple's "New App" → Bundle ID dropdown.
        const res = await fetch(
          `/api/projects/${projectId}/swift-publish/app-status` +
            `?bundleId=${encodeURIComponent(bundleId)}` +
            `&name=${encodeURIComponent(appName.trim())}`,
          { cache: "no-store" },
        );
        if (res.status === 400) {
          const body = (await res.json().catch(() => null)) as
            | { missingCredentials?: boolean }
            | null;
          if (body?.missingCredentials && !cancelled) {
            setCreds((c) => ({ ...c, connected: false }));
            step2ManualRef.current = true;
            setStep(2);
            return; // stop polling — user must connect first
          }
        } else if (res.ok) {
          const data = (await res.json()) as {
            found: boolean;
            appName?: string;
            ascAppId?: string;
          };
          if (cancelled) return;
          setAppStatus({
            checked: true,
            found: data.found,
            appName: data.appName,
            ascAppId: data.ascAppId,
          });
          if (data.found) return; // stop polling
        }
      } catch {
        /* transient network error — keep polling */
      }
      if (!cancelled) timer = window.setTimeout(() => void check(), 5000);
    };

    void check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [open, step, appStatus.found, build, bundleId, appName, projectId]);

  // Track the last non-terminal state so a failure paints the right step red.
  useEffect(() => {
    if (build && !isTerminal(build.state)) lastActiveStateRef.current = build.state;
  }, [build]);

  // Auto-expand the log on either failure source: a host-agent build failure,
  // or an Apple-rejected (INVALID/FAILED) processing result.
  const buildPhase = derivePhase(build, processingPollsRef.current);
  useEffect(() => {
    if (buildPhase === "failed" || buildPhase === "rejected") setLogOpen(true);
  }, [buildPhase]);

  // Auto-scroll the log tail.
  useEffect(() => {
    if (logOpen) logEndRef.current?.scrollIntoView({ block: "end" });
  }, [logOpen, build?.logs?.length]);

  // ── Step 3: poll the build every 3s while it runs, then every 5s for Apple's
  //    processing state (bounded by MAX_PROCESSING_POLLS). The setTimeout chain
  //    is re-armed via pollNonce so a failed fetch still retries. ──
  //
  //    Stop conditions:
  //      • 'failed'                       — host-agent terminal failure.
  //      • 'succeeded' + VALID/INVALID/FAILED — Apple reached a terminal state.
  //      • 'succeeded' + still processing past the poll cap — give up politely.
  //    NB: when 'succeeded' but `apple` is still absent (enrichment not yet
  //    resolved) we KEEP polling — that's the early "uploaded, processing" gap.
  useEffect(() => {
    if (!open || !build) return;
    if (build.state === "failed") return;
    if (build.state === "succeeded") {
      const ps = appleProcessingState(build);
      const appleTerminal = ps === "VALID" || ps === "INVALID" || ps === "FAILED";
      if (appleTerminal) return;
      if (processingPollsRef.current >= MAX_PROCESSING_POLLS) return;
    }
    // `cancelled` guards every post-await mutation: clearTimeout only cancels a
    // PENDING timer, but a fetch already in flight when the modal closes/unmounts
    // would otherwise setState on a torn-down component.
    let cancelled = false;
    const delay = build.state === "succeeded" ? 5000 : 3000;
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/swift-publish/build/${encodeURIComponent(build.buildId)}`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as PublishBuildSummary;
          if (cancelled) return;
          // Count only the post-upload processing polls toward the cap, and
          // carry forward submit-only fields (buildNumber/marketingVersion/
          // bundleId) that early build/{id} responses may omit.
          if (data.state === "succeeded") processingPollsRef.current += 1;
          setBuild((prev) => ({
            buildNumber: prev?.buildNumber,
            marketingVersion: prev?.marketingVersion,
            bundleId: prev?.bundleId,
            ...data,
          }));
        }
      } catch {
        /* transient — pollNonce bump below re-arms the timer */
      } finally {
        if (!cancelled) setPollNonce((n) => n + 1);
      }
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, build, pollNonce, projectId]);

  // Security: don't retain the .p8 / Key ID / Issuer ID in memory once the modal
  // is closed. (Build progress + the current step are intentionally preserved so
  // an in-flight publish survives a close/reopen; only the secret inputs reset.)
  useEffect(() => {
    readGenRef.current += 1;
    if (open) return;
    setP8("");
    setP8FileName("");
    setKeyIdInput("");
    setIssuerIdInput("");
    setTeamIdInput("");
    setAppleError("");
  }, [open]);

  // A bundle-id change invalidates the app-record status resolved for the prior
  // id — reset so Step 3 re-checks (and never submits with a stale ascAppId).
  useEffect(() => {
    setAppStatus({ checked: false, found: false });
  }, [bundleId]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const copyText = useCallback(
    async (text: string, label: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text);
        toast({ title: "Copied", description: label });
      } catch {
        toast({ title: "Copy blocked", description: "Clipboard access was denied." });
      }
    },
    [toast],
  );

  const validateStep1 = (): string | null => {
    if (!appName.trim()) return "App name is required.";
    if (appName.trim().length > APP_NAME_MAX) return `App name must be at most ${APP_NAME_MAX} characters.`;
    if (!VERSION_RE.test(marketingVersion.trim())) {
      return "Marketing version must look like 1.0 or 1.0.0.";
    }
    if (!BUNDLE_ID_RE.test(bundleId.trim())) {
      return "Bundle ID may only contain lowercase letters, numbers, dots and dashes.";
    }
    return null;
  };

  const handleContinueFromStep1 = (): void => {
    const err = validateStep1();
    if (err) {
      setStep1Error(err);
      return;
    }
    setStep1Error(null);
    step2ManualRef.current = false;
    // The Step-2 auto-advance effect jumps straight to 3 when already connected.
    setStep(2);
  };

  const handleP8File = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const gen = readGenRef.current;
      const text = await file.text();
      if (readGenRef.current !== gen) return; // closed/reopened mid-read — discard
      setP8(text);
      setP8FileName(file.name);
      setAppleError("");
    } catch {
      setAppleError("Could not read the .p8 file.");
    }
  };

  const saveAppleCredentials = async (): Promise<void> => {
    if (!p8 || !keyIdInput.trim() || !issuerIdInput.trim() || appleSaving) return;
    setAppleSaving(true);
    setAppleError("");
    try {
      const res = await fetch("/api/user/apple-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issuerId: issuerIdInput.trim(),
          keyId: keyIdInput.trim(),
          p8,
          ...(teamIdInput.trim() ? { teamId: teamIdInput.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | {
            connected?: boolean;
            keyId?: string | null;
            teamId?: string | null;
            teamName?: string | null;
            error?: string;
          }
        | null;
      if (res.ok && data?.connected) {
        setCreds({
          loaded: true,
          connected: true,
          keyId: data.keyId ?? null,
          teamId: data.teamId ?? null,
          teamName: data.teamName ?? null,
        });
        setP8("");
        setP8FileName("");
        setKeyIdInput("");
        setIssuerIdInput("");
        setTeamIdInput("");
        toast({
          title: "Apple Developer connected",
          description: "Your App Store Connect key was verified and saved.",
        });
        step2ManualRef.current = false;
        setStep(3);
      } else {
        setAppleError(data?.error ?? "Could not save Apple credentials.");
      }
    } catch {
      setAppleError("Unexpected error saving Apple credentials.");
    } finally {
      setAppleSaving(false);
    }
  };

  const handleSubmit = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/swift-publish/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundleId: bundleId.trim(),
          marketingVersion: marketingVersion.trim(),
          appName: appName.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        buildId?: string;
        state?: PublishBuildState;
        buildNumber?: string;
        marketingVersion?: string;
        bundleId?: string;
        error?: string;
        missingCredentials?: boolean;
        appRecordMissing?: boolean;
      };
      if (res.ok && data.buildId) {
        processingPollsRef.current = 0;
        lastActiveStateRef.current = "queued";
        setLogOpen(false);
        setBuild({
          buildId: data.buildId,
          state: data.state ?? "queued",
          buildNumber: data.buildNumber,
          marketingVersion: data.marketingVersion,
          bundleId: data.bundleId,
          logs: [],
          diagnostics: [],
        });
      } else if (res.status === 400 && data.missingCredentials) {
        // Credentials disappeared since the wizard opened — back to Step 2.
        setCreds((c) => ({ ...c, connected: false }));
        setAppleError(data.error ?? "Apple Developer credentials are missing.");
        step2ManualRef.current = true;
        setStep(2);
      } else if (res.status === 409 && data.appRecordMissing) {
        // App record vanished (or never propagated) — back to the waiting panel.
        setAppStatus({ checked: true, found: false });
        setSubmitError(
          data.error ?? "The App Store Connect app record was not found. Create it below.",
        );
      } else {
        setSubmitError(data.error ?? `Submit failed (HTTP ${res.status}).`);
      }
    } catch {
      setSubmitError("Network error while submitting the build.");
    } finally {
      setSubmitting(false);
    }
  };

  // "Live" = a build is in flight or Apple is still processing it: don't let
  // the user navigate away or close-via-stepper while that's happening.
  const buildLive = phaseIsLive(buildPhase);
  // Terminal at every level (host-agent AND Apple): VALID, rejected, failed,
  // or the polite processing-timeout. Used to reset on leaving Step 3.
  const buildSettled =
    build != null &&
    (buildPhase === "valid" ||
      buildPhase === "rejected" ||
      buildPhase === "failed" ||
      buildPhase === "timeout");

  const goToStep = (target: WizardStep): void => {
    if (target === step) return;
    if (target > step) return; // forward only via the flow buttons
    if (buildLive) return; // don't navigate away mid-build / mid-processing
    if (target === 2) step2ManualRef.current = true;
    // Leaving the Submit step after a settled build starts a fresh pass — clear
    // the old build so returning shows the submit gate, not stale progress.
    if (step === 4 && buildSettled) {
      setBuild(null);
      setSubmitError(null);
      setLogOpen(false);
    }
    setStep(target);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <Rocket size={16} className="shrink-0 text-accent" />
            <h2 className="truncate text-sm font-semibold text-fg">Publish to App Store</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-elevated hover:text-fg"
            title="Close"
          >
            <X size={15} />
          </button>
        </div>

        {/* Stepper */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-5 py-3">
          {WIZARD_STEPS.map((s, i) => {
            const done = s.n < step;
            const current = s.n === step;
            const clickable = s.n < step && !buildLive;
            return (
              <div key={s.n} className="flex min-w-0 items-center gap-2">
                {i > 0 && <div className="h-px w-6 shrink-0 bg-border sm:w-10" />}
                <button
                  type="button"
                  onClick={() => goToStep(s.n)}
                  disabled={!clickable}
                  className={cn(
                    "flex items-center gap-2",
                    clickable ? "cursor-pointer" : "cursor-default",
                  )}
                  title={clickable ? `Back to ${s.label}` : undefined}
                >
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition",
                      done
                        ? "border-accent bg-accent text-accent-foreground"
                        : current
                          ? "border-accent bg-accent/15 text-accent"
                          : "border-border bg-elevated text-muted",
                    )}
                  >
                    {done ? <Check size={12} /> : s.n}
                  </span>
                  <span
                    className={cn(
                      "hidden whitespace-nowrap text-xs sm:block",
                      current ? "font-semibold text-fg" : done ? "text-fg/80" : "text-muted",
                    )}
                  >
                    {s.label}
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 modern-scrollbar">
          {step === 1 && (
            <Step1AppInfo
              appName={appName}
              setAppName={(v) => setAppName(v.slice(0, APP_NAME_MAX))}
              marketingVersion={marketingVersion}
              setMarketingVersion={setMarketingVersion}
              bundleId={bundleId}
              setBundleId={(v) => setBundleId(sanitizeBundleIdInput(v))}
              error={step1Error}
            />
          )}

          {step === 2 && (
            <Step2AppleDeveloper
              creds={creds}
              p8FileName={p8FileName}
              hasP8={Boolean(p8)}
              keyIdInput={keyIdInput}
              issuerIdInput={issuerIdInput}
              teamIdInput={teamIdInput}
              saving={appleSaving}
              error={appleError}
              onP8File={(f) => void handleP8File(f)}
              onKeyId={setKeyIdInput}
              onIssuerId={setIssuerIdInput}
              onTeamId={setTeamIdInput}
              onSave={() => void saveAppleCredentials()}
            />
          )}

          {step === 3 && (
            <AppStoreReadinessStep
              projectId={projectId}
              appName={appName}
              bundleId={bundleId}
              marketingVersion={marketingVersion}
            />
          )}

          {step === 4 && (
            <Step3Submit
              appName={appName}
              bundleId={bundleId}
              marketingVersion={marketingVersion}
              appStatus={appStatus}
              creds={creds}
              submitting={submitting}
              submitError={submitError}
              build={build}
              phase={buildPhase}
              lastActiveState={lastActiveStateRef.current}
              logOpen={logOpen}
              onToggleLog={() => setLogOpen((v) => !v)}
              logEndRef={logEndRef}
              onCopy={(text, label) => void copyText(text, label)}
              onSubmit={() => void handleSubmit()}
              onRetry={() => {
                setBuild(null);
                setSubmitError(null);
                setLogOpen(false);
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-border bg-surface/60 px-5 py-3">
          <div className="min-w-0 text-[11px] text-muted">
            {step === 4 && buildPhase === "valid" ? (
              <span className="text-green-500">In TestFlight</span>
            ) : step === 4 && (buildPhase === "rejected" || buildPhase === "failed") ? (
              <span className="text-red-400">Publish failed</span>
            ) : step === 4 && buildPhase === "processing" ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" />
                Apple is processing — keep this tab open
              </span>
            ) : step === 4 && buildPhase === "running" ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" />
                Build in progress — keep this tab open
              </span>
            ) : (
              <span className="truncate">
                {appName.trim() || "App"} · {marketingVersion} · {bundleId}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step > 1 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToStep((step - 1) as WizardStep)}
                disabled={buildLive}
              >
                Back
              </Button>
            )}
            {step === 1 && (
              <Button size="sm" className="gap-1.5 font-semibold" onClick={handleContinueFromStep1}>
                Continue
                <ChevronRight size={13} />
              </Button>
            )}
            {step === 2 && creds.connected && (
              <Button
                size="sm"
                className="gap-1.5 font-semibold"
                onClick={() => {
                  step2ManualRef.current = false;
                  setStep(3);
                }}
              >
                Continue
                <ChevronRight size={13} />
              </Button>
            )}
            {step === 3 && (
              <Button
                size="sm"
                className="gap-1.5 font-semibold"
                onClick={() => setStep(4)}
              >
                Continue
                <ChevronRight size={13} />
              </Button>
            )}
            {step === 4 && buildSettled && (
              <Button size="sm" className="font-semibold" onClick={onClose}>
                Done
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Step 1 — App Info ────────────────────────────────────────────────────────

function Step1AppInfo({
  appName,
  setAppName,
  marketingVersion,
  setMarketingVersion,
  bundleId,
  setBundleId,
  error,
}: {
  appName: string;
  setAppName: (v: string) => void;
  marketingVersion: string;
  setMarketingVersion: (v: string) => void;
  bundleId: string;
  setBundleId: (v: string) => void;
  error: string | null;
}) {
  const versionValid = VERSION_RE.test(marketingVersion.trim());
  const bundleValid = BUNDLE_ID_RE.test(bundleId.trim());

  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-muted">
        How your app appears in TestFlight and on the App Store. You can change the
        name and version later in App Store Connect — the bundle ID is permanent once
        the app record exists.
      </p>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <label htmlFor="publish-app-name" className="text-xs font-medium text-fg">
            App Name
          </label>
          <span
            className={cn(
              "text-[10px] tabular-nums",
              appName.length >= APP_NAME_MAX ? "text-amber-400" : "text-muted",
            )}
          >
            {appName.length}/{APP_NAME_MAX}
          </span>
        </div>
        <input
          id="publish-app-name"
          type="text"
          value={appName}
          maxLength={APP_NAME_MAX}
          onChange={(e) => setAppName(e.target.value)}
          placeholder="My App"
          className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-fg outline-none focus:ring-2 focus:ring-border"
        />
      </div>

      <div>
        <label htmlFor="publish-version" className="mb-1.5 block text-xs font-medium text-fg">
          Marketing Version
        </label>
        <input
          id="publish-version"
          type="text"
          value={marketingVersion}
          onChange={(e) => setMarketingVersion(e.target.value)}
          placeholder="1.0.0"
          className={cn(
            "w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-sm text-fg outline-none focus:ring-2 focus:ring-border",
            marketingVersion && !versionValid ? "border-red-500/50" : "border-border",
          )}
        />
        {marketingVersion && !versionValid && (
          <p className="mt-1 text-[11px] text-red-400">Use a version like 1.0 or 1.0.0.</p>
        )}
      </div>

      <div>
        <label htmlFor="publish-bundle-id" className="mb-1.5 block text-xs font-medium text-fg">
          Bundle ID
        </label>
        <input
          id="publish-bundle-id"
          type="text"
          value={bundleId}
          onChange={(e) => setBundleId(e.target.value)}
          placeholder="io.botflow.my-app"
          spellCheck={false}
          className={cn(
            "w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-sm text-fg outline-none focus:ring-2 focus:ring-border",
            bundleId && !bundleValid ? "border-red-500/50" : "border-border",
          )}
        />
        <p className="mt-1 text-[11px] leading-4 text-muted">
          Lowercase letters, numbers, dots and dashes. This uniquely identifies your app
          with Apple.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-snug text-red-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}

// ── Step 2 — Apple Developer ─────────────────────────────────────────────────

function Step2AppleDeveloper({
  creds,
  p8FileName,
  hasP8,
  keyIdInput,
  issuerIdInput,
  teamIdInput,
  saving,
  error,
  onP8File,
  onKeyId,
  onIssuerId,
  onTeamId,
  onSave,
}: {
  creds: AppleCredsState;
  p8FileName: string;
  hasP8: boolean;
  keyIdInput: string;
  issuerIdInput: string;
  teamIdInput: string;
  saving: boolean;
  error: string;
  onP8File: (f: File | undefined) => void;
  onKeyId: (v: string) => void;
  onIssuerId: (v: string) => void;
  onTeamId: (v: string) => void;
  onSave: () => void;
}) {
  if (!creds.loaded) {
    return (
      <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted">
        <Loader2 size={15} className="animate-spin" />
        Checking Apple Developer connection…
      </div>
    );
  }

  if (creds.connected) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2.5 rounded-md border border-green-500/30 bg-green-500/10 p-3">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-500" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">
              Connected ✓{creds.teamId ? ` ${creds.teamId}` : ""}
            </div>
            <div className="mt-0.5 text-xs text-muted">
              {creds.keyId ? `App Store Connect key ${creds.keyId}` : "App Store Connect key on file"}
              {creds.teamId ? ` · Team ${creds.teamId}` : ""}
            </div>
          </div>
        </div>
        <p className="text-[11px] leading-4 text-muted">
          Builds are signed and uploaded with this key. Manage or replace it in
          Settings → Connections → Apple Developer.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Requirement first: a free Apple ID never sees the Integrations page,
          so users unfamiliar with Apple's flow must hit this BEFORE the
          key-creation instructions, not in a footnote after them. */}
      <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0 text-xs leading-5">
          <div className="text-sm font-semibold text-fg">
            Paid Apple Developer account required — US$99/year
          </div>
          <p className="mt-1 text-muted">
            App Store publishing only works through Apple&apos;s{" "}
            <span className="font-medium text-fg">Apple Developer Program</span> (Apple&apos;s
            fee, not Botflow&apos;s — no free path). A free Apple ID won&apos;t do: without an
            active paid membership the{" "}
            <span className="font-medium text-fg">Integrations</span> page below{" "}
            <span className="font-medium text-fg">doesn&apos;t appear at all</span>. Activation
            can take up to 48 hours after you pay.
          </p>
          <a
            href="https://developer.apple.com/programs/enroll/"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-fg transition hover:bg-amber-500/25"
          >
            Enroll in the Apple Developer Program <ExternalLink size={11} />
          </a>
        </div>
      </div>

      <div className="rounded-md border border-border bg-elevated/60 p-3">
        <div className="text-sm font-medium text-fg">
          Once enrolled, create your API key (one time)
        </div>
        <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-xs leading-5 text-muted">
          <li>
            Open{" "}
            <a
              href="https://appstoreconnect.apple.com/access/integrations/api"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 underline hover:text-fg"
            >
              App Store Connect → Users and Access → Integrations <ExternalLink size={11} />
            </a>{" "}
            — sign in with the <span className="font-medium text-fg">same Apple ID</span> you
            enrolled with.
          </li>
          <li>
            <span className="font-medium text-fg">First time only:</span> if you see{" "}
            <span className="font-medium text-fg">“Request Access”</span> instead of a key
            list, click it and accept Apple&apos;s terms (the{" "}
            <span className="font-medium text-fg">Account Holder</span> must do this). The
            page then shows <span className="font-medium text-fg">Team Keys</span> and a
            “Generate API Key” button.
          </li>
          <li>
            On the <span className="font-medium text-fg">Team Keys</span> tab, click{" "}
            <span className="font-medium text-fg">Generate API Key / “+”</span>, give it a
            Name (≤30 chars) and the <span className="font-medium text-fg">App Manager</span>{" "}
            role.
          </li>
          <li>
            Download the <span className="font-medium text-fg">.p8 file</span> immediately —
            Apple offers it <span className="font-medium text-fg">only once</span>, then the
            link disappears.
          </li>
          <li>
            Copy the <span className="font-medium text-fg">Issuer ID</span> (at the{" "}
            <span className="font-medium text-fg">top of the page</span>, shared by all keys —
            not next to each row) and each key&apos;s{" "}
            <span className="font-medium text-fg">Key ID</span>, then enter everything below.
          </li>
        </ol>
        <p className="mt-2 text-[11px] leading-4 text-muted">
          Tip: if the .p8 download seems stuck or your browser warns the file may be
          dangerous, click <span className="font-medium text-fg">Keep</span> — the .p8 is
          safe.
        </p>
        <p className="mt-1.5 text-[11px] leading-4 text-muted">
          No Integrations tab at all? Your membership isn&apos;t active yet (check for
          Apple&apos;s welcome email) or you&apos;re signed in with a different Apple ID than
          you enrolled with.
        </p>
      </div>

      <div className="space-y-3 rounded-md border border-border bg-elevated/40 p-3">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-fg">Private key (.p8)</label>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border bg-elevated px-3 py-2 text-sm text-muted transition hover:bg-soft/60">
            <input
              type="file"
              accept=".p8,application/x-pem-file,text/plain"
              className="hidden"
              onChange={(e) => onP8File(e.target.files?.[0])}
            />
            {p8FileName ? (
              <span className="font-medium text-fg">{p8FileName}</span>
            ) : (
              <span>Choose your AuthKey_XXXXXXXXXX.p8 file…</span>
            )}
            {hasP8 && <CheckCircle2 size={14} className="ml-auto shrink-0 text-green-500" />}
          </label>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor="publish-apple-key-id" className="mb-1.5 block text-xs font-medium text-fg">
              Key ID
            </label>
            <input
              id="publish-apple-key-id"
              type="text"
              placeholder="e.g. 2X9R4HXF34"
              value={keyIdInput}
              onChange={(e) => onKeyId(e.target.value)}
              className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-fg outline-none focus:ring-2 focus:ring-border"
            />
          </div>
          <div>
            <label htmlFor="publish-apple-issuer-id" className="mb-1.5 block text-xs font-medium text-fg">
              Issuer ID
            </label>
            <input
              id="publish-apple-issuer-id"
              type="text"
              placeholder="69a6de7e-…"
              value={issuerIdInput}
              onChange={(e) => onIssuerId(e.target.value)}
              className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-fg outline-none focus:ring-2 focus:ring-border"
            />
          </div>
        </div>

        <div>
          <label htmlFor="publish-apple-team-id" className="mb-1.5 block text-xs font-medium text-fg">
            Team ID{" "}
            <span className="font-normal text-muted">(optional — detected automatically)</span>
          </label>
          <input
            id="publish-apple-team-id"
            type="text"
            placeholder="e.g. A1B2C3D4E5"
            value={teamIdInput}
            onChange={(e) => onTeamId(e.target.value)}
            className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-fg outline-none focus:ring-2 focus:ring-border"
          />
          <p className="mt-1 text-[11px] leading-4 text-muted">
            We auto-detect it if you leave this blank. To set it manually:{" "}
            <a
              href="https://developer.apple.com/account"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-fg"
            >
              developer.apple.com/account
            </a>{" "}
            → Membership details → Team ID — the 10-char code, not the number in the License
            Agreement PDF&apos;s filename.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-snug text-red-400">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        <Button
          size="sm"
          className="gap-2 font-semibold"
          disabled={!hasP8 || !keyIdInput.trim() || !issuerIdInput.trim() || saving}
          onClick={onSave}
        >
          {saving ? (
            <>
              <Loader2 size={13} className="animate-spin" /> Verifying…
            </>
          ) : (
            "Connect"
          )}
        </Button>
      </div>

    </div>
  );
}

// ── Step 3 — Submit & progress ───────────────────────────────────────────────

function Step3Submit({
  appName,
  bundleId,
  marketingVersion,
  appStatus,
  creds,
  submitting,
  submitError,
  build,
  phase,
  lastActiveState,
  logOpen,
  onToggleLog,
  logEndRef,
  onCopy,
  onSubmit,
  onRetry,
}: {
  appName: string;
  bundleId: string;
  marketingVersion: string;
  appStatus: AppStatusState;
  creds: AppleCredsState;
  submitting: boolean;
  submitError: string | null;
  build: PublishBuildSummary | null;
  phase: PublishPhase;
  lastActiveState: PublishBuildState;
  logOpen: boolean;
  onToggleLog: () => void;
  logEndRef: React.RefObject<HTMLDivElement | null>;
  onCopy: (text: string, label: string) => void;
  onSubmit: () => void;
  onRetry: () => void;
}) {
  // ── Build progress view (once a build exists) ──
  if (build) {
    return (
      <BuildProgress
        build={build}
        phase={phase}
        appName={appName}
        ascAppId={appStatus.ascAppId}
        lastActiveState={lastActiveState}
        logOpen={logOpen}
        onToggleLog={onToggleLog}
        logEndRef={logEndRef}
        onRetry={onRetry}
      />
    );
  }

  // ── Pre-submit gate ──
  //
  // First publish vs update: an UPDATE is found:true AND creds connected — the
  // app record already exists and the build number auto-increments server-side,
  // so it should feel like ~2 clicks (no onboarding guidance). The full guided
  // create-record panel only shows on the first publish (found:false).
  const isUpdate = appStatus.found && creds.connected;
  const displayName = appStatus.appName ?? appName;

  return (
    <div className="space-y-3">
      {appStatus.found ? (
        <div className="flex items-start gap-2.5 rounded-md border border-green-500/30 bg-green-500/10 p-3">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-500" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">
              {isUpdate ? `Ready to publish ${displayName}` : `App record found: ${displayName}`}
            </div>
            <div className="mt-0.5 text-xs text-muted">
              Build version {marketingVersion} and upload it to TestFlight. The build
              number increments automatically.
            </div>
            {appStatus.ascAppId && (
              <a
                href={ascAppUrl(appStatus.ascAppId)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-fg/80 underline hover:text-fg"
              >
                View in App Store Connect <ExternalLink size={10} />
              </a>
            )}
          </div>
        </div>
      ) : (
        <AppRecordGuide appName={appName} bundleId={bundleId} checked={appStatus.checked} onCopy={onCopy} />
      )}

      {submitError && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-snug text-red-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {submitError}
        </div>
      )}

      <Button
        size="sm"
        className="w-full gap-2 font-semibold"
        disabled={!appStatus.found || submitting}
        onClick={onSubmit}
        title={appStatus.found ? "Build and upload to App Store Connect" : "Waiting for the app record"}
      >
        {submitting ? (
          <>
            <Loader2 size={14} className="animate-spin" /> Starting build…
          </>
        ) : (
          <>
            <Rocket size={14} /> {isUpdate ? "Publish update to TestFlight" : "Submit to TestFlight"}
          </>
        )}
      </Button>

      {/* Set expectations so the multi-minute wait never feels stuck. */}
      {appStatus.found && (
        <p className="text-center text-[11px] leading-4 text-muted">
          This takes about 2–5 minutes — building, signing, uploading, then Apple
          processing.
        </p>
      )}
    </div>
  );
}

// ── Guided one-time app-record creation panel ────────────────────────────────

function CopyChip({ value, onCopy, label }: { value: string; onCopy: (text: string, label: string) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onCopy(value, label)}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-elevated px-2 py-0.5 align-middle font-mono text-[11px] text-fg transition hover:bg-soft/60"
      title={`Copy ${label}`}
    >
      <span className="truncate">{value}</span>
      <Copy size={10} className="shrink-0 text-muted" />
    </button>
  );
}

function GuideStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
        {n}
      </span>
      <div className="min-w-0 text-xs leading-5 text-muted">{children}</div>
    </div>
  );
}

function AppRecordGuide({
  appName,
  bundleId,
  checked,
  onCopy,
}: {
  appName: string;
  bundleId: string;
  checked: boolean;
  onCopy: (text: string, label: string) => void;
}) {
  const sku = suggestSku(bundleId, appName);
  // Apple's "New App" dialog lists bundle ids as "<App Name> - <bundle id>". We
  // already registered the id (labelled with the app name) via the app-status
  // poll, so it should be the recognisable entry in that dropdown.
  const dropdownLabel = `${appName} - ${bundleId}`;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-elevated/60 p-3">
        <div className="text-sm font-medium text-fg">Create your app record (one-time)</div>
        <div className="mt-1 text-xs leading-5 text-muted">
          Apple requires the app record to be created by hand in App Store Connect — it
          can&apos;t be done with an API key. Takes about a minute, and only once per app.
          Follow Apple&apos;s <span className="font-medium text-fg">New App</span> form:
        </div>
      </div>

      <div className="space-y-2.5 rounded-md border border-border bg-elevated/40 p-3">
        <GuideStep n={1}>
          Open{" "}
          <a
            href={ASC_APPS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-fg underline"
          >
            App Store Connect → Apps
          </a>{" "}
          <ArrowUpRight size={11} className="inline" />, then click{" "}
          <span className="font-medium text-fg">&quot;+&quot; → New App</span>.
        </GuideStep>
        <GuideStep n={2}>
          Platforms: check <span className="font-medium text-fg">iOS</span>.
        </GuideStep>
        <GuideStep n={3}>
          Name: <CopyChip value={appName} label="app name" onCopy={onCopy} />
        </GuideStep>
        <GuideStep n={4}>
          Primary Language:{" "}
          <span className="font-medium text-fg">English (U.S.)</span> (or your choice).
        </GuideStep>
        <GuideStep n={5}>
          Bundle ID: pick{" "}
          <CopyChip value={dropdownLabel} label="bundle ID entry" onCopy={onCopy} /> from the
          dropdown — <span className="text-fg/80">we already registered it for you.</span>{" "}
          <span className="block mt-0.5 text-muted">
            (It&apos;s the entry ending in{" "}
            <CopyChip value={bundleId} label="bundle ID" onCopy={onCopy} />.)
          </span>
        </GuideStep>
        <GuideStep n={6}>
          SKU: <CopyChip value={sku} label="SKU" onCopy={onCopy} />{" "}
          <span className="block mt-0.5 text-muted">
            Any unique internal id — not shown publicly.
          </span>
        </GuideStep>
        <GuideStep n={7}>
          User Access: <span className="font-medium text-fg">Full Access</span>. Then click{" "}
          <span className="font-medium text-fg">Create</span>.
        </GuideStep>
        <p className="pl-[30px] text-[11px] leading-4 text-muted">
          Fill any other required fields (e.g. Company Name) if Apple asks.
        </p>
      </div>

      <div className="flex items-center gap-2 rounded-md border border-border bg-elevated/60 px-3 py-2 text-xs text-muted">
        <Loader2 size={13} className="shrink-0 animate-spin text-blue-500" />
        {checked
          ? "Waiting for your app record… checking every 5s"
          : "Checking App Store Connect for the app record…"}
      </div>
    </div>
  );
}

// ── Build progress tracker + log tail + diagnostics ──────────────────────────

type StepStatus = "done" | "current" | "stalled" | "failed" | "pending";

// Per-step status across the 6-step tracker, derived purely from the phase.
function stepStatusFor(
  index: number,
  phase: PublishPhase,
  buildState: PublishBuildState,
  lastActiveState: PublishBuildState,
): StepStatus {
  const PROCESSING_IDX = 4; // "Processing (Apple)"
  const DONE_IDX = 5;

  switch (phase) {
    case "valid":
      return "done"; // every step, including "Done", complete
    case "running": {
      const active = progressIndexForState(buildState); // 0..3
      if (index < active) return "done";
      if (index === active) return "current";
      return "pending";
    }
    case "processing":
      if (index < PROCESSING_IDX) return "done";
      if (index === PROCESSING_IDX) return "current";
      return "pending";
    case "timeout":
      // Uploaded; Apple still processing past our poll window — not an error.
      if (index < PROCESSING_IDX) return "done";
      if (index === PROCESSING_IDX) return "stalled";
      return "pending";
    case "rejected":
      // Upload + everything up to it succeeded; Apple rejected processing.
      if (index < PROCESSING_IDX) return "done";
      if (index === PROCESSING_IDX) return "failed";
      return "pending"; // never reached "Done"
    case "failed": {
      // Host-agent failure during build/export/upload.
      const active = progressIndexForState(lastActiveState); // 0..3
      if (index < active) return "done";
      if (index === active) return "failed";
      return "pending";
    }
    default:
      return "pending";
  }
}

function BuildProgress({
  build,
  phase,
  appName,
  ascAppId,
  lastActiveState,
  logOpen,
  onToggleLog,
  logEndRef,
  onRetry,
}: {
  build: PublishBuildSummary;
  phase: PublishPhase;
  appName: string;
  ascAppId: string | undefined;
  lastActiveState: PublishBuildState;
  logOpen: boolean;
  onToggleLog: () => void;
  logEndRef: React.RefObject<HTMLDivElement | null>;
  onRetry: () => void;
}) {
  const logs = build.logs ?? [];
  const tail = logs.slice(-15);
  const diagnostics = build.diagnostics ?? [];
  const buildNumber = build.buildNumber;

  return (
    <div className="space-y-3">
      {/* Build number — surfaces that versioning is automatic. */}
      {buildNumber && (
        <div className="flex items-center justify-between rounded-md border border-border bg-elevated/40 px-3 py-1.5 text-[11px]">
          <span className="text-muted">
            {appName.trim() || "App"}
            {build.marketingVersion ? ` · v${build.marketingVersion}` : ""}
          </span>
          <span className="font-mono font-medium text-fg">Build {buildNumber}</span>
        </div>
      )}

      {/* Vertical progress tracker */}
      <div className="rounded-md border border-border bg-elevated/40 p-3">
        <div className="space-y-0">
          {PROGRESS_STEPS.map((s, i) => {
            const status = stepStatusFor(i, phase, build.state, lastActiveState);
            const isDone = status === "done";
            const isCurrent = status === "current";
            const isStalled = status === "stalled";
            const isFailedHere = status === "failed";
            return (
              <div key={s.key} className="flex items-stretch gap-3">
                <div className="flex flex-col items-center">
                  <div
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                      isFailedHere
                        ? "border-red-500/60 bg-red-500/15 text-red-400"
                        : isDone
                          ? "border-green-500/60 bg-green-500/15 text-green-500"
                          : isCurrent || isStalled
                            ? "border-accent bg-accent/15 text-accent"
                            : "border-border bg-elevated text-muted",
                    )}
                  >
                    {isFailedHere ? (
                      <XCircle size={13} />
                    ) : isDone ? (
                      <Check size={12} />
                    ) : isCurrent ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : isStalled ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />
                    )}
                  </div>
                  {i < PROGRESS_STEPS.length - 1 && (
                    <div
                      className={cn(
                        "w-px flex-1 min-h-3",
                        isDone ? "bg-green-500/40" : "bg-border",
                      )}
                    />
                  )}
                </div>
                <div className="pb-3">
                  <div
                    className={cn(
                      "text-xs font-medium leading-6",
                      isFailedHere
                        ? "text-red-400"
                        : isDone
                          ? "text-fg/80"
                          : isCurrent || isStalled
                            ? "text-fg"
                            : "text-muted",
                    )}
                  >
                    {s.label}
                  </div>
                  {(isCurrent || isStalled) && (
                    <div className="text-[11px] text-muted">
                      {isStalled
                        ? "Still processing — this is taking longer than usual."
                        : s.hint}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Final SUCCESS panel: Apple processing finished VALID → TestFlight ── */}
      {phase === "valid" && (
        <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-500" />
            <div className="min-w-0 text-xs leading-5">
              <div className="text-sm font-medium text-fg">
                {appName.trim() || "Your app"} is in TestFlight ✅
              </div>
              <div className="mt-1 text-muted">
                Your team can install it now — open the TestFlight app on iPhone and sign in
                with your Apple ID.
              </div>
              {ascAppId && (
                <a
                  href={ascTestFlightUrl(ascAppId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-green-500/40 bg-green-500/15 px-2.5 py-1 text-[11px] font-semibold text-fg transition hover:bg-green-500/25"
                >
                  Open in App Store Connect <ExternalLink size={11} />
                </a>
              )}
              <div className="mt-2 text-[11px] text-muted">
                To invite testers outside your team, add external testers in App Store
                Connect (a one-time Beta App Review).
              </div>
              {typeof build.durationMs === "number" && (
                <div className="mt-1 text-[11px] text-muted">
                  Build took {Math.round(build.durationMs / 1000)}s.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Processing panel: uploaded, Apple still processing (spinner) ── */}
      {phase === "processing" && (
        <div className="rounded-md border border-border bg-elevated/40 p-3">
          <div className="flex items-start gap-2.5 text-xs leading-5">
            <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin text-accent" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-fg">
                Apple is processing your build…
              </div>
              <div className="mt-0.5 text-muted">
                Uploaded and accepted. Apple usually finishes in 1–5 minutes — it&apos;ll
                appear in TestFlight automatically.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Timeout panel: still processing past the poll cap (non-error) ── */}
      {phase === "timeout" && (
        <div className="rounded-md border border-border bg-elevated/40 p-3">
          <div className="flex items-start gap-2.5 text-xs leading-5">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-500" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-fg">
                Uploaded — still processing at Apple
              </div>
              <div className="mt-0.5 text-muted">
                Your build was uploaded and accepted. Apple is taking longer than usual to
                finish processing — check App Store Connect; it&apos;ll show up in TestFlight
                once done.
              </div>
              <a
                href={ascAppUrl(ascAppId)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs text-fg underline hover:opacity-80"
              >
                Check in App Store Connect <ExternalLink size={11} />
              </a>
            </div>
          </div>
        </div>
      )}

      {/* ── FAILURE panel: host-agent build failure OR Apple rejected processing ── */}
      {(phase === "failed" || phase === "rejected") && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3">
          <div className="flex items-start gap-2.5">
            <XCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
            <div className="min-w-0 text-xs leading-5">
              <div className="text-sm font-medium text-fg">
                {phase === "rejected"
                  ? "Apple couldn't process this build."
                  : "Build failed"}
              </div>
              {phase === "rejected" ? (
                <>
                  <div className="mt-0.5 text-muted">
                    The binary uploaded, but Apple rejected it during processing — often a
                    missing icon, an unsupported orientation, or an invalid Info.plist.
                  </div>
                  {build.error && (
                    <div className="mt-1 select-text text-red-400">{build.error}</div>
                  )}
                  <div className="mt-1 text-muted">
                    The builds API doesn&apos;t give a detailed reason for this — open App
                    Store Connect to see the specifics.
                  </div>
                </>
              ) : (
                <div className="mt-0.5 select-text text-red-400">
                  {build.error ?? "The build did not complete. Check the log below."}
                </div>
              )}
              <a
                href={ascAppUrl(ascAppId)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs text-fg underline hover:opacity-80"
              >
                Open App Store Connect <ExternalLink size={11} />
              </a>
            </div>
          </div>
          <Button variant="outline" size="sm" className="mt-2.5 w-full" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}

      {/* Diagnostics — severity-colored rows (visual language of the Issues panel) */}
      {diagnostics.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border bg-elevated/40">
          <div className="border-b border-border px-3 py-1.5 text-[11px] font-medium text-muted">
            Issues
          </div>
          <ul className="max-h-40 divide-y divide-border/40 overflow-y-auto">
            {diagnostics.map((d, i) => {
              const isWarning = d.severity === "warning";
              return (
                <li key={i} className="flex items-start gap-2 px-3 py-1.5">
                  <span className={cn("mt-[2px] shrink-0", isWarning ? "text-amber-400" : "text-red-400")}>
                    {isWarning ? <AlertTriangle size={13} /> : <XCircle size={13} />}
                  </span>
                  <span className="min-w-0 flex-1 select-text text-[11.5px] leading-snug text-fg/90">
                    {d.file && (
                      <span className="mr-2 font-mono text-[11px] text-muted">
                        {d.file}
                        {d.line ? `:${d.line}` : ""}
                      </span>
                    )}
                    {d.message}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Collapsible log tail */}
      {logs.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border bg-elevated/40">
          <button
            type="button"
            onClick={onToggleLog}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted transition hover:text-fg"
          >
            {logOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            Build log
            <span className="ml-auto font-mono text-[10px]">{logs.length} lines</span>
          </button>
          {logOpen && (
            <div className="max-h-48 overflow-y-auto border-t border-border bg-elevated/60 px-3 py-2 font-mono text-[10.5px] leading-snug">
              {tail.map((l, i) => (
                <div key={i} className={l.stream === "stderr" ? "text-red-400" : "text-fg/80"}>
                  {l.line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
