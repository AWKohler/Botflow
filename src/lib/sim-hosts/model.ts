// Simulator host registry: the shapes and rules shared by the admin panel
// (browser) and the server. No server-only imports here.
//
// A "host" is one Mac that serves iOS simulators to Botflow: it runs the
// simulator controller (REST + WebSocket, reached over a tunnel) and a host
// agent that builds the user's app and streams the simulator. Two axes tell
// hosts apart:
//
//  - Runtime, i.e. how much of a user's untrusted code runs inside a
//    Virtualization.framework VM:
//      `isolated`       — the build AND the simulator run in a VM. The goal;
//                         it needs a VM per session, so a lot more hardware.
//      `build-isolated` — the build (the riskiest step: package plugins, build
//                         scripts and the compiler run on user input) runs in a
//                         disposable VM; the built app then runs in a simulator
//                         on the Mac itself, as a restricted user.
//      `unsecure`       — xcodebuild and the simulator both run directly on the
//                         Mac. Only for trusted users (scope it to beta).
//  - macOS generation. macOS 26 hosts run the classic Xcode Simulator.app;
//    macOS 27 and later run Apple's Device Hub, which replaced it.

export const SIM_HOST_RUNTIMES = ["isolated", "build-isolated", "unsecure"] as const;
export type SimHostRuntime = (typeof SIM_HOST_RUNTIMES)[number];

export const SIM_HOST_SCOPES = ["all", "beta"] as const;
export type SimHostScope = (typeof SIM_HOST_SCOPES)[number];

export type SimulatorApp = "simulator" | "device-hub";

/**
 * Apple's licence and Virtualization.framework allow two macOS VMs at once on
 * a stock Mac. A host that has had that cap removed is marked "unlocked".
 */
export const STOCK_VM_LIMIT = 2;

/** Runtimes that use Virtualization.framework VMs at all. */
export function usesVms(runtime: SimHostRuntime): boolean {
  return runtime !== "unsecure";
}

/** Routing preference at equal priority: the more isolated, the earlier. */
export function runtimeRank(runtime: string): number {
  return runtime === "isolated" ? 0 : runtime === "build-isolated" ? 1 : 2;
}

/** The admin-facing record (no secrets). */
export interface SimHost {
  id: string;
  name: string;
  controllerUrl: string;
  /** Browser-facing stream URL; null = derived from controllerUrl. */
  streamUrl: string | null;
  /** The id the host agent reports to its controller (e.g. botflow-mba-26). */
  agentHostId: string | null;
  /** True when this host has its own platform token stored; false = the deployment's SIM_PLATFORM_TOKEN. */
  hasOwnToken: boolean;
  runtime: SimHostRuntime;
  macosVersion: string;
  hardwareModel: string | null;
  chip: string | null;
  ramGb: number | null;
  vmCapUnlocked: boolean;
  maxSessions: number;
  serving: boolean;
  scope: SimHostScope;
  priority: number;
  notes: string | null;
  lastTest: SimHostTestResult | null;
  createdAt: string;
  updatedAt: string;
}

/** Saved after an admin test run. */
export interface SimHostTestResult {
  at: string;
  ok: boolean;
  /** Click → first decoded frame. */
  startupMs: number | null;
  /** Session create + tarball upload (Botflow → controller). */
  provisionMs: number | null;
  /** Host-reported xcodebuild time. */
  buildMs: number | null;
  /** Average decoded frames per second over the sample window. */
  avgFps: number | null;
  /** Worst one-second window during the sample. */
  minFps: number | null;
  /** The stream's advertised frame rate. */
  targetFps: number | null;
  resolution: string | null;
  error: string | null;
}

/** Live status read from the controller's public /health endpoint. */
export interface SimHostHealth {
  reachable: boolean;
  /** The matching host agent is connected to the controller. */
  agentConnected: boolean;
  /**
   * The agent's HOST_KIND ('vm' | 'bare-metal'). 'vm' means the agent itself
   * runs inside a VM; a build-isolated host reports 'bare-metal'. Shown for
   * reference only.
   */
  reportedKind: string | null;
  reportedSlots: number | null;
  activeSessions: number | null;
  /**
   * Device families the agent says it can run (e.g. "iPhone-Duo" only on a
   * Mac whose Xcode has it). Null when the controller predates the field, in
   * which case the host has the iPhone and the iPad and nothing else.
   */
  deviceModels?: string[] | null;
  lastHeartbeatAt: string | null;
  latencyMs: number | null;
  error: string | null;
}

/** Parse "26", "26.1", "27.0.1" → 26 / 27. NaN when unparseable. */
export function macosMajor(version: string): number {
  const m = /^\s*(\d{2,})/.exec(version);
  return m ? Number(m[1]) : Number.NaN;
}

export function simulatorAppFor(macosVersion: string): SimulatorApp {
  return macosMajor(macosVersion) >= 27 ? "device-hub" : "simulator";
}

export function simulatorAppLabel(app: SimulatorApp): string {
  return app === "device-hub" ? "Device Hub" : "Xcode Simulator";
}

