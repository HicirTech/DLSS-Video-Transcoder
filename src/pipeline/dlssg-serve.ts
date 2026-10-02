/**
 * The host side of the dlssg protocol (dlssg-protocol.ts): answer one FGS1 setup, then one FGO2 per
 * FGF2 frame until stdin ends, on a stdout that carries nothing but those replies. The frames are in
 * the shared memory the parent created (dlssg-shared-layout.ts): each real frame is read in place and
 * the generated ones are written to the output slot before the reply. Generation is injected, so the
 * same loop runs over DlssgFeature and over a test's fake.
 */
import { Console } from "node:console";
import { readSync, writeSync } from "node:fs";
import { Writable } from "node:stream";
import { format } from "node:util";
import { SharedMemory } from "../native/shared-memory.ts";
import type { DlssgIntervalInput, DlssgIntervalResult } from "../ngx/dlssg-feature.ts";
import {
  FRAME_HEADER_BYTES,
  HostStatus,
  SETUP_BYTES,
  decodeFrameHeader,
  decodeSetup,
  encodeFrameResult,
  encodeSetupReply,
  type DlssgFrameResult,
  type DlssgSetup,
} from "./dlssg-protocol.ts";
import { sharedFrameLayout, viewRange, type SharedFrameLayout } from "./dlssg-shared-layout.ts";

interface IntervalGenerator {
  /** Most frames one interval can generate: the setup reply's maximum. */
  readonly maximum: number;
  interval(input: DlssgIntervalInput): DlssgIntervalResult;
  /** Releases everything the generator holds; called once, on every path out of the loop. */
  close(): void;
}

export type GeneratorOpening = { outcome: "opened"; generator: IntervalGenerator } | { outcome: "refused"; status: number; reason: string };

/** The session's shared memory, with its slots laid out once: the views are the real frame to read and the places for each generated frame. */
interface SharedFrames {
  readonly memory: SharedMemory;
  readonly rgba: Uint8Array;
  readonly motion: Uint8Array;
  readonly generated: readonly Uint8Array[];
}

type SetupOpening = { outcome: "opened"; setup: DlssgSetup; generator: IntervalGenerator; frames: SharedFrames } | { outcome: "refused"; status: number; reason: string };

/** An FGO2 reply and the frames that go in the output slot before it is sent; a failed reply also says why, for stderr. */
interface FrameAnswer {
  result: DlssgFrameResult;
  frames: readonly Uint8Array[];
  failureReason?: string;
}

/*
 * Every read and write on the three standard pipes is a blocking fd call, so no pipe I/O runs on
 * Bun's event loop while NGX works on this thread, and stdout carries only the bytes written here.
 */
const STDIN_FD = 0;
const STDOUT_FD = 1;
const STDERR_FD = 2;

function writeFully(fd: number, bytes: Uint8Array): void {
  for (let written = 0; written < bytes.byteLength; ) written += writeSync(fd, bytes, written, bytes.byteLength - written);
}

/** The next `byteCount` bytes of stdin, or null when stdin ends first (a trailing partial message is dropped). */
function readStdin(byteCount: number): Uint8Array | null {
  const bytes = new Uint8Array(byteCount);
  for (let filled = 0; filled < byteCount; ) {
    const read = readSync(STDIN_FD, bytes, filled, byteCount - filled, null);
    if (read === 0) return null;
    filled += read;
  }
  return bytes;
}

/** Stdout for the protocol alone; claimStdout hands out the only one. */
interface ProtocolStdout {
  /** Writes every chunk, in order, before returning: one protocol message, or the --probe line. */
  write(...chunks: (string | Uint8Array)[]): void;
}

export function logToStderr(line: string): void {
  writeFully(STDERR_FD, Buffer.from(`dlssg-host: ${line}\n`));
}

/** Stderr as a stream for console and process.stdout, writing each chunk before the call returns. */
const blockingStderr = new Writable({
  write(chunk: Buffer, _encoding, done): void {
    writeFully(STDERR_FD, chunk);
    done();
  },
});

/**
 * Hands out the writer for the protocol and sends every console method and process.stdout.write to
 * stderr from here on. The parent reads every stdout byte as part of a message, so one stray line
 * would desynchronise it for the rest of the session. Bun.stdout itself cannot be taken away, so
 * nothing else in the host may write to it directly.
 */
export function claimStdout(): ProtocolStdout {
  // Measured on Bun 1.4.2: log, info, debug, dir, dirxml, table, count, group, groupCollapsed, trace
  // and write print to stdout. A node:console Console over stderr carries all of those but Bun's own
  // console.write, with count and group state of its own; its trace drops the message, so trace is ours too.
  Object.assign(console, new Console({ stdout: blockingStderr, stderr: blockingStderr }));
  console.trace = traceToStderr;
  console.write = writeToStderr;
  process.stdout.write = blockingStderr.write.bind(blockingStderr);
  return {
    write: (...chunks) => {
      for (const chunk of chunks) writeFully(STDOUT_FD, typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    },
  };
}

function traceToStderr(...values: unknown[]): void {
  const callers = new Error().stack?.split("\n").slice(2).join("\n") ?? "";
  writeFully(STDERR_FD, Buffer.from(`Trace: ${format(...values)}\n${callers}\n`));
}

function writeToStderr(...data: (string | ArrayBufferView | ArrayBuffer)[]): number {
  let written = 0;
  for (const chunk of data) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk);
    writeFully(STDERR_FD, bytes);
    written += bytes.byteLength;
  }
  return written;
}

function openSharedFrames(layout: SharedFrameLayout, name: string): SharedFrames {
  const memory = SharedMemory.open(name, layout.totalBytes);
  const { bytes } = memory;
  return { memory, rgba: viewRange(bytes, layout.rgba), motion: viewRange(bytes, layout.motion), generated: layout.generated.map((range) => viewRange(bytes, range)) };
}

