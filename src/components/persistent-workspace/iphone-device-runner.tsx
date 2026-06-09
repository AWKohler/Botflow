"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Smartphone,
  X,
  Download,
  ArrowUpRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

// Hosted on Vercel's CDN (public/downloads). Per-OS builds.
const COMPANION_DOWNLOAD_MAC = "/downloads/BotflowCompanion.zip";
const COMPANION_DOWNLOAD_WIN = "/downloads/BotflowCompanionSetup.exe";

const COMPANION_BASE_URL = "http://127.0.0.1:17321";

type HostOS = "mac" | "windows" | "other";
function detectOS(): HostOS {
  if (typeof navigator === "undefined") return "other";
  const s = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
  if (s.includes("win")) return "windows";
  if (s.includes("mac")) return "mac";
  return "other";
}

type CompanionStatus = "idle" | "checking" | "online" | "offline";
type InstallStatus = "idle" | "building" | "installing";

interface CompanionDevice {
  id: string;
  name: string;
  osVersion: string;
  type: "iphone" | "ipad" | "apple_tv" | "unknown";
  // Reported by the companion; absent on older builds (treated as ready).
  developerMode?: "enabled" | "disabled" | "restricted" | string;
  ddiReady?: boolean;
  transport?: string;
}

interface CompanionHealth {
  ok: boolean;
  app: string;
  source: string;
}

interface DevicesResponse {
  devices: CompanionDevice[];
}

interface DeviceBuildSummary {
  buildId: string;
  state: "queued" | "building" | "succeeded" | "failed";
  logs?: Array<{ line: string; stream: "stdout" | "stderr"; at: number }>;
  diagnostics?: Array<{ message: string; file: string | null; line: number | null }>;
  error?: string;
  ipaUrl: string | null;
}

interface CompanionInstallResponse {
  jobId?: string;
  id?: string;
  status?: string;
  state?: string;
  error?: string;
  message?: string;
}

interface IPhoneDeviceRunnerProps {
  projectId: string;
}

