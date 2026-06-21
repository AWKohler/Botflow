/**
 * App Store pre-flight rejection checklist.
 *
 * Scans a Swift project (in its persistent sandbox) for the most common reasons
 * an AI-built app gets rejected or fails processing, and returns a pass/warn/fail
 * report the Publish wizard surfaces before submit. Read-only — it never mutates
 * the project.
 *
 * Checks: export compliance, permission usage strings (declared vs API use),
 * Guideline 2.5.2 (no downloaded/executed code), app-icon presence, per-device
 * screenshots, and a privacy-policy advisory.
 */

import { sandboxBash } from "@/lib/vercel-sandbox";

export type CheckStatus = "pass" | "warn" | "fail";

export interface PreflightItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** A concrete remediation, shown when status !== 'pass'. */
  fix?: string;
}

export interface PreflightReport {
  items: PreflightItem[];
  summary: { pass: number; warn: number; fail: number };
}

/** Just the project fields this scan needs (screenshots live in the DB, not the sandbox). */
export interface PreflightProject {
  swiftScreenshotIphoneUrl: string | null;
  swiftScreenshotIpadUrl: string | null;
}

// Permission-requiring API → the Info.plist usage-description key Apple requires.
// Missing the key = guaranteed rejection AND a runtime crash on first use.
const PERMISSION_RULES: Array<{ feature: string; apis: string[]; key: string }> = [
  { feature: "Camera", apis: ["AVCaptureDevice", "UIImagePickerController"], key: "NSCameraUsageDescription" },
  { feature: "Microphone", apis: ["AVAudioRecorder", "installTap", "requestRecordPermission"], key: "NSMicrophoneUsageDescription" },
  { feature: "Location", apis: ["CLLocationManager"], key: "NSLocationWhenInUseUsageDescription" },
  { feature: "Photo library", apis: ["PHPhotoLibrary", "PHPickerViewController", "PHAsset"], key: "NSPhotoLibraryUsageDescription" },
  { feature: "Contacts", apis: ["CNContactStore"], key: "NSContactsUsageDescription" },
  { feature: "Calendar", apis: ["EKEventStore"], key: "NSCalendarsUsageDescription" },
  { feature: "Bluetooth", apis: ["CBCentralManager", "CBPeripheralManager"], key: "NSBluetoothAlwaysUsageDescription" },
  { feature: "Motion", apis: ["CMMotionManager", "CMPedometer"], key: "NSMotionUsageDescription" },
  { feature: "Speech recognition", apis: ["SFSpeechRecognizer"], key: "NSSpeechRecognitionUsageDescription" },
  { feature: "App Tracking", apis: ["ATTrackingManager"], key: "NSUserTrackingUsageDescription" },
  { feature: "Face ID", apis: ["LAContext"], key: "NSFaceIDUsageDescription" },
];

// Guideline 2.5.2: an app may not download, install, or execute code that
// changes its features. These are the patterns worth a human's eyes.
const DYNAMIC_CODE_PATTERNS: Array<{ pattern: string; label: string }> = [
  { pattern: "dlopen", label: "dlopen (loading a dynamic library at runtime)" },
  { pattern: "dlsym", label: "dlsym (resolving symbols at runtime)" },
  { pattern: "evaluateScript", label: "JSContext.evaluateScript (executing script)" },
  { pattern: "JavaScriptCore", label: "JavaScriptCore (evaluating JS — only safe for bundled code)" },
  { pattern: "NSClassFromString", label: "NSClassFromString (dynamic class lookup)" },
];

