// Persisted preview preferences — the device + orientation the user last used.
// Global (not per-project) so the preview comes up on whatever device you were
// last working with. Written by the live preview's pickers AND by the stopped
// placeholder's pickers; read on mount by both so the choice round-trips.
import type { DeviceModelUI, OrientationUI } from "./device-frame";

const DEVICE_KEY = "swift-preview:device";
const ORIENT_KEY = "swift-preview:orientation";

export function loadDevicePref(): DeviceModelUI {
  if (typeof window === "undefined") return "iPhone-16-Pro";
  try {
    const v = window.localStorage.getItem(DEVICE_KEY);
    if (v === "iPhone-16-Pro" || v === "iPad-Pro") return v;
  } catch {
    /* localStorage blocked */
  }
  return "iPhone-16-Pro";
}

export function saveDevicePref(device: DeviceModelUI): void {
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
