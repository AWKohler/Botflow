// Persisted preview preferences — the device + orientation the user last used.
// Global (not per-project) so the preview comes up on whatever device you were
// last working with. Written by the live preview's pickers AND by the stopped
// placeholder's pickers; read on mount by both so the choice round-trips.
import type { DeviceModelUI, OrientationUI } from "./device-frame";

/**
 * A device the preview can show. The iPhone Duo is not a framed flat screen
 * like the other two (it is a 3D model with two screens; see ./duo), and only
 * some simulator hosts have it, so it is kept apart from DeviceModelUI.
 */
export type PreviewDeviceModel = DeviceModelUI | "iPhone-Duo";

export const PREVIEW_DEVICE_LABELS: Record<PreviewDeviceModel, string> = {
  "iPhone-16-Pro": "iPhone 17 Pro",
  "iPad-Pro": "iPad Pro",
  "iPhone-Duo": "iPhone Duo",
};

/**
 * The device to start on: the one last used, unless this user cannot get it
 * (the Duo, when no host that has it serves them).
 */
export function resolveDevicePref(available: readonly PreviewDeviceModel[]): PreviewDeviceModel {
  const pref = loadDevicePref();
  return available.includes(pref) ? pref : "iPhone-16-Pro";
}

const DEVICE_KEY = "swift-preview:device";
const ORIENT_KEY = "swift-preview:orientation";

export function loadDevicePref(): PreviewDeviceModel {
  if (typeof window === "undefined") return "iPhone-16-Pro";
  try {
    const v = window.localStorage.getItem(DEVICE_KEY);
    if (v === "iPhone-16-Pro" || v === "iPad-Pro" || v === "iPhone-Duo") return v;
  } catch {
    /* localStorage blocked */
  }
  return "iPhone-16-Pro";
}

export function saveDevicePref(device: PreviewDeviceModel): void {
  try {
    window.localStorage.setItem(DEVICE_KEY, device);
  } catch {
    /* localStorage blocked */
  }
}

export function loadOrientationPref(): OrientationUI {
  if (typeof window === "undefined") return "portrait";
  try {
    const v = window.localStorage.getItem(ORIENT_KEY);
    if (v === "portrait" || v === "landscape") return v;
  } catch {
    /* localStorage blocked */
  }
  return "portrait";
}

export function saveOrientationPref(orientation: OrientationUI): void {
  try {
    window.localStorage.setItem(ORIENT_KEY, orientation);
  } catch {
    /* localStorage blocked */
  }
}
