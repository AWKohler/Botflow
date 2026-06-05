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

export function IPhoneDeviceRunner() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CompanionStatus>("idle");
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

  const selectedDevice = devices.find((device) => device.id === selectedDeviceId);
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
              disabled={!selectedDevice}
              title={
                selectedDevice
                  ? "Device artifact build is next"
                  : "Select a connected iPhone"
              }
              onClick={() => {
                toast({
                  title: "Device build pending",
                  description: selectedDevice
                    ? `Selected ${selectedDevice.name}. Cloud IPA builds are being wired next.`
                    : "Select a connected iPhone first.",
                });
              }}
            >
              <Smartphone size={14} />
              Install Build
            </Button>
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

async function fetchCompanionJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);

  try {
    const res = await fetch(`${COMPANION_BASE_URL}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
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
