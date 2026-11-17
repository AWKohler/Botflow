import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { SimVideoDecoder, resetSimVideoDecoderState } from "./sim-video-decoder";

// In-process stand-in for the WebCodecs VideoDecoder: records what it is given
// and lets a test fail it the way a browser does (close, then error callback).
class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  /** Set to make configure() throw synchronously, as an invalid config does. */
  static configureThrows: Error | null = null;
  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  config: { hardwareAcceleration?: string; codedWidth?: number } = {};
  decoded: { type: string; timestamp: number }[] = [];
  /** Set to make the next decode() throw synchronously. */
  decodeThrows: Error | null = null;

  constructor(private readonly init: { output: (frame: unknown) => void; error: (e: Error) => void }) {
    FakeVideoDecoder.instances.push(this);
  }
  configure(config: { hardwareAcceleration?: string; codedWidth?: number }) {
    if (FakeVideoDecoder.configureThrows) throw FakeVideoDecoder.configureThrows;
    this.config = config;
    this.state = "configured";
  }
  decode(chunk: { type: string; timestamp: number }) {
    if (this.state === "closed") {
      throw new Error("Failed to execute 'decode' on 'VideoDecoder': Cannot call 'decode' on a closed codec.");
    }
    if (this.decodeThrows) {
      const e = this.decodeThrows;
      this.decodeThrows = null;
      throw e;
    }
    this.decoded.push({ type: chunk.type, timestamp: chunk.timestamp });
  }
  close() {
    if (this.state === "closed") throw new Error("Cannot call 'close' on a closed codec.");
    this.state = "closed";
  }
  /** The browser hit a decoder error: the codec closes, then reports it. */
  fail(name: string, message: string) {
    this.state = "closed";
    this.init.error(Object.assign(new Error(message), { name }));
  }
  emitFrames(count: number) {
    for (let i = 0; i < count; i++) this.init.output({ close() {} });
  }
}

class FakeEncodedVideoChunk {
  type: string;
  timestamp: number;
  constructor(init: { type: string; timestamp: number }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
  }
}

const data = new Uint8Array([0, 0, 0, 1]);
const decoders = () => FakeVideoDecoder.instances;
const last = () => decoders()[decoders().length - 1];

function create() {
  const frames: unknown[] = [];
  const fatal: string[] = [];
  const decoder = new SimVideoDecoder({
    width: 1206,
    height: 2622,
    onFrame: (frame) => frames.push(frame),
    onFatal: (message) => fatal.push(message),
  });
  return { decoder, frames, fatal };
}