export function runtimeLabel(runtime: SimHostRuntime): string {
  if (runtime === "isolated") return "Fully isolated · build and simulator in VMs";
  if (runtime === "build-isolated") return "Build isolated · builds in a VM, simulator on the Mac";
  return "Unsecured · bare metal";
}

/** One-line explanation of a runtime, for the form and tooltips. */
export function runtimeDescription(runtime: SimHostRuntime): string {
  if (runtime === "isolated") {
    return "Each session is built and run inside its own Virtualization.framework VM. Nothing the user wrote runs on the Mac.";
  }
  if (runtime === "build-isolated") {
    return "Builds run in a disposable Virtualization.framework VM; only the built app comes out. It then runs in a simulator on the Mac, as a restricted user.";
  }
  return "xcodebuild and the simulator run directly on the Mac. No VM.";
}

export function scopeLabel(scope: SimHostScope): string {
  return scope === "beta" ? "Beta users only" : "Everyone";
}

export interface SimHostInput {
  name: string;
  controllerUrl: string;
  streamUrl: string | null;
  agentHostId: string | null;
  runtime: SimHostRuntime;
  macosVersion: string;
  hardwareModel: string | null;
  chip: string | null;
  ramGb: number | null;
  vmCapUnlocked: boolean;
  maxSessions: number;
  scope: SimHostScope;
  priority: number;
  notes: string | null;
}

/** Field → message. Empty when valid. Shared by the form and the API. */
export function validateSimHostInput(input: SimHostInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.name.trim()) errors.name = "Give the host a name.";
  else if (input.name.length > 80) errors.name = "80 characters at most.";

  const urlError = (value: string, schemes: string[]): string | null => {
    try {
      const u = new URL(value);
      if (!schemes.includes(u.protocol)) return `Must start with ${schemes.map((s) => `${s}//`).join(" or ")}.`;
      if (u.username || u.password) return "Leave credentials out of the URL.";
      return null;
    } catch {
      return "Not a valid URL.";
    }
  };
  const c = urlError(input.controllerUrl, ["https:", "http:"]);
  if (c) errors.controllerUrl = c;
  if (input.streamUrl) {
    const s = urlError(input.streamUrl, ["wss:", "ws:"]);
    if (s) errors.streamUrl = s;
  }
  if (input.agentHostId && !/^[A-Za-z0-9._-]{1,64}$/.test(input.agentHostId)) {
    errors.agentHostId = "Letters, digits, dots, dashes and underscores only.";
  }
  if (!Number.isFinite(macosMajor(input.macosVersion)) || macosMajor(input.macosVersion) < 15) {
    errors.macosVersion = "Use a macOS version such as 26 or 27.0.";
  }
  if (input.ramGb !== null && (!Number.isInteger(input.ramGb) || input.ramGb < 8 || input.ramGb > 1024)) {
    errors.ramGb = "Between 8 and 1024 GB.";
  }
  if (!Number.isInteger(input.maxSessions) || input.maxSessions < 1 || input.maxSessions > 64) {
    errors.maxSessions = "Between 1 and 64.";
  } else if (input.runtime === "isolated" && !input.vmCapUnlocked && input.maxSessions > STOCK_VM_LIMIT) {
    // Fully isolated = one VM per simulator. (Build-isolated hosts only use
    // VMs for builds, which queue, so the cap doesn't limit simulators.)
    errors.maxSessions = `A stock Mac runs at most ${STOCK_VM_LIMIT} Virtualization.framework VMs, one per simulator here. Mark the host unlocked to allow more.`;
  }
  if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 1000) {
    errors.priority = "Between 0 and 1000.";
  }
  if (input.notes && input.notes.length > 2000) errors.notes = "2000 characters at most.";
  return errors;
}

/** Warnings shown on a host card; most serious first. */
export interface SimHostWarning {
  tone: "danger" | "warning" | "info";
  text: string;
}

export function simHostWarnings(host: SimHost, health: SimHostHealth | null): SimHostWarning[] {
  const out: SimHostWarning[] = [];
  if (host.runtime === "unsecure" && host.serving && host.scope === "all") {
    out.push({
      tone: "danger",
      text: "Unsecured host serving everyone: any user's code is compiled and run directly on this Mac. Scope it to beta users or switch it off.",
    });
  } else if (host.runtime === "unsecure") {
    out.push({
      tone: "warning",
      text: "Unsecured runtime: user code is compiled and run directly on this Mac, outside a VM.",
    });
  }
  if (host.serving && health && !health.reachable) {
    out.push({ tone: "danger", text: "Serving, but the controller is not responding. Users are routed elsewhere." });
  } else if (host.serving && health && !health.agentConnected) {
    out.push({ tone: "danger", text: "Serving, but no host agent is connected to the controller." });
  }
  if (health?.reportedSlots != null && health.reportedSlots < host.maxSessions) {
    out.push({
      tone: "info",
      text: `The agent offers ${health.reportedSlots} slot${health.reportedSlots === 1 ? "" : "s"}; the limit here is ${host.maxSessions}. The lower number applies.`,
    });
  }
  return out;
}
