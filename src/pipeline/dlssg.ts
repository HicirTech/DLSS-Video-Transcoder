/**
 * DLSS Frame Generation (NGX feature 11 / DLSSG) driven in the dlssg-host.ts child (started as
 * dlssg-host-launch.ts says) over dlssg-protocol.ts, with frames passed both ways through the shared
 * memory of dlssg-shared-layout.ts.
 *
 * Out of process so that a native fault in the third-party `nvngx_dlssg.dll`, which must come only
 * from a trusted, user-supplied runtime folder, ends the child rather than the server, and so each
 * session gets an NGX init of its own.
 */
import type { Subprocess } from "bun";
import { SharedMemory } from "../native/shared-memory.ts";
import { raceAbort } from "./cancel.ts";
import { HOST_PROCESS_NAME, dlssgHost, dlssgRuntimeKey, type DlssgHost, type DlssgRuntime } from "./dlssg-host-launch.ts";
import {
  FRAME_RESULT_BYTES,
  HostStatus,
  SETUP_REPLY_BYTES,
  decodeFrameResult,
  decodeProbeLine,
  decodeSetupReply,
  encodeFrameHeader,
  encodeSetup,
  type DlssgProbeLine,
} from "./dlssg-protocol.ts";
import { sharedFrameLayout, viewRange, type SharedFrameLayout } from "./dlssg-shared-layout.ts";
import { FrameReader, allocateFrame } from "./frame-reader.ts";

export interface DlssgProbe extends DlssgProbeLine {
  /** Whether the host printed a probe line; probeDlssg caches only these. */
  answered: boolean;
  /**
   * Windows hardware-accelerated GPU scheduling. The DLSS-G runtime refuses
   * multi-frame (>=3x) generation without it while still allowing 2x, so this
   * decides whether "auto" may plan a native multi-frame session.
   */
  hagsEnabled: boolean;
}

/**
 * True when HAGS is on: HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers
 * HwSchMode == 2. An absent value means it was never enabled, which the runtime
 * treats as off.
 */
function probeHags(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const result = Bun.spawnSync(["reg", "query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers", "/v", "HwSchMode"], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const match = /HwSchMode\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(new TextDecoder().decode(result.stdout));
    return match ? parseInt(match[1]!, 16) === 2 : false;
  } catch {
    return false;
  }
}

/** Stderr characters kept per child: room for the last lines of a refusal, a stack trace or a Bun crash report. */
const STDERR_TAIL_CHARS = 4096;
/** How many of those lines a failure message quotes: the reason and a few lines of what led up to it. */
const STDERR_QUOTED_LINES = 5;
/** The rule that opens the crash report Bun 1.4.2 prints when the host faults (measured with a deliberate segfault). */
const BUN_CRASH_RULE = /^={20,}$/;
/** The line of that report that says what faulted, e.g. "panic(main thread): Segmentation fault at address 0x8". */
const BUN_PANIC_LINE = /^panic\(/;
/**
 * How long a failure waits for the child to exit and finish its stderr, so the message can say why
 * it stopped. Bounded so a wedged child cannot hold the error up.
 */
const FAILURE_SETTLE_MS = 1000;

/**
 * `lines` with a Bun crash report cut down to its panic line. The rest of the report is Bun's
 * version and machine details and a footer asking for a bug report on Bun's tracker, which would
 * crowd out the host's own last lines and send the user to the wrong place.
 */
function withoutBunCrashReport(lines: readonly string[]): string[] {
  const panicAt = lines.findIndex((line) => BUN_PANIC_LINE.test(line));
  if (panicAt < 0) return [...lines];
  const ruleAt = lines.slice(0, panicAt).findLastIndex((line) => BUN_CRASH_RULE.test(line));
  return [...lines.slice(0, ruleAt < 0 ? panicAt : ruleAt), lines[panicAt]!];
}

/** Drains a child's stderr for its whole life, so it never blocks on a full pipe, and keeps the end of it. */
class StderrTail {
  private text = "";
  /** Settles once the stream has closed. */
  readonly drained: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.drained = this.drain(stream).catch(() => {});
  }

  private async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      this.text = (this.text + decoder.decode(chunk.value, { stream: true })).slice(-STDERR_TAIL_CHARS);
    }
  }

  /**
   * The last lines the child wrote, as one clause, or "" when it wrote none. Stack frames are left
   * out: after a crash they are all the tail holds, and the error line above them says more.
   */
  quote(): string {
    const lines = this.text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !/^at\s/.test(line));
    return withoutBunCrashReport(lines).slice(-STDERR_QUOTED_LINES).join(" / ");
  }
}