/** Escape a string for safe inclusion in a grep -E alternation. */
function escapeForGrep(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Run a read-only scan in the sandbox. Distinguishes a genuinely empty result
// from a scan FAILURE so absence-based checks (no dynamic code, no data
// collection) never turn a sandbox error into a false "pass".
async function scan(projectId: string, script: string): Promise<{ ok: boolean; out: string }> {
  try {
    const res = await sandboxBash(projectId, script, { timeoutMs: 30_000 });
    return { ok: true, out: res.stdout ?? "" };
  } catch {
    return { ok: false, out: "" };
  }
}

export async function runPreflightChecks(
  projectId: string,
  project: PreflightProject,
): Promise<PreflightReport> {
  const items: PreflightItem[] = [];

  // project.yml is the XcodeGen spec — the source of truth for the generated
  // Info.plist (compliance, usage strings, device family) in our templates.
  const projectYmlScan = await scan(
    projectId,
    `f=$(find . -maxdepth 3 -name project.yml 2>/dev/null | head -1); [ -n "$f" ] && cat "$f" || true`,
  );
  const projectYml = projectYmlScan.out;
  if (!projectYmlScan.ok) {
    // Everything below that reads project.yml is unreliable when we couldn't
    // read it — say so rather than silently passing/failing those checks.
    items.push({
      id: "config",
      label: "Project configuration",
      status: "warn",
      detail:
        "Couldn't read your project config (project.yml), so the compliance and permission-string checks below may be incomplete.",
      fix: "Re-run the readiness check; if it keeps failing, reopen the project so its sandbox is available.",
    });
  }

  // ── 1. Export compliance ──────────────────────────────────────────────────
  // Pass ONLY when explicitly set to NO — a present-but-YES value means the app
  // *does* use non-exempt encryption and still needs compliance documentation.
  if (/ITSAppUsesNonExemptEncryption\s*:\s*["']?(?:NO|false)["']?/i.test(projectYml)) {
    items.push({
      id: "compliance",
      label: "Export compliance",
      status: "pass",
      detail: "ITSAppUsesNonExemptEncryption is set to NO — no 'Missing Compliance' gate on TestFlight.",
    });
  } else if (/ITSAppUsesNonExemptEncryption/.test(projectYml)) {
    items.push({
      id: "compliance",
      label: "Export compliance",
      status: "warn",
      detail:
        "ITSAppUsesNonExemptEncryption is present but not NO — TestFlight will still ask you to document your encryption use.",
      fix: 'Set `ITSAppUsesNonExemptEncryption: NO` in project.yml unless your app uses non-standard (non-HTTPS) encryption.',
    });
  } else {
    items.push({
      id: "compliance",
      label: "Export compliance",
      status: "warn",
      detail: "Not set — every TestFlight build will stall on the 'Missing Compliance' prompt.",
      fix: 'Add `ITSAppUsesNonExemptEncryption: NO` to project.yml (standard HTTPS-only apps qualify for the exemption).',
    });
  }

  // ── 2. Permission usage strings (API use vs declared key) ─────────────────
  const allApis = PERMISSION_RULES.flatMap((r) => r.apis);
  const apiHits = await scan(
    projectId,
    `grep -rEoh '${allApis.map(escapeForGrep).join("|")}' Sources 2>/dev/null | sort -u || true`,
  );
  const usedApis = new Set(apiHits.out.split("\n").map((s) => s.trim()).filter(Boolean));
  for (const rule of PERMISSION_RULES) {
    if (!rule.apis.some((a) => usedApis.has(a))) continue;
    const hasKey = projectYml.includes(rule.key);
    items.push({
      id: `perm-${rule.key}`,
      label: `${rule.feature} permission string`,
      status: hasKey ? "pass" : "fail",
      detail: hasKey
        ? `Uses ${rule.feature} and declares ${rule.key}.`
        : `Uses ${rule.feature} (${rule.apis.join("/")}) but ${rule.key} is missing — Apple rejects this and the app crashes the first time it asks.`,
      ...(hasKey
        ? {}
        : { fix: `Add \`INFOPLIST_KEY_${rule.key}: "<why your app needs ${rule.feature.toLowerCase()}>"\` to project.yml.` }),
    });
  }

  // ── 3. Guideline 2.5.2 — no downloaded/executed code ──────────────────────
  const dynScan = await scan(
    projectId,
    `grep -rEn '${DYNAMIC_CODE_PATTERNS.map((p) => escapeForGrep(p.pattern)).join("|")}' Sources 2>/dev/null | head -20 || true`,
  );
  const dynHits = dynScan.out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!dynScan.ok) {
    items.push({
      id: "guideline-2.5.2",
      label: "Dynamic code (Guideline 2.5.2)",
      status: "warn",
      detail:
        "Couldn't scan your sources for runtime code-loading — re-run to verify. Apple rejects apps that download or run code.",
      fix: "Re-run the readiness check.",
    });
  } else if (dynHits.length === 0) {
    items.push({
      id: "guideline-2.5.2",
      label: "Dynamic code (Guideline 2.5.2)",
      status: "pass",
      detail: "No runtime code-loading patterns detected.",
    });
  } else {
    const matched = DYNAMIC_CODE_PATTERNS.filter((p) => dynHits.some((h) => h.includes(p.pattern)));
    items.push({
      id: "guideline-2.5.2",
      label: "Dynamic code (Guideline 2.5.2)",
      status: "warn",
      detail: `Found ${dynHits.length} site(s) that can execute code at runtime (${matched
        .map((m) => m.label)
        .join("; ")}). Apple rejects apps that download or run code — review these.`,
      fix: "Remove runtime code loading/eval, or confirm it only ever runs code bundled in the app.",
    });
  }

  // ── 4. App icon present ───────────────────────────────────────────────────
  const iconHit = await scan(
    projectId,
    `find . -path '*AppIcon.appiconset/*' \\( -name '*.png' -o -name '*.jpg' \\) 2>/dev/null | head -1`,
  );
  if (iconHit.out.trim()) {
    items.push({ id: "icon", label: "App icon", status: "pass", detail: "A 1024px app icon is present in the asset catalog." });
  } else {
    items.push({
      id: "icon",
      label: "App icon",
      status: "fail",
      detail: "No app-icon image found — Apple fails processing without a 1024×1024 icon.",
      fix: "Generate one in this step (it writes into your asset catalog).",
    });
  }

  // ── 5. Per-device screenshots ─────────────────────────────────────────────
  // Universal by default; iPhone-only when TARGETED_DEVICE_FAMILY is "1".
  const targetsIpad = !/TARGETED_DEVICE_FAMILY:\s*["']?1["'\s]/.test(projectYml);
  items.push(
    project.swiftScreenshotIphoneUrl
      ? { id: "shot-iphone", label: "iPhone screenshot", status: "pass", detail: "An iPhone screenshot was captured from the preview." }
      : {
          id: "shot-iphone",
          label: "iPhone screenshot",
          status: "warn",
          detail: "No iPhone screenshot yet — the App Store needs at least one.",
          fix: "Open the iPhone preview so a frame is captured.",
        },
  );
  if (targetsIpad) {
    items.push(
      project.swiftScreenshotIpadUrl
        ? { id: "shot-ipad", label: "iPad screenshot", status: "pass", detail: "An iPad screenshot is available (app targets iPad)." }
        : {
            id: "shot-ipad",
            label: "iPad screenshot",
            status: "warn",
            detail: 'App targets iPad but has no iPad screenshot — the App Store requires a 13" iPad screenshot for iPad apps.',
            fix: 'Open the iPad preview to capture a frame, or set `TARGETED_DEVICE_FAMILY: "1"` for iPhone-only.',
          },
    );
  }

  // ── 6. Privacy policy (advisory) ──────────────────────────────────────────
  const privacyScan = await scan(
    projectId,
    `grep -rEl 'URLSession|Analytics|Firebase|Mixpanel|Amplitude' Sources 2>/dev/null | head -1`,
  );
  items.push(
    !privacyScan.ok
      ? {
          id: "privacy",
          label: "Privacy policy",
          status: "warn",
          detail:
            "Couldn't scan your sources for data collection — if your app collects any user data, add a privacy policy URL in App Store Connect.",
          fix: "Add a privacy policy URL in App Store Connect → App Information, and complete the Privacy questionnaire.",
        }
      : privacyScan.out.trim()
        ? {
            id: "privacy",
            label: "Privacy policy",
            status: "warn",
            detail: "Your app makes network calls / may collect data. Apple requires a privacy policy URL for data-collecting apps.",
            fix: "Add a privacy policy URL in App Store Connect → App Information, and complete the Privacy questionnaire.",
          }
        : {
            id: "privacy",
            label: "Privacy policy",
            status: "pass",
            detail: "No obvious data collection detected. (Still add a privacy policy if you collect any user data.)",
          },
  );

  const summary = items.reduce(
    (acc, it) => {
      acc[it.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 } as Record<CheckStatus, number>,
  );
  return { items, summary };
}