export function IPhoneDeviceRunner({ projectId }: IPhoneDeviceRunnerProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CompanionStatus>("idle");
  const [installStatus, setInstallStatus] = useState<InstallStatus>("idle");
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const [devices, setDevices] = useState<CompanionDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; right: number } | null>(null);

  const loadCompanion = useCallback(async () => {
    setStatus("checking");
    setError(null);

    try {
      const health = await fetchCompanionJson<CompanionHealth>("/botflow/v1/health");
      if (!health.ok) throw new Error("Companion is not ready.");

      const data = await fetchCompanionJson<DevicesResponse>("/botflow/v1/devices");
      setDevices(data.devices ?? []);
      setSelectedDeviceId((current) => {
        if (current && data.devices?.some((device) => device.id === current)) {
          return current;
        }

        return data.devices?.[0]?.id ?? null;
      });
      setStatus("online");
    } catch (err) {
      setDevices([]);
      setSelectedDeviceId(null);
      setStatus("offline");
      setError(err instanceof Error ? err.message : "Companion unavailable.");
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    loadCompanion();
  }, [loadCompanion, open]);

  useEffect(() => {
    if (!open) return;

    // Anchor the portal panel under the trigger button (fixed coords).
    const place = () => {
      const r = rootRef.current?.getBoundingClientRect();
      if (r) setPanelPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();

    const onPointerDown = (event: PointerEvent) => {
      const t = event.target as Node;
      // The panel is portaled out of rootRef, so check both.
      if (!rootRef.current?.contains(t) && !panelRef.current?.contains(t)) {
        setOpen(false);
      }
    };

    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const buildAndInstall = useCallback(async () => {
    const selectedDevice = devices.find((device) => device.id === selectedDeviceId);
    if (!selectedDevice || installStatus !== "idle") return;

    try {
      setInstallStatus("building");
      setInstallMessage("Building IPA on Botflow Mac...");

      const start = await fetch(`/api/projects/${projectId}/swift-device/build`, {
        method: "POST",
      });
      if (!start.ok) {
        throw new Error(await responseError(start, "Device build failed to start."));
      }

      let build = (await start.json()) as DeviceBuildSummary;
      for (let attempt = 0; attempt < 90 && !isBuildTerminal(build.state); attempt += 1) {
        await sleep(2000);
        const statusRes = await fetch(
          `/api/projects/${projectId}/swift-device/build/${encodeURIComponent(build.buildId)}`,
          { cache: "no-store" },
        );
        if (!statusRes.ok) {
          throw new Error(await responseError(statusRes, "Device build status failed."));
        }
        build = (await statusRes.json()) as DeviceBuildSummary;
        const lastLog = build.logs?.at(-1)?.line;
        setInstallMessage(lastLog ? trimStatusLine(lastLog) : "Building IPA on Botflow Mac...");
      }

      if (build.state !== "succeeded" || !build.ipaUrl) {
        const diagnostic = build.diagnostics?.[0];
        throw new Error(
          build.error ??
            diagnostic?.message ??
            "Device build did not produce an IPA.",
        );
      }

      setInstallStatus("installing");
      setInstallMessage(`Installing on ${selectedDevice.name}...`);
      const install = await fetchCompanionJson<CompanionInstallResponse>("/botflow/v1/install", {
        method: "POST",
        body: JSON.stringify({
          deviceId: selectedDevice.id,
          ipaUrl: build.ipaUrl,
          projectId,
        }),
      });

      const jobId = install.jobId ?? install.id;
      if (jobId) {
        await pollCompanionInstall(jobId, (message) => setInstallMessage(message));
      } else if (isFailedInstallState(install.status ?? install.state)) {
        throw new Error(install.error ?? install.message ?? "Companion install failed.");
      }

      setInstallStatus("idle");
      setInstallMessage(null);
      toast({
        title: "Installed on iPhone",
        description: `${selectedDevice.name} has the latest Botflow build.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Install failed.";
      setInstallStatus("idle");
      setInstallMessage(null);
      toast({
        title: "iPhone install failed",
        description: message,
      });
    }
  }, [devices, installStatus, projectId, selectedDeviceId, toast]);

  const selectedDevice = devices.find((device) => device.id === selectedDeviceId);
  const isInstalling = installStatus !== "idle";
  // Block install when the companion reports Developer Mode is off (an install
  // would otherwise fail). Unknown/absent (older companion) is treated as ready.
  const devModeBlocked =
    selectedDevice?.developerMode === "disabled" ||
    selectedDevice?.developerMode === "restricted";
  const statusLabel =
    status === "online"
      ? devices.length > 0
        ? `${devices.length} device${devices.length === 1 ? "" : "s"}`
        : "No devices"
      : status === "checking"
        ? "Checking"
        : "Offline";

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="outline"
        size="sm"
        className="gap-2 whitespace-nowrap"
        onClick={() => setOpen((next) => !next)}
        title="Run on iPhone"
      >
        <Smartphone size={15} />
        <span>Run on iPhone</span>
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            status === "online" && devices.length > 0
              ? "bg-green-500"
              : status === "checking"
                ? "bg-blue-500"
                : "bg-muted",
          )}
        />
      </Button>

      {open && panelPos && createPortal(
        <div
          ref={panelRef}
          style={{ position: "fixed", top: panelPos.top, right: panelPos.right }}
          className="z-[1000] w-[360px] overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
        >
          <div className="flex h-11 items-center justify-between border-b border-border px-3">
            <div className="flex items-center gap-2 min-w-0">
              <StatusIcon status={status} hasDevices={devices.length > 0} />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-fg">iPhone Preview</div>
                <div className="truncate text-[11px] text-muted">{statusLabel}</div>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={loadCompanion}
                disabled={status === "checking"}
                title="Refresh devices"
              >
                <RefreshCw size={14} className={status === "checking" ? "animate-spin" : ""} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => setOpen(false)}
                title="Close"
              >
                <X size={14} />
              </Button>
            </div>
          </div>

          <div className="max-h-[420px] overflow-auto p-3">
            {status === "checking" ? (
              <div className="flex h-28 items-center justify-center gap-2 text-sm text-muted">
                <Loader2 size={16} className="animate-spin" />
                Checking companion...
              </div>
            ) : status === "offline" ? (
              <CompanionSetupGuide error={error} onRetry={loadCompanion} />
            ) : devices.length === 0 ? (
              <NoDevicesGuide />
            ) : (
              <div className="space-y-2">
                {devices.map((device) => (
                  <button
                    key={device.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md border p-3 text-left transition",
                      selectedDeviceId === device.id
                        ? "border-accent bg-accent/10"
                        : "border-border bg-elevated/60 hover:bg-soft/60",
                    )}
                    onClick={() => setSelectedDeviceId(device.id)}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface border border-border">
                      <Smartphone size={18} className="text-fg" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-fg">{device.name}</div>
                      <div className="mt-0.5 truncate text-xs text-muted">
                        {deviceTypeLabel(device.type)} {device.osVersion} · {shortDeviceId(device.id)}
                      </div>
                    </div>
                    {selectedDeviceId === device.id && (
                      <CheckCircle2 size={16} className="text-accent" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-border p-3">
            {devModeBlocked && (
              <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                Developer Mode is {selectedDevice?.developerMode === "restricted" ? "restricted on this device" : "off"} on{" "}
                <span className="font-medium">{selectedDevice?.name}</span>. Open the Botflow
                Companion app and click <span className="font-medium">Enable Developer Mode</span>,
                then confirm on the device and retry.
              </div>
            )}
            <Button
              size="sm"
              className="w-full gap-2"
              disabled={!selectedDevice || isInstalling || devModeBlocked}
              title={
                !selectedDevice
                  ? "Select a connected iPhone"
                  : devModeBlocked
                    ? "Enable Developer Mode on the device first"
                    : "Build and install on selected iPhone"
              }
              onClick={buildAndInstall}
            >
              {isInstalling ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Smartphone size={14} />
              )}
              {installStatus === "building"
                ? "Building IPA"
                : installStatus === "installing"
                  ? "Installing"
                  : "Install Build"}
            </Button>
            {installMessage && (
              <div className="mt-2 truncate text-center text-[11px] text-muted">
                {installMessage}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function StatusIcon({
  status,
  hasDevices,
}: {
  status: CompanionStatus;
  hasDevices: boolean;
}) {
  if (status === "checking") {
    return <Loader2 size={16} className="shrink-0 animate-spin text-blue-500" />;
  }

  if (status === "online" && hasDevices) {
    return <CheckCircle2 size={16} className="shrink-0 text-green-500" />;
  }

  if (status === "online") {
    return <Smartphone size={16} className="shrink-0 text-muted" />;
  }

  return <AlertCircle size={16} className="shrink-0 text-muted" />;
}

function deviceTypeLabel(type: CompanionDevice["type"]): string {
  switch (type) {
    case "iphone":
      return "iPhone";
    case "ipad":
      return "iPad";
    case "apple_tv":
      return "Apple TV";
    default:
      return "Device";
  }
}

function shortDeviceId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}...${id.slice(-6)}`;
}

async function fetchCompanionJson<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), init?.method === "POST" ? 15000 : 2500);

  try {
    const res = await fetch(`${COMPANION_BASE_URL}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      body: init?.body,
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Companion returned ${res.status}.`);
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Companion did not respond.");
    }

    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function pollCompanionInstall(
  jobId: string,
  onMessage: (message: string) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await sleep(1000);
    const job = await fetchCompanionJson<CompanionInstallResponse>(
      `/botflow/v1/install/${encodeURIComponent(jobId)}`,
    );
    const state = job.status ?? job.state;
    if (state) onMessage(humanInstallState(state));
    if (isSucceededInstallState(state)) return;
    if (isFailedInstallState(state)) {
      throw new Error(job.error ?? job.message ?? "Companion install failed.");
    }
  }
  throw new Error("Companion install timed out.");
}

function isBuildTerminal(state: DeviceBuildSummary["state"]): boolean {
  return state === "succeeded" || state === "failed";
}

function isSucceededInstallState(state: string | undefined): boolean {
  return state === "succeeded" || state === "success" || state === "installed" || state === "completed";
}

function isFailedInstallState(state: string | undefined): boolean {
  return state === "failed" || state === "error";
}

function humanInstallState(state: string): string {
  switch (state) {
    case "queued":
      return "Waiting for companion...";
    case "running":
    case "installing":
      return "Signing and installing...";
    case "succeeded":
    case "success":
    case "installed":
    case "completed":
      return "Install complete.";
    default:
      return state.replace(/_/g, " ");
  }
}

function trimStatusLine(line: string): string {
  return line.length > 96 ? `${line.slice(0, 93)}...` : line;
}

async function responseError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// ── Setup walkthrough (companion offline) ───────────────────────────────────
function GuideStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
        {n}
      </span>
      <div className="text-xs leading-5 text-muted">{children}</div>
    </div>
  );
}

function CompanionSetupGuide({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const os = detectOS();
  const isWin = os === "windows";
  const isMac = os === "mac";
  const url = isWin ? COMPANION_DOWNLOAD_WIN : COMPANION_DOWNLOAD_MAC;
  const osLabel = isWin ? "Windows" : "macOS";

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-border bg-elevated/60 p-3">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-yellow-500" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-fg">Botflow Companion not running</div>
          <div className="mt-1 text-xs leading-5 text-muted">
            Running an app on your own iPhone happens on your computer. Install the free
            companion — it signs the build with your Apple ID and installs it over USB.
          </div>
        </div>
      </div>

      <a href={url} download className="block">
        <Button className="w-full gap-2 font-semibold">
          <Download size={15} />
          Download Botflow Companion ({osLabel})
        </Button>
      </a>
      {os === "other" && (
        <div className="text-[11px] leading-4 text-muted">
          We auto-detected an unsupported OS. The companion is available for macOS and Windows.
        </div>
      )}

      <div className="space-y-2.5 rounded-md border border-border bg-elevated/40 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Set up (one time)
        </div>
        {isWin ? (
          <>
            <GuideStep n={1}>
              Run <span className="font-medium text-fg">BotflowCompanionSetup.exe</span>. It installs
              the app and Apple&apos;s device driver. If Windows SmartScreen warns,
              click <span className="font-medium text-fg">More info → Run anyway</span>.
            </GuideStep>
            <GuideStep n={2}>It lives in your <span className="font-medium text-fg">system tray</span>. Open it and <span className="font-medium text-fg">sign in with your Apple ID</span> — a free Apple ID works.</GuideStep>
            <GuideStep n={3}>Connect your iPhone with a cable, unlock it, and tap <span className="font-medium text-fg">Trust</span>.</GuideStep>
            <GuideStep n={4}>Click <span className="font-medium text-fg">Enable Developer Mode</span> in the companion, then turn it on in Settings → Privacy &amp; Security and restart the device.</GuideStep>
          </>
        ) : (
          <>
            <GuideStep n={1}>Unzip and drag <span className="font-medium text-fg">Botflow Companion</span> into your Applications folder.</GuideStep>
            <GuideStep n={2}>
              First launch: right-click the app → <span className="font-medium text-fg">Open</span> → Open
              (this clears macOS Gatekeeper for an app downloaded from the web).
            </GuideStep>
            <GuideStep n={3}>It lives in your menu bar. Open it and <span className="font-medium text-fg">sign in with your Apple ID</span> — a free Apple ID works.</GuideStep>
            <GuideStep n={4}>Connect your iPhone with a cable, unlock it, and tap <span className="font-medium text-fg">Trust</span>.</GuideStep>
            <GuideStep n={5}>The companion will guide you to turn on <span className="font-medium text-fg">Developer Mode</span> if it isn&apos;t already.</GuideStep>
          </>
        )}
      </div>

      <Button variant="outline" size="sm" className="w-full gap-2" onClick={onRetry}>
        <RefreshCw size={13} />
        I&apos;ve installed it — check again
      </Button>

      {error && (
        <div className="text-[11px] leading-4 text-muted">{error}</div>
      )}
    </div>
  );
}

// ── No connected device ─────────────────────────────────────────────────────
function NoDevicesGuide() {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-elevated/60 p-3">
        <div className="text-sm font-medium text-fg">No iPhone connected</div>
        <div className="mt-1 text-xs leading-5 text-muted">
          Botflow Companion is running. Now connect your device:
        </div>
      </div>
      <div className="space-y-2.5 rounded-md border border-border bg-elevated/40 p-3">
        <GuideStep n={1}>Plug your iPhone into this computer with a cable and unlock it.</GuideStep>
        <GuideStep n={2}>Tap <span className="font-medium text-fg">Trust This Computer</span> and enter your passcode.</GuideStep>
        <GuideStep n={3}>
          Turn on Developer Mode: <span className="font-medium text-fg">Settings → Privacy &amp; Security → Developer Mode</span>,
          then restart. The companion shows live status and detailed steps.
        </GuideStep>
      </div>
      <a
        href="https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-xs text-muted hover:text-fg"
      >
        <ArrowUpRight size={13} />
        About Developer Mode
      </a>
    </div>
  );
}
