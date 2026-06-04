// Browser webcam → simulator capture manager.
//
// Acquires the user's webcam via getUserMedia (this triggers the browser's
// camera-permission prompt), then samples it to JPEG at ~15fps and hands each
// frame to `onFrame`. The caller forwards those frames over the simulator
// WebSocket, where the host agent relays them into the injected camera shim.
//
// Latest-wins: if an encode is still in flight when the next tick fires, the
// tick is skipped rather than queued.

export type CameraCaptureState =
  | "idle"
  | "requesting"
  | "active"
  | "denied"
  | "unsupported";

export interface CameraCaptureOptions {
  onFrame: (jpeg: Uint8Array, timestampMs: number) => void;
  onStateChange?: (state: CameraCaptureState) => void;
  /** Target capture size; the browser picks the nearest supported. */
  width?: number;
  height?: number;
  /** Frames per second to sample (default 15). */
  fps?: number;
  /** JPEG quality 0–1 (default 0.6). */
  quality?: number;
}

export class SwiftCameraCapture {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private encoding = false;
  private _state: CameraCaptureState = "idle";
  private readonly startedAt = Date.now();

  constructor(private readonly opts: CameraCaptureOptions) {}

  get state(): CameraCaptureState {
    return this._state;
  }

  private setState(s: CameraCaptureState): void {
    if (this._state === s) return;
    this._state = s;
    this.opts.onStateChange?.(s);
  }

  async start(): Promise<void> {
    if (this._state === "active" || this._state === "requesting") return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this.setState("unsupported");
      return;
    }
    this.setState("requesting");
    const width = this.opts.width ?? 640;
    const height = this.opts.height ?? 480;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: width }, height: { ideal: height } },
        audio: false,
      });
    } catch {
      // User denied, or no device. Either way we stop here.
      this.setState("denied");
      return;
    }

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = this.stream;
    try {
      await video.play();
    } catch {
      /* autoplay of a muted stream rarely fails; ignore */
    }
    this.video = video;

    const vw = video.videoWidth || width;
    const vh = video.videoHeight || height;
    this.canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(vw, vh)
        : Object.assign(document.createElement("canvas"), { width: vw, height: vh });

    const fps = this.opts.fps ?? 15;
    this.timer = setInterval(() => void this.tick(), Math.max(1, Math.round(1000 / fps)));
    this.setState("active");
  }

  private async tick(): Promise<void> {
    if (this.encoding || !this.video || !this.canvas) return;
    const video = this.video;
    if (video.readyState < 2 /* HAVE_CURRENT_DATA */) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    if (this.canvas.width !== vw || this.canvas.height !== vh) {
      this.canvas.width = vw;
      this.canvas.height = vh;
    }
    const ctx = this.canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, vw, vh);

    this.encoding = true;
    const quality = this.opts.quality ?? 0.6;
    try {
      const blob = await this.toBlob(this.canvas, quality);
      if (blob) {
        const buf = new Uint8Array(await blob.arrayBuffer());
        this.opts.onFrame(buf, Date.now() - this.startedAt);
      }
    } catch {
      /* drop this frame */
    } finally {
      this.encoding = false;
    }
  }

  private toBlob(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    quality: number,
  ): Promise<Blob | null> {
    if (canvas instanceof OffscreenCanvas) {
      return canvas.convertToBlob({ type: "image/jpeg", quality });
    }
    return new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality),
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.stream) {
      // Stopping tracks turns off the browser's webcam indicator light.
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.canvas = null;
    this.encoding = false;
    this.setState("idle");
  }
}
