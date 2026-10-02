/**
 * The protocol the DLSS Frame Generation host process (dlssg-host.ts) speaks on stdout and stdin:
 * the one JSON line `--probe` prints, and under `--serve` one FGS1 setup answered by FGR1, then one
 * FGF2 per real frame answered by FGO2. The pixels and motion going in and the generated frames
 * coming out are not on the pipes but in the shared memory named on the host's command line
 * (dlssg-shared-layout.ts); a message only says whose turn it is to use them. Pure encode and
 * decode; the I/O stays with each side.
 */

// Each magic is its four ASCII characters read as a little-endian u32, so a hex dump of the
// stream shows "FGS1", "FGR1", "FGF2" and "FGO2". The frame messages are "2" because their payload
// travels in shared memory: a peer that still expects it on the pipe fails on the first magic
// instead of misreading the stream.
const SETUP_MAGIC = 0x31534746;
const SETUP_REPLY_MAGIC = 0x31524746;
const FRAME_MAGIC = 0x32464746;
const FRAME_RESULT_MAGIC = 0x324f4746;

/** FGS1: magic, width, height, frameCount, generatedCount, each a u32. */
export const SETUP_BYTES = 20;
/** FGR1: magic, status, maximum, reserved, each a u32. */
export const SETUP_REPLY_BYTES = 16;
/** FGF2: magic, index, reset, padding (u32 each), then the timestamp numerator and denominator (i64 each). */
export const FRAME_HEADER_BYTES = 32;
/** FGO2: magic, status, generated, disabled, each a u32. */
export const FRAME_RESULT_BYTES = 16;

export interface DlssgSetup {
  width: number;
  height: number;
  /** Real frames the parent will send, or 0 when it does not say; dlssg-host.ts ignores it and serves until stdin ends. */
  frameCount: number;
  /** In-between frames per interval = native multiplier - 1. */
  generatedCount: number;
}

/** The setup answer: `maximum` is the most in-between frames per interval the runtime allows. */
export type DlssgSetupReply = { outcome: "ready"; maximum: number } | { outcome: "refused"; status: number };

/**
 * The non-zero statuses the host (dlssg-host.ts) puts in FGR1 and FGO2. The parent treats any
 * non-zero status as a failure, so the host writes the reason to stderr as well.
 */
export const HostStatus = {
  /** Setup: the runtime cannot generate on this GPU and driver. */
  unavailable: 1,
  /** Setup: more frames per interval than the runtime's MultiFrameCountMax. */
  tooManyGenerated: 2,
  /** Setup: the GPU, NGX or the feature could not be brought up. */
  setupFailed: 3,
  /** A message did not decode, so nothing after it on stdin can be trusted. */
  badRequest: 4,
  /** Frame: generation threw or broke the all-or-nothing rule. */
  generationFailed: 5,
  /** Setup: the shared memory named on the command line does not exist or is smaller than the setup's frames need. */
  sharedMemoryFailed: 6,
} as const;

/** What announces a real frame. Its RGBA8 pixels and motion field are already in the shared input slot when it is sent. */
interface DlssgFrameHeader {
  /** 0-based position of this real frame in the stream. */
  index: number;
  /** Drop the interpolation history: the frame starts a new shot, so nothing is generated before it. */
  reset: boolean;
  timestampNumerator: bigint;
  timestampDenominator: bigint;
}

/**
 * The answer to one real frame. Only "generated" has payload: `frameCount` RGBA8 frames in presentation
 * order, already in the shared output slot when it is sent. A process sends all of the session's
 * generatedCount frames or none, since Stage.evaluate stamps frame i at (i + 1) / (generatedCount + 1)
 * of the interval. "empty" means generation ran but had no interval to fill (the first frame or a
 * reset); "disabled" means the runtime declined to interpolate this interval.
 */
export type DlssgFrameResult =
  | { outcome: "generated"; frameCount: number }
  | { outcome: "empty" }
  | { outcome: "disabled" }
  | { outcome: "failed"; status: number };

/** How the host process is started: `--probe` prints the probe line; `--serve` answers the protocol with its frames in the shared memory called `sharedMemoryName`. */
export type DlssgLaunch = { mode: "--probe" } | { mode: "--serve"; sharedMemoryName: string };

/** What `--probe` prints on stdout as one JSON line. */
export interface DlssgProbeLine {
  available: boolean;
  /** In-between frames the runtime claims per interval (native multiplier max = this + 1). */
  multiFrameCountMax: number;
  runtimeVersion: string;
  workerVersion: string;
  detail: string;
}

/** Bytes of one RGBA8 frame: the real frame in the shared input slot, and each generated frame in the output slot. */
export function rgbaFrameBytes(width: number, height: number): number {
  return width * height * 4;
}

/** Bytes of one motion field: an R16G16_FLOAT (x, y) pixel offset per pixel, behind the frame's RGBA in the input slot. */
export function motionFieldBytes(width: number, height: number): number {
  return width * height * 2 * 2;
}

/** The line without its newline, with snake_case keys (multi_frame_count_max, runtime_version, worker_version). */
export function encodeProbeLine(probe: DlssgProbeLine): string {
  return JSON.stringify({
    available: probe.available,
    multi_frame_count_max: probe.multiFrameCountMax,
    runtime_version: probe.runtimeVersion,
    worker_version: probe.workerVersion,
    detail: probe.detail,
  });
}

