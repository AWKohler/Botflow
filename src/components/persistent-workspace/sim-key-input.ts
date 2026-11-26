// A key press in the browser, as input for the simulator.
import type { SimInput } from "./swift-stream-client";

/** Keys sent by name; the host maps them to HID codes. */
const NAMED_KEYS = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Delete",
]);

/**
 * The simulator input for a keydown, or null when the key is not for the
 * device: shortcuts with Cmd/Ctrl/Alt stay with the browser (copy, paste,
 * devtools), and so do keys the device has no use for.
 */
export function simInputForKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): SimInput | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key.length === 1) return { kind: "text", text: e.key };
  if (NAMED_KEYS.has(e.key)) return { kind: "key", key: e.key };
  return null;
}
