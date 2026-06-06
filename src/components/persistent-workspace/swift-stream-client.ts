// Browser-side WebSocket client for a Mac simulator session.
//
// Speaks the @sim/shared protocol. Inlined here (no cross-repo dep) so the IDE
// can ship without an extra pnpm workspace pointer.

export type SimSessionState =
  | "queued"
  | "building"
  | "starting"
  | "streaming"
  | "ended"
  | "error";

export type SimLogStream = "stdout" | "stderr";

export interface SimWindowInfo {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export interface SimScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SimDeviceLogical {
  w: number;
  h: number;
}

export interface SimCalibration {
  windowInfo: SimWindowInfo;
  screenRect: SimScreenRect;
  deviceLogical: SimDeviceLogical;
}

export interface SimBuildStatus {
  state: "started" | "succeeded" | "failed";
  exitCode?: number;
  scheme?: string;
  bundleId?: string;
  durationMs?: number;
  message?: string;
}

// Mirrors @sim/shared BuildDiagnostic. Already sanitized by the host —
// `file` is project-relative, never an absolute host path or UUID.
export interface SimBuildDiagnostic {
  severity: "error" | "warning";
  file: string | null;
  line: number | null;
  column: number | null;
  message: string;
  snippet: string[] | null;
}

export interface SimVideoConfig {
  codec: "h264";
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  format: "annexb";
}

export type SimInput =
  | { kind: "tap"; normX: number; normY: number }
  | { kind: "swipe"; startX: number; startY: number; endX: number; endY: number }
  | { kind: "scroll"; normX: number; normY: number; deltaX: number; deltaY: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string };

export interface SimStreamHandlers {
  onState: (state: SimSessionState, queuePosition?: number, reason?: string) => void;
  onCalibration: (cal: SimCalibration) => void;
  onFrame: (jpegBase64: string) => void;
  onVideoConfig: (config: SimVideoConfig) => void;
  onVideoChunk: (chunk: Uint8Array, timestampMs: number, keyframe: boolean) => void;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
  onBuildStatus: (status: SimBuildStatus) => void;
  onBuildLog: (line: string, stream: SimLogStream) => void;
  /** `final:true` = authoritative xcresult set (replaces); `false` = live append. */
  onBuildDiagnostics: (diagnostics: SimBuildDiagnostic[], final: boolean) => void;
  /** The app inside the simulator started (true) or stopped (false) its camera.
   * The UI uses this to lazily prompt for the webcam and start/stop streaming. */
  onCameraRequest?: (active: boolean) => void;
  /** The host reported the device's current orientation (on ready + after a
   * rotate completes). The UI uses this to match the bezel to the live stream. */
  onOrientation?: (orientation: "portrait" | "landscape") => void;
  onOpen: () => void;
  onClose: (code: number) => void;
}

// Binary camera-frame protocol version (must match @sim/shared CAMERA_FRAME_VERSION).
const CAMERA_FRAME_VERSION = 2;

interface ServerMsg {
  type: string;
  [key: string]: unknown;
}

export class SwiftStreamClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly handlers: SimStreamHandlers,
  ) {}

  start(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.handlers.onOpen();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30_000);
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        void this.handleBinary(e.data);
        return;
      }
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data) as ServerMsg;
      } catch {
        return;
      }
      switch (msg.type) {
        case "state":
          this.handlers.onState(
            msg.state as SimSessionState,
            msg.queuePosition as number | undefined,
            msg.reason as string | undefined,
          );
          break;
        case "calibration":
          this.handlers.onCalibration({
            windowInfo: msg.windowInfo as SimWindowInfo,
            screenRect: msg.screenRect as SimScreenRect,
            deviceLogical: msg.deviceLogical as SimDeviceLogical,
          });
          break;
        case "frame":
          this.handlers.onFrame(msg.data as string);
          break;
        case "video_config":
          this.handlers.onVideoConfig({
            codec: "h264",
            width: msg.width as number,
            height: msg.height as number,
            fps: msg.fps as number,
            bitrate: msg.bitrate as number,
            format: "annexb",
          });
          break;
        case "status":
          this.handlers.onStatus(msg.message as string);
          break;
        case "error":
          this.handlers.onError(msg.message as string);
          break;
        case "build_status":
          this.handlers.onBuildStatus({
            state: msg.state as SimBuildStatus["state"],
            exitCode: msg.exitCode as number | undefined,
            scheme: msg.scheme as string | undefined,
            bundleId: msg.bundleId as string | undefined,
            durationMs: msg.durationMs as number | undefined,
            message: msg.message as string | undefined,
          });
          break;
        case "build_log":
          this.handlers.onBuildLog(
            msg.line as string,
            (msg.stream as SimLogStream) ?? "stdout",
          );
          break;
        case "build_diagnostics":
          this.handlers.onBuildDiagnostics(
            (msg.diagnostics as SimBuildDiagnostic[]) ?? [],
            Boolean(msg.final),
          );
          break;
        case "camera_request":
          this.handlers.onCameraRequest?.(Boolean(msg.active));
          break;
        case "orientation":
          if (msg.orientation === "portrait" || msg.orientation === "landscape") {
            this.handlers.onOrientation?.(msg.orientation);
          }
          break;
        case "pong":
          break;
      }
    };

    ws.onclose = (e) => {
      this.cleanup();
      if (!this.closed) this.handlers.onClose(e.code);
    };
  }

  private async handleBinary(data: Blob | ArrayBuffer): Promise<void> {
    const ab = data instanceof Blob ? await data.arrayBuffer() : data;
    const buf = new Uint8Array(ab);
    if (buf.length < 10 || buf[0] !== 1) return;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const flags = view.getUint8(1);
    const timestampMs = Number(view.getBigUint64(2));
    this.handlers.onVideoChunk(buf.subarray(10), timestampMs, (flags & 1) === 1);
  }

  sendInput(input: SimInput): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "input", input }));
  }

  /** Tell the server whether the browser is (about to be) streaming webcam frames. */
  sendCameraState(streaming: boolean, width?: number, height?: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "camera_state", streaming, width, height }));
  }

  /** Send one webcam JPEG frame (reverse media channel) as binary:
   * [ver=2][reserved][timestampMs:u64 BE][jpeg]. */
  sendCameraFrame(jpeg: Uint8Array, timestampMs: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Drop frames if the socket is backed up — a stale webcam frame is worthless.
    if (this.ws.bufferedAmount > 2 * 1024 * 1024) return;
    const packet = new Uint8Array(10 + jpeg.byteLength);
    const view = new DataView(packet.buffer);
    view.setUint8(0, CAMERA_FRAME_VERSION);
    view.setUint8(1, 0); // reserved
    view.setBigUint64(2, BigInt(Math.max(0, Math.floor(timestampMs))));
    packet.set(jpeg, 10);
    this.ws.send(packet);
  }

  /** Ask the host to rotate the device to the given orientation (live, no rebuild). */
  sendSetOrientation(orientation: "portrait" | "landscape"): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "set_orientation", orientation }));
  }

  setCalibration(screenRect: SimScreenRect): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "set_calibration", screenRect }));
  }

  resetCalibration(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "reset_calibration" }));
  }

  close(): void {
    this.closed = true;
    this.cleanup();
    this.ws?.close();
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