/** Resolves true once `promise` settles, or false when `timeoutMs` passes first. */
async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** True for the error a write to a child's stdin raises once the child has closed it or exited. */
function isBrokenPipe(error: unknown): boolean {
  return (error as { code?: string }).code === "EPIPE";
}

/** Kill `proc` (it may already have exited) and wait for it to exit. */
async function stopProcess(proc: Subprocess): Promise<void> {
  try { proc.kill(); } catch { /* exited in the meantime */ }
  await proc.exited.catch(() => 0);
}

/** A running host process and the end of what it wrote to stderr. */
interface HostChild {
  host: DlssgHost;
  proc: Subprocess<"pipe", "pipe", "pipe">;
  stderr: StderrTail;
}

/** `what`, plus the child's exit code and the end of its stderr once it has had FAILURE_SETTLE_MS to exit. */
async function withHostReport(child: HostChild, what: string): Promise<string> {
  const exited = await settlesWithin(Promise.all([child.proc.exited, child.stderr.drained]), FAILURE_SETTLE_MS);
  const exitCode = exited ? ` (exit code ${child.proc.exitCode})` : "";
  const said = child.stderr.quote();
  return `${what}${exitCode}${said ? `; it said: ${said}` : ""}`;
}

const probeCache = new Map<string, { at: number; probe: Promise<DlssgProbe> }>();

/** How long a host's answer is reused. */
const PROBE_CACHE_TTL_MS = 60_000;

/**
 * What the host loading from `runtime` reports, memoised per runtime (dlssgRuntimeKey) for
 * PROBE_CACHE_TTL_MS: spawning `--probe` costs roughly a second and capabilities do not change
 * between back-to-back jobs. A probe the host did not answer is not cached.
 */
export function probeDlssg(runtime: DlssgRuntime): Promise<DlssgProbe> {
  const now = Date.now();
  const key = dlssgRuntimeKey(runtime);
  const hit = probeCache.get(key);
  if (hit && now - hit.at < PROBE_CACHE_TTL_MS) return hit.probe;
  const probe = probeDlssgHost(dlssgHost(runtime));
  // Only a probe the host actually answered is worth keeping: the others
  // describe a machine the user is probably fixing right now, and the TTL would
  // repeat the same message for a minute without re-spawning.
  probe.then(
    (result) => {
      if (!result.answered) probeCache.delete(key);
    },
    () => probeCache.delete(key),
  );
  probeCache.set(key, { at: now, probe });
  return probe;
}

/** A probe the host did not answer; `detail` says why. Not cached (probeDlssg). */
function unansweredProbe(detail: string): DlssgProbe {
  return { available: false, multiFrameCountMax: 0, runtimeVersion: "", detail, answered: false, hagsEnabled: probeHags() };
}

/**
 * How long `--probe` may take before the host is stopped. The host starts D3D12 and NGX to answer,
 * in a runtime that has crashed mid-run, so a hang there must not hold the job forever. A healthy
 * probe took 1.02-1.07 s on an RTX 5090 (2026-09-29); the rest is headroom for a cold start from
 * the network drive the repo lives on.
 */
const PROBE_TIMEOUT_MS = 30_000;