beforeEach(() => {
  FakeVideoDecoder.instances = [];
  FakeVideoDecoder.configureThrows = null;
  resetSimVideoDecoderState();
  vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
  vi.stubGlobal("EncodedVideoChunk", FakeEncodedVideoChunk);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("prefers the software decoder and waits for a keyframe", () => {
  const { decoder } = create();
  assert.equal(last().config.hardwareAcceleration, "prefer-software");
  decoder.decode(data, 1, false);
  decoder.decode(data, 2, true);
  decoder.decode(data, 3, false);
  assert.deepEqual(last().decoded, [
    { type: "key", timestamp: 2000 },
    { type: "delta", timestamp: 3000 },
  ]);
});

test("a decoder error never surfaces as a closed-codec decode failure", () => {
  const { decoder, fatal } = create();
  decoder.decode(data, 1, true);
  decoders()[0].fail("EncodingError", "Decoding error.");
  // Before the fix the next chunk went to the closed decoder and threw.
  assert.doesNotThrow(() => decoder.decode(data, 2, false));
  assert.deepEqual(fatal, []);
});

test("any software decoder error falls back to the default decoder and replays the GOP", () => {
  const { decoder, fatal } = create();
  decoder.decode(data, 1, true);
  decoder.decode(data, 2, false);
  decoders()[0].fail("EncodingError", "Decoding error.");

  assert.equal(decoders().length, 2);
  assert.equal(last().config.hardwareAcceleration, undefined);
  // The frames the failed decoder never showed are decoded by its replacement.
  assert.deepEqual(last().decoded, [
    { type: "key", timestamp: 1000 },
    { type: "delta", timestamp: 2000 },
  ]);
  decoder.decode(data, 3, false);
  assert.equal(last().decoded.length, 3);
  assert.deepEqual(fatal, []);
});

test("an unsupported software configuration falls back before any chunk arrives", () => {
  const { decoder } = create();
  decoders()[0].fail("NotSupportedError", "Unsupported configuration.");
  assert.equal(last().config.hardwareAcceleration, undefined);
  decoder.decode(data, 1, true);
  assert.deepEqual(last().decoded, [{ type: "key", timestamp: 1000 }]);
});

test("decoders created later skip the software decoder once it has failed", () => {
  create();
  decoders()[0].fail("EncodingError", "Decoding error.");
  create(); // e.g. a rotation re-creates the decoder at the new size
  assert.equal(last().config.hardwareAcceleration, undefined);
});

test("the default decoder is rebuilt after an error and resumes at the next keyframe", () => {
  const { decoder, fatal } = create();
  decoder.decode(data, 1, true);
  decoders()[0].fail("EncodingError", "Decoding error.");
  decoders()[1].fail("EncodingError", "Decoding error.");

  assert.equal(decoders().length, 3);
  decoder.decode(data, 2, false); // rest of the GOP that failed: skipped
  assert.deepEqual(last().decoded, []);
  decoder.decode(data, 3, true);
  assert.deepEqual(last().decoded, [{ type: "key", timestamp: 3000 }]);
  assert.deepEqual(fatal, []);
});

test("gives up with the decoder's own error after repeated failures", () => {
  const { decoder, fatal } = create();
  decoder.decode(data, 1, true);
  for (let i = 0; i < 5; i++) last().fail("EncodingError", "Decoding error.");

  assert.deepEqual(fatal, ["EncodingError: Decoding error."]);
  const count = decoders().length;
  assert.doesNotThrow(() => decoder.decode(data, 2, true));
  assert.equal(decoders().length, count); // no further rebuilds
});

test("a decoder that ran healthily gets a fresh failure budget", () => {
  const { decoder, fatal } = create();
  for (let round = 0; round < 8; round++) {
    decoder.decode(data, round, true);
    last().emitFrames(60);
    last().fail("EncodingError", "Decoding error.");
  }
  assert.deepEqual(fatal, []);
  assert.equal(last().state, "configured");
});

test("a reclaimed software decoder is rebuilt as software", () => {
  const { decoder } = create();
  decoder.decode(data, 1, true);
  decoders()[0].fail("QuotaExceededError", "Codec reclaimed due to inactivity.");
  assert.equal(last().config.hardwareAcceleration, "prefer-software");
  decoder.decode(data, 2, true);
  assert.deepEqual(last().decoded, [{ type: "key", timestamp: 2000 }]);
});

test("a decode() that throws is recovered from like a decoder error", () => {
  const { decoder, fatal } = create();
  decoders()[0].decodeThrows = Object.assign(new Error("A key frame is required."), { name: "DataError" });
  decoder.decode(data, 1, true);
  assert.equal(decoders().length, 2);
  assert.equal(decoders()[0].state, "closed");
  assert.deepEqual(last().decoded, [{ type: "key", timestamp: 1000 }]);
  assert.deepEqual(fatal, []);
});

test("an invalid configuration reports its error instead of leaving a dead decoder", () => {
  FakeVideoDecoder.configureThrows = new TypeError("Invalid codedWidth");
  const { decoder, fatal } = create();
  assert.deepEqual(fatal, ["TypeError: Invalid codedWidth"]);
  assert.doesNotThrow(() => decoder.decode(data, 1, true));
});

test("frames from a replaced decoder are dropped; live frames reach onFrame", () => {
  const { decoder, frames } = create();
  decoder.decode(data, 1, true);
  const first = decoders()[0];
  first.fail("EncodingError", "Decoding error.");
  first.emitFrames(1);
  assert.equal(frames.length, 0);
  last().emitFrames(2);
  assert.equal(frames.length, 2);
});

test("close() closes the decoder and ignores later chunks and errors", () => {
  const { decoder, fatal } = create();
  decoder.decode(data, 1, true);
  decoder.close();
  assert.equal(decoders()[0].state, "closed");
  decoder.decode(data, 2, true);
  decoders()[0].fail("EncodingError", "Decoding error.");
  assert.equal(decoders().length, 1);
  assert.deepEqual(fatal, []);
});