/** A missing field reads as false, 0 or "". */
export function decodeProbeLine(line: string): DlssgProbeLine {
  const json = JSON.parse(line) as Record<string, unknown>;
  return {
    available: Boolean(json.available),
    multiFrameCountMax: Number(json.multi_frame_count_max ?? 0),
    runtimeVersion: String(json.runtime_version ?? ""),
    workerVersion: String(json.worker_version ?? ""),
    detail: String(json.detail ?? ""),
  };
}

// Every message has a fixed size; a DataView over a shorter view would read on into whatever
// follows it in the same ArrayBuffer.
function messageView(bytes: Uint8Array, byteCount: number, message: string): DataView {
  if (bytes.byteLength !== byteCount) throw new Error(`${message}: got ${bytes.byteLength} bytes, expected ${byteCount}`);
  return new DataView(bytes.buffer, bytes.byteOffset, byteCount);
}

function expectMagic(view: DataView, magic: number, error: string): void {
  if (view.getUint32(0, true) !== magic) throw new Error(error);
}

function encodeWords(words: readonly number[]): Uint8Array {
  const view = new DataView(new ArrayBuffer(words.length * 4));
  words.forEach((word, position) => view.setUint32(position * 4, word, true));
  return new Uint8Array(view.buffer);
}

export function encodeSetup(setup: DlssgSetup): Uint8Array {
  return encodeWords([SETUP_MAGIC, setup.width, setup.height, setup.frameCount, setup.generatedCount]);
}

export function decodeSetup(bytes: Uint8Array): DlssgSetup {
  const view = messageView(bytes, SETUP_BYTES, "DLSSG setup");
  expectMagic(view, SETUP_MAGIC, "DLSSG setup: bad request magic");
  return {
    width: view.getUint32(4, true),
    height: view.getUint32(8, true),
    frameCount: view.getUint32(12, true),
    generatedCount: view.getUint32(16, true),
  };
}

export function encodeSetupReply(reply: DlssgSetupReply): Uint8Array {
  if (reply.outcome === "ready") return encodeWords([SETUP_REPLY_MAGIC, 0, reply.maximum, 0]);
  // Status 0 is how the parent recognises a ready process, so a refusal must not send it.
  if (reply.status === 0) throw new Error("DLSSG setup reply: a refusal needs a non-zero status");
  return encodeWords([SETUP_REPLY_MAGIC, reply.status, 0, 0]);
}

export function decodeSetupReply(bytes: Uint8Array): DlssgSetupReply {
  const view = messageView(bytes, SETUP_REPLY_BYTES, "DLSSG setup reply");
  expectMagic(view, SETUP_REPLY_MAGIC, "DLSSG setup: bad reply magic");
  const status = view.getUint32(4, true);
  if (status !== 0) return { outcome: "refused", status };
  return { outcome: "ready", maximum: view.getUint32(8, true) };
}

export function encodeFrameHeader(header: DlssgFrameHeader): Uint8Array {
  const view = new DataView(new ArrayBuffer(FRAME_HEADER_BYTES));
  view.setUint32(0, FRAME_MAGIC, true);
  view.setUint32(4, header.index, true);
  view.setUint32(8, header.reset ? 1 : 0, true);
  view.setUint32(12, 0, true);
  view.setBigInt64(16, header.timestampNumerator, true);
  view.setBigInt64(24, header.timestampDenominator, true);
  return new Uint8Array(view.buffer);
}

export function decodeFrameHeader(bytes: Uint8Array): DlssgFrameHeader {
  const view = messageView(bytes, FRAME_HEADER_BYTES, "DLSSG frame");
  expectMagic(view, FRAME_MAGIC, "DLSSG frame: bad request magic");
  return {
    index: view.getUint32(4, true),
    reset: view.getUint32(8, true) !== 0,
    timestampNumerator: view.getBigInt64(16, true),
    timestampDenominator: view.getBigInt64(24, true),
  };
}

export function encodeFrameResult(result: DlssgFrameResult): Uint8Array {
  switch (result.outcome) {
    case "generated":
      // Zero frames would decode as "empty"; say "empty" instead.
      if (result.frameCount < 1) throw new Error("DLSSG frame reply: a generated result carries at least one frame");
      return encodeWords([FRAME_RESULT_MAGIC, 0, result.frameCount, 0]);
    case "empty":
      return encodeWords([FRAME_RESULT_MAGIC, 0, 0, 0]);
    case "disabled":
      return encodeWords([FRAME_RESULT_MAGIC, 0, 0, 1]);
    case "failed":
      if (result.status === 0) throw new Error("DLSSG frame reply: a failure needs a non-zero status");
      return encodeWords([FRAME_RESULT_MAGIC, result.status, 0, 0]);
  }
}

/**
 * A disabled reply is read as carrying no payload whatever its generated word says, and the generated
 * count is not checked against the session here: DlssgSession checks it against the frames its output slot holds.
 */
export function decodeFrameResult(bytes: Uint8Array): DlssgFrameResult {
  const view = messageView(bytes, FRAME_RESULT_BYTES, "DLSSG frame reply");
  expectMagic(view, FRAME_RESULT_MAGIC, "DLSSG frame: bad reply magic");
  const status = view.getUint32(4, true);
  if (status !== 0) return { outcome: "failed", status };
  if (view.getUint32(12, true) !== 0) return { outcome: "disabled" };
  const generated = view.getUint32(8, true);
  if (generated === 0) return { outcome: "empty" };
  return { outcome: "generated", frameCount: generated };
}