/** Run `host`'s `--probe` and report whether frame generation is available; probeDlssg memoises it, tests script a process. */
export async function probeDlssgHost(host: DlssgHost, timeoutMs = PROBE_TIMEOUT_MS): Promise<DlssgProbe> {
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(host.command({ mode: "--probe" }), {
      cwd: host.cwd,
      env: host.env,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (error) {
    return unansweredProbe(`${HOST_PROCESS_NAME} could not be started in ${host.cwd}: ${(error as Error).message}. ${host.hint}`);
  }
  // Drain stdout AND stderr concurrently; reading only stdout would deadlock if
  // the host filled the unread stderr pipe before finishing its stdout.
  const stderr = new StderrTail(proc.stderr);
  const stdout = new Response(proc.stdout).text();
  if (!(await settlesWithin(proc.exited, timeoutMs))) {
    await stopProcess(proc);
    return unansweredProbe(`${HOST_PROCESS_NAME} did not finish --probe within ${timeoutMs / 1000} s and was stopped. ${host.hint}`);
  }
  const text = await stdout;
  const exitCode = proc.exitCode;
  await stderr.drained;
  const line = text.trim().split(/\r?\n/).filter((l) => l.trim()).pop() ?? "";
  // A host that died before printing its JSON leaves nothing to parse. Saying
  // "not available: " with nothing after it tells the user nothing they can act
  // on, so its stderr and exit code become the reason instead — that is where a
  // missing redistributable or a blocked executable actually reports itself.
  const said = stderr.quote();
  if (!line) return unansweredProbe(`${HOST_PROCESS_NAME} exited ${exitCode} without reporting${said ? `: ${said}.` : " anything."} ${host.hint}`);
  let probeLine: DlssgProbeLine;
  try {
    probeLine = decodeProbeLine(line);
  } catch {
    return unansweredProbe(`${HOST_PROCESS_NAME} exited ${exitCode} with a last stdout line that is not a probe report: ${JSON.stringify(line.slice(0, 200))}${said ? `; it said: ${said}` : ""}. ${host.hint}`);
  }
  return { ...probeLine, answered: true, hagsEnabled: probeHags() };
}

export interface DlssgOptions {
  width: number;
  height: number;
  /** Frames to synthesise per interval = native multiplier - 1 (1 = 2x). */
  generatedCount: number;
  /** Return generated frames in SharedArrayBuffers (for hand-off to Worker threads without copying). */
  sharedFrames?: boolean;
  /** Cancels the wait for the host's setup reply; the host is then stopped. */
  signal?: AbortSignal;
}

/** The way out when a session asks for more in-between frames than the runtime makes, whichever side notices. */
const USE_LOWER_MULTIPLIER = "Use a lower multiplier.";

/**
 * Why setup was refused. A request above the runtime's MultiFrameCountMax (HostStatus.tooManyGenerated)
 * gets its own message; any other status is reported as it is, with what the host wrote to stderr.
 */
async function setupRefusal(child: HostChild, status: number, requested: number): Promise<Error> {
  if (status === HostStatus.tooManyGenerated) {
    return new Error(`${await withHostReport(child, `This GPU/runtime cannot generate ${requested} in-between frame(s) per source frame (${requested + 1}x)`)}. ${USE_LOWER_MULTIPLIER}`);
  }
  return new Error(`${await withHostReport(child, `DLSS Frame Generation could not be set up: ${HOST_PROCESS_NAME} refused with status ${status}`)}. ${child.host.hint}`);
}

/** The host ended before it answered the setup: its NGX or D3D12 start failed, or it never ran. */
async function setupStoppedError(child: HostChild): Promise<Error> {
  return new Error(`${await withHostReport(child, `${HOST_PROCESS_NAME} stopped before answering the DLSS Frame Generation setup`)}. ${child.host.hint}`);
}

/** `bytes` decoded as `decode` reads them; a reply that does not decode is reported with the host's own report and hint. */
async function decodeReply<T>(child: HostChild, bytes: Uint8Array, decode: (bytes: Uint8Array) => T, what: string): Promise<T> {
  try {
    return decode(bytes);
  } catch (error) {
    throw new Error(`${await withHostReport(child, `${HOST_PROCESS_NAME} sent ${what} that is not part of the protocol (${(error as Error).message})`)}. ${child.host.hint}`);
  }
}

/** File-mapping names share one namespace per Windows session, so each session of frame generation needs a name of its own; a random UUID cannot clash. */
function newSharedMemoryName(): string {
  return `dlssg-fg-${crypto.randomUUID()}`;
}

/**
 * This side of the shared frame memory (dlssg-shared-layout.ts): the real frame goes into the input
 * slot, and the generated frames are copied out of the output slot.
 */
class FrameMemory {
  private constructor(
    private readonly memory: SharedMemory,
    private readonly layout: SharedFrameLayout,
    private readonly sharedFrames: boolean,
  ) {}

  /** A new mapping for the frames `options` describes; the host opens it by `name`. */
  static create(name: string, options: DlssgOptions): FrameMemory {
    const layout = sharedFrameLayout(options);
    try {
      return new FrameMemory(SharedMemory.create(name, layout.totalBytes), layout, options.sharedFrames ?? false);
    } catch (error) {
      throw new Error(`DLSS Frame Generation could not create the ${layout.totalBytes}-byte shared memory its frames travel in: ${(error as Error).message}. Free memory, or use a smaller output size or a lower multiplier.`);
    }
  }

  get name(): string {
    return this.memory.name;
  }

  /** Generated frames the output slot holds: the session's generatedCount. */
  get generatedCapacity(): number {
    return this.layout.generated.length;
  }

  /** Puts the real frame where the host reads it; the host looks only once it has the frame header. */
  writeFrame(rgba: Uint8Array, motion: Uint16Array): void {
    const motionBytes = new Uint8Array(motion.buffer, motion.byteOffset, motion.byteLength);
    const { rgba: rgbaRange, motion: motionRange } = this.layout;
    // A frame of another size would spill into its neighbour in the slot, or leave stale bytes, with nothing to say so.
    if (rgba.byteLength !== rgbaRange.byteLength || motionBytes.byteLength !== motionRange.byteLength) {
      throw new Error(`DLSS Frame Generation was given ${rgba.byteLength} bytes of colour and ${motionBytes.byteLength} bytes of motion for a session whose frames take ${rgbaRange.byteLength} and ${motionRange.byteLength}`);
    }
    const bytes = this.memory.bytes;
    bytes.set(rgba, rgbaRange.offset);
    bytes.set(motionBytes, motionRange.offset);
  }

  /**
   * The first `count` generated frames, each copied into an array of its own: the next interval
   * overwrites the output slot while these go on to the encoder and to the next stage of a cascade.
   */
  copyGenerated(count: number): Uint8Array[] {
    const bytes = this.memory.bytes;
    return this.layout.generated.slice(0, count).map((range) => {
      const frame = allocateFrame(range.byteLength, this.sharedFrames);
      frame.set(viewRange(bytes, range));
      return frame;
    });
  }

  close(): void {
    this.memory.close();
  }
}

export class DlssgSession {
  /** Frames for which the host reported generation disabled (status ok, but no in-between frames). */
  disabledFrames = 0;

  private constructor(
    private readonly child: HostChild,
    private readonly reader: FrameReader,
    private readonly frames: FrameMemory,
    readonly maximum: number,
  ) {}

  /** A session on a host process that loads DLSS Frame Generation from `runtime`. */
  static open(runtime: DlssgRuntime, opts: DlssgOptions): Promise<DlssgSession> {
    return DlssgSession.openOn(dlssgHost(runtime), opts);
  }

  /** A session on `host`; open starts dlssg-host.ts, tests script a process. */
  static async openOn(host: DlssgHost, opts: DlssgOptions): Promise<DlssgSession> {
    // Created before the process starts, which opens it by name; closed here on every failure.
    const frames = FrameMemory.create(newSharedMemoryName(), opts);
    try {
      return await DlssgSession.startHost(host, opts, frames);
    } catch (error) {
      frames.close();
      throw error;
    }
  }

  /** Starts the host process on `frames` and waits for its setup reply; a failure ends the process. */
  private static async startHost(host: DlssgHost, opts: DlssgOptions, frames: FrameMemory): Promise<DlssgSession> {
    let proc: Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn(host.command({ mode: "--serve", sharedMemoryName: frames.name }), {
        cwd: host.cwd,
        env: host.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(`${HOST_PROCESS_NAME} could not be started in ${host.cwd}: ${(error as Error).message}. ${host.hint}`);
    }
    const child: HostChild = { host, proc, stderr: new StderrTail(proc.stderr) };

    // Every exit from here to the constructor must end the child: by the time it
    // answers at all it has its own D3D12 device and NGX feature up, and nothing
    // else owns the process until DlssgSession exists. That includes a refused
    // generatedCount, which happens when the open disagrees with the probe.
    try {
      const reader = new FrameReader(proc.stdout);
      const setup = encodeSetup({ width: opts.width, height: opts.height, generatedCount: opts.generatedCount });
      try {
        proc.stdin.write(setup);
        await proc.stdin.flush();
      } catch (error) {
        // A host that exits at once (a usage error, a module that fails to load) can close its
        // stdin before the setup is flushed.
        if (!isBrokenPipe(error)) throw error;
        throw await setupStoppedError(child);
      }

      const replyBytes = await raceAbort(opts.signal, reader.next(SETUP_REPLY_BYTES));
      if (!replyBytes) throw await setupStoppedError(child);
      const reply = await decodeReply(child, replyBytes, decodeSetupReply, "a setup reply");
      if (reply.outcome === "refused") throw await setupRefusal(child, reply.status, opts.generatedCount);
      const { maximum } = reply;
      if (opts.generatedCount > maximum) {
        throw new Error(
          `This GPU/runtime can generate at most ${maximum} in-between frame(s) per source frame (${maximum + 1}x); ${opts.generatedCount} (${opts.generatedCount + 1}x) was requested. Use ${maximum + 1}x or less.`,
        );
      }
      return new DlssgSession(child, reader, frames, maximum);
    } catch (error) {
      await stopProcess(proc);
      throw error;
    }
  }

  /**
   * Feed one real frame; returns the synthesised in-between frames that precede
   * it (empty on a reset / when generation is disabled for this frame). Motion is
   * float16 (height, width, 2) packed as raw uint16. The frames returned are
   * copies, not views of the shared output slot: the encoder and the next stage
   * of a cascade go on reading them while the next interval overwrites the slot.
   */
  async processFrame(frame: { rgba: Uint8Array; motion: Uint16Array; index: number; reset: boolean }): Promise<Uint8Array[]> {
    const { index } = frame;
    this.frames.writeFrame(frame.rgba, frame.motion);
    const stdin = this.child.proc.stdin;
    // A dead host shows as the read below ending, not as a failed write: Bun 1.4.2 raised EPIPE for
    // writes into a closed pipe from 70 KB up (measured), never for a header's 16 bytes.
    stdin.write(encodeFrameHeader({ index, reset: frame.reset }));
    await stdin.flush();

    const resultBytes = await this.reader.next(FRAME_RESULT_BYTES);
    if (!resultBytes) throw await this.stoppedError(index);
    const result = await decodeReply(this.child, resultBytes, decodeFrameResult, `a reply to frame ${index}`);
    if (result.outcome === "failed") {
      throw new Error(`${await withHostReport(this.child, `DLSS Frame Generation failed while processing frame ${index}: ${HOST_PROCESS_NAME} replied status ${result.status}`)}. ${this.child.host.hint}`);
    }
    if (result.outcome === "disabled") this.disabledFrames++;
    if (result.outcome !== "generated") return [];
    if (result.frameCount > this.frames.generatedCapacity) {
      throw new Error(`${HOST_PROCESS_NAME} reported ${result.frameCount} generated frame(s) for frame ${index}, more than the ${this.frames.generatedCapacity} this session has room for. ${this.child.host.hint}`);
    }
    return this.frames.copyGenerated(result.frameCount);
  }

  private async stoppedError(index: number): Promise<Error> {
    return new Error(`${await withHostReport(this.child, `${HOST_PROCESS_NAME} stopped unexpectedly while processing frame ${index}`)}. ${this.child.host.hint}`);
  }

  /**
   * End the host's input and wait up to `timeoutMs` for it to exit; a host
   * still running then is killed, so a wedged one cannot hold up the job's
   * teardown (it releases its own D3D12 device and NGX feature on exit).
   */
  async close(timeoutMs: number): Promise<void> {
    const { proc } = this.child;
    try {
      proc.stdin.end();
    } catch {
      // the pipe is already closed
    }
    try {
      if (await settlesWithin(proc.exited, timeoutMs)) return;
      await stopProcess(proc);
    } finally {
      // After the host has stopped, so that this frees the mapping: it lives while any process maps it.
      this.frames.close();
    }
  }
}
