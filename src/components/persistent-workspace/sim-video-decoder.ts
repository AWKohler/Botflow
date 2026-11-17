// H.264 decoding for the simulator stream, with recovery.
//
// A WebCodecs VideoDecoder closes itself permanently on any error. Left alone,
// every later chunk then fails with "Cannot call 'decode' on a closed codec",
// which hides the real error and kills the stream for good. This wrapper owns
// the decoder's lifecycle instead: it rebuilds a failed decoder, steps down
// from the software decoder to the browser's default one, and only gives up —
// reporting the decoder's own error — after repeated failures.

/** Which decoder implementation to ask the browser for. */
type Acceleration = "prefer-software" | "no-preference";

interface BufferedChunk {
  data: Uint8Array;
  timestampMs: number;
  keyframe: boolean;
}

export interface SimVideoDecoderOptions {
  width: number;
  height: number;
  /** Called for each decoded frame. The frame is closed after this returns. */
  onFrame: (frame: VideoFrame) => void;
  /** Recovery was exhausted. `message` is the decoder's own error. */
  onFatal: (message: string) => void;
}

/** Consecutive failures tolerated before giving up. */
const MAX_FAILURES = 4;
/** Frames a decoder must emit before its earlier failures are forgotten. */
const HEALTHY_FRAMES = 60;
/** Upper bound on the buffered GOP. The host sends a keyframe every second
 * (60 chunks); a stream that goes this long without one is not replayable. */
const MAX_GOP_CHUNKS = 600;

// The software decoder failed on this page once; don't retry it for decoders
// created later (a rotation re-creates the decoder at the new size).
let softwareDecodeFailed = false;

/** Test hook: forget that the software decoder failed. */
export function resetSimVideoDecoderState(): void {
  softwareDecodeFailed = false;
}

export class SimVideoDecoder {
  private decoder: VideoDecoder | null = null;
  private acceleration: Acceleration;
  /** The current decoder has been given a keyframe and accepts delta frames. */
  private primed = false;
  /** Frames the current decoder has emitted. */
  private framesOut = 0;
  private failures = 0;
  private closed = false;
  /** Chunks since the last keyframe, replayed into a replacement decoder so a
   * switch of decoder implementation doesn't wait for the next keyframe. */
  private gop: BufferedChunk[] = [];

  constructor(private readonly options: SimVideoDecoderOptions) {
    // The software decoder is preferred: the platform hardware decoders
    // (VideoToolbox in Chrome on macOS) hold ~8 frames before emitting one —
    // ~130ms of added latency at 60fps, on every tap. The software path emits
    // each frame as soon as it's decoded (~4ms) and keeps up with 60fps at
    // this resolution on current machines.
    this.acceleration = softwareDecodeFailed ? "no-preference" : "prefer-software";
    this.build();
  }

  decode(data: Uint8Array, timestampMs: number, keyframe: boolean): void {
    if (this.closed) return;
    const chunk: BufferedChunk = { data, timestampMs, keyframe };
    if (keyframe) {
      this.gop = [chunk];
    } else if (this.gop.length > 0) {
      if (this.gop.length < MAX_GOP_CHUNKS) this.gop.push(chunk);
      else this.gop = [];
    }
    this.feed(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.gop = [];
    this.discardDecoder();
  }

  private build(): void {
    this.primed = false;
    this.framesOut = 0;
    let decoder: VideoDecoder | null = null;
    try {
      const created: VideoDecoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          try {
            if (this.decoder === created) {
              this.framesOut++;
              this.options.onFrame(frame);
            }
          } finally {
            frame.close();
          }
        },
        error: (e: Error) => this.handleFailure(created, e),
      });
      decoder = created;
      this.decoder = created;
      created.configure({
        codec: "avc1.42E01F",
        codedWidth: this.options.width,
        codedHeight: this.options.height,
        optimizeForLatency: true,
        ...(this.acceleration === "prefer-software"
          ? { hardwareAcceleration: "prefer-software" as const }
          : {}),
        avc: { format: "annexb" },
      } as VideoDecoderConfig);
    } catch (e) {
      // Constructing or configuring threw synchronously (invalid config).
      this.handleFailure(decoder, e as Error);
    }
  }

  private feed(chunk: BufferedChunk): void {
    const decoder = this.decoder;
    // A closed decoder is replaced from its error callback; never decode into it.
    if (!decoder || decoder.state !== "configured") return;
    if (typeof EncodedVideoChunk === "undefined") return;
    if (!this.primed) {
      if (!chunk.keyframe) return;
      this.primed = true;
    }
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: chunk.keyframe ? "key" : "delta",
          timestamp: chunk.timestampMs * 1000,
          data: chunk.data,
        }),
      );
    } catch (e) {
      this.handleFailure(decoder, e as Error);
    }
  }

  /** `failed` is the decoder the error belongs to, or null if none was created. */
  private handleFailure(failed: VideoDecoder | null, error: Error): void {
    // Errors from a decoder that was already replaced or closed are stale.
    if (this.closed || failed !== this.decoder) return;

    // A decoder that ran for a while before failing starts with a clean slate.
    if (this.framesOut >= HEALTHY_FRAMES) this.failures = 0;
    this.failures++;
    const wasSoftware = this.acceleration === "prefer-software";
    const message = `${error.name}: ${error.message}`;
    this.discardDecoder();

    if (this.failures > MAX_FAILURES) {
      this.closed = true;
      this.gop = [];
      console.error("[sim-video] decoder failed, giving up:", message);
      this.options.onFatal(message);
      return;
    }

    console.warn(
      `[sim-video] ${wasSoftware ? "software" : "default"} decoder failed (${message}); rebuilding`,
    );
    // QuotaExceededError is the browser reclaiming an idle codec, not a fault
    // in the decoder implementation, so it is no reason to leave software.
    if (wasSoftware && error.name !== "QuotaExceededError") {
      // Same stream, different decoder implementation: replay the buffered GOP
      // so the picture resumes immediately.
      softwareDecodeFailed = true;
      this.acceleration = "no-preference";
      this.build();
      this.replay();
    } else {
      // Same implementation again: drop the buffered data and resume at the
      // next keyframe.
      this.gop = [];
      this.build();
    }
  }

  private replay(): void {
    const decoder = this.decoder;
    for (const chunk of [...this.gop]) {
      // A failure during the replay replaces (or drops) the decoder.
      if (!decoder || this.decoder !== decoder) return;
      this.feed(chunk);
    }
  }

  private discardDecoder(): void {
    const decoder = this.decoder;
    this.decoder = null;
    this.primed = false;
    if (!decoder) return;
    try {
      if (decoder.state !== "closed") decoder.close();
    } catch {
      /* already closed */
    }
  }
}
