"use client";

// The devices this user can start a simulator on. The iPhone and the iPad are
// always there; the iPhone Duo only when a host that has it serves them.
import { useEffect, useState } from "react";
import type { PreviewDeviceModel } from "./swift-preview-prefs";

const BASE: PreviewDeviceModel[] = ["iPhone-16-Pro", "iPad-Pro"];

let cached: Promise<PreviewDeviceModel[]> | null = null;

function isDevice(value: unknown): value is PreviewDeviceModel {
  return value === "iPhone-16-Pro" || value === "iPad-Pro" || value === "iPhone-Duo";
}

/** Asked once per page load; a failure just means the base two. */
export function fetchPreviewDevices(): Promise<PreviewDeviceModel[]> {
  cached ??= fetch("/api/swift-preview/config", { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { devices?: unknown };
      const devices = Array.isArray(body.devices) ? body.devices.filter(isDevice) : [];
      return devices.length > 0 ? devices : BASE;
    })
    .catch(() => {
      cached = null; // try again next time
      return BASE;
    });
  return cached;
}

export function usePreviewDevices(): PreviewDeviceModel[] {
  const [devices, setDevices] = useState<PreviewDeviceModel[]>(BASE);
  useEffect(() => {
    let live = true;
    void fetchPreviewDevices().then((d) => {
      if (live) setDevices(d);
    });
    return () => {
      live = false;
    };
  }, []);
  return devices;
}