function refusedSetup(status: number, error: unknown): SetupOpening {
  return { outcome: "refused", status, reason: (error as Error).message };
}

function openFromSetup(setupBytes: Uint8Array, sharedMemoryName: string, openGenerator: (setup: DlssgSetup) => GeneratorOpening): SetupOpening {
  let setup: DlssgSetup;
  let layout: SharedFrameLayout;
  try {
    setup = decodeSetup(setupBytes);
    layout = sharedFrameLayout(setup);
  } catch (error) {
    return refusedSetup(HostStatus.badRequest, error);
  }
  // Ahead of the generator, which brings up D3D12 and NGX: a mapping that cannot be opened is a quick refusal.
  let frames: SharedFrames;
  try {
    frames = openSharedFrames(layout, sharedMemoryName);
  } catch (error) {
    return refusedSetup(HostStatus.sharedMemoryFailed, error);
  }
  let opening: GeneratorOpening;
  try {
    opening = openGenerator(setup);
  } catch (error) {
    opening = { outcome: "refused", status: HostStatus.setupFailed, reason: (error as Error).message };
  }
  if (opening.outcome === "refused") {
    frames.memory.close();
    return opening;
  }
  return { ...opening, setup, frames };
}

function failedAnswer(status: number, reason: string): FrameAnswer {
  return { result: { outcome: "failed", status }, frames: [], failureReason: reason };
}

/**
 * All of generatedCount frames or none: Stage.evaluate stamps frame i at (i + 1) / (generatedCount + 1)
 * of the interval, so a short set would be stamped at the wrong times.
 */
function answerFrame(generator: IntervalGenerator, input: DlssgIntervalInput, rgbaBytes: number): FrameAnswer {
  let generated: DlssgIntervalResult;
  try {
    generated = generator.interval(input);
  } catch (error) {
    return failedAnswer(HostStatus.generationFailed, `source frame ${input.frameId}: ${(error as Error).message}`);
  }
  switch (generated.outcome) {
    case "reset":
      return { result: { outcome: "empty" }, frames: [] };
    case "disabled":
      return { result: { outcome: "disabled" }, frames: [] };
    case "generated": {
      const frameCount = generated.frames.length;
      if (frameCount !== input.generatedCount || generated.frames.some((frame) => frame.byteLength !== rgbaBytes)) {
        return failedAnswer(HostStatus.generationFailed, `source frame ${input.frameId}: generation returned ${frameCount} frame(s) where the session sends ${input.generatedCount} of ${rgbaBytes} bytes each or none`);
      }
      return { result: { outcome: "generated", frameCount }, frames: generated.frames };
    }
  }
}

/** Replies to frames until stdin ends at a message boundary (exit code 0), or until a reply fails (1). */
function answerFrames(stdout: ProtocolStdout, setup: DlssgSetup, generator: IntervalGenerator, frames: SharedFrames): number {
  // setup.frameCount is not a limit: the host serves until stdin ends, so a source that decodes
  // more frames than its container declared still gets every frame answered.
  for (;;) {
    const headerBytes = readStdin(FRAME_HEADER_BYTES);
    if (!headerBytes) return 0;
    let answer: FrameAnswer;
    try {
      const header = decodeFrameHeader(headerBytes);
      // The input slot itself, not a copy: the parent wrote the frame before it sent the header and
      // writes nothing more until this reply, so the generator may read the views for the whole call.
      const input: DlssgIntervalInput = {
        rgba: frames.rgba,
        motion: frames.motion,
        reset: header.reset,
        frameId: header.index,
        generatedCount: setup.generatedCount,
      };
      answer = answerFrame(generator, input, frames.rgba.byteLength);
    } catch (error) {
      answer = failedAnswer(HostStatus.badRequest, (error as Error).message);
    }
    // In the output slot before the reply, since the parent reads the slot once it has read the reply.
    answer.frames.forEach((frame, position) => frames.generated[position]!.set(frame));
    stdout.write(encodeFrameResult(answer.result));
    if (answer.result.outcome === "failed") {
      logToStderr(`reply failed (status ${answer.result.status}): ${answer.failureReason}`);
      return 1;
    }
  }
}

/** A release that fails is reported on stderr; the exit code stays the one the session earned, since every reply was already sent. */
function closeGenerator(generator: IntervalGenerator): void {
  try {
    generator.close();
  } catch (error) {
    logToStderr(`releasing the generator failed: ${(error as Error).message}`);
  }
}

/**
 * Serves one session on stdin and the claimed stdout, with the frames in the shared memory called
 * `sharedMemoryName`, and returns the process exit code: 0 when stdin ended at a message boundary, 1
 * after a refused setup or a failed reply.
 */
export function serveDlssg(stdout: ProtocolStdout, sharedMemoryName: string, openGenerator: (setup: DlssgSetup) => GeneratorOpening): number {
  const setupBytes = readStdin(SETUP_BYTES);
  // A parent that closes stdin before a setup asked for nothing.
  if (!setupBytes) return 0;
  const opening = openFromSetup(setupBytes, sharedMemoryName, openGenerator);
  if (opening.outcome === "refused") {
    logToStderr(`setup refused (status ${opening.status}): ${opening.reason}`);
    stdout.write(encodeSetupReply({ outcome: "refused", status: opening.status }));
    return 1;
  }
  try {
    stdout.write(encodeSetupReply({ outcome: "ready", maximum: opening.generator.maximum }));
    return answerFrames(stdout, opening.setup, opening.generator, opening.frames);
  } finally {
    closeGenerator(opening.generator);
    opening.frames.memory.close();
  }
}
