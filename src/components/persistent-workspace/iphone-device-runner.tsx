"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Smartphone,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const COMPANION_BASE_URL = "http://127.0.0.1:17321";

type CompanionStatus = "idle" | "checking" | "online" | "offline";
type InstallStatus = "idle" | "building" | "installing";

interface CompanionDevice {
  id: string;
  name: string;
  osVersion: string;
  type: "iphone" | "ipad" | "apple_tv" | "unknown";
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

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
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

      {open && (
        <div className="absolute right-0 top-10 z-50 w-[360px] overflow-hidden rounded-lg border border-border bg-surface shadow-2xl">
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
              <div className="rounded-md border border-border bg-elevated/60 p-3">
                <div className="flex items-start gap-2">
                  <AlertCircle size={16} className="mt-0.5 text-yellow-500" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-fg">Companion offline</div>
                    <div className="mt-1 text-xs leading-5 text-muted">
                      {error ?? "Start Botflow Companion and try again."}
                    </div>
                  </div>
                </div>
              </div>
            ) : devices.length === 0 ? (
              <div className="rounded-md border border-border bg-elevated/60 p-3">
                <div className="text-sm font-medium text-fg">No devices found</div>
                <div className="mt-1 text-xs leading-5 text-muted">
                  Connect an iPhone with Developer Mode enabled.
                </div>
              </div>
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
            <Button
              size="sm"
              className="w-full gap-2"
              disabled={!selectedDevice || isInstalling}
              title={
                selectedDevice ? "Build and install on selected iPhone" : "Select a connected iPhone"
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
        </div>
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
