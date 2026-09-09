/**
 * DLSS Frame Generation (NGX feature 11 / DLSSG) driven through NVIDIA's small
 * native worker, `dlssg-worker.exe`, over its binary stdin/stdout protocol.
 *
 * Out of process because DLSSG binds many D3D12 resources and expects a
 * Streamline-style init that bun:ffi cannot reproduce. The worker owns the NGX
 * device and the DLSSG history; this side streams colour + motion in and reads
 * the synthesised in-between frames back. The worker image and the
 * `nvngx_dlssg.dll` beside it are third-party: run them only from a trusted,
 * user-supplied runtime folder.
 */
import { join } from "node:path";

const SETUP_MAGIC = 0x31534746; // 'FGS1'
const SETUP_OUT_MAGIC = 0x31524746; // 'FGR1'
const FRAME_MAGIC = 0x31464746; // 'FGF1'
const FRAME_OUT_MAGIC = 0x314f4746; // 'FGO1'

export interface DlssgProbe {
  available: boolean;
  /** In-between frames the runtime claims per interval (native multiplier max = this + 1). */
  multiFrameCountMax: number;
  runtimeVersion: string;
  workerVersion: string;
  detail: string;
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
export function probeHags(): boolean {
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

const probeCache = new Map<string, { at: number; probe: Promise<DlssgProbe> }>();

/**
 * probeDlssg memoised per worker folder for `ttlMs`: spawning `--probe` costs
 * roughly a second and capabilities do not change between back-to-back jobs.
 * A failed probe is not cached.
 */
export function probeDlssgCached(workerDir: string, ttlMs = 60_000): Promise<DlssgProbe> {
  const now = Date.now();
  const hit = probeCache.get(workerDir);
  if (hit && now - hit.at < ttlMs) return hit.probe;
  const probe = probeDlssg(workerDir);
  probe.catch(() => probeCache.delete(workerDir));
  probeCache.set(workerDir, { at: now, probe });
  return probe;
}

/** Run `dlssg-worker.exe --probe` and report whether frame generation is available. */
export async function probeDlssg(workerDir: string): Promise<DlssgProbe> {
  const proc = Bun.spawn([join(workerDir, "dlssg-worker.exe"), "--probe"], {
    cwd: workerDir,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  // Drain stdout AND stderr concurrently; reading only stdout would deadlock if
  // the worker filled the unread stderr pipe before finishing its stdout.
  const [text] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const line = text.trim().split(/\r?\n/).filter((l) => l.trim()).pop() ?? "{}";
  const json = JSON.parse(line) as Record<string, unknown>;
  return {
    available: Boolean(json.available),
    multiFrameCountMax: Number(json.multi_frame_count_max ?? 0),
    runtimeVersion: String(json.runtime_version ?? ""),
    workerVersion: String(json.worker_version ?? ""),
    detail: String(json.detail ?? ""),
    hagsEnabled: probeHags(),
  };
}

/** Reads exact-size records from a byte stream of arbitrary chunks. */
class ExactReader {
  private pending: Uint8Array[] = [];
  private available = 0;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  /** `shared` allocates records in SharedArrayBuffers so generated frames can go to Worker threads without a copy. */
  constructor(stream: ReadableStream<Uint8Array>, private readonly shared = false) {
    this.reader = stream.getReader();
  }

  async read(size: number): Promise<Uint8Array> {
    while (this.available < size) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error("The DLSS Frame Generation process stopped unexpectedly. Check that the runtime folder is complete and your GPU driver is up to date.");
      if (value?.byteLength) {
        this.pending.push(value);
        this.available += value.byteLength;
      }
    }
    const out = this.shared ? new Uint8Array(new SharedArrayBuffer(size)) : new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const chunk = this.pending[0]!;
      const take = Math.min(chunk.byteLength, size - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.byteLength) this.pending.shift();
      else this.pending[0] = chunk.subarray(take);
    }
    this.available -= size;
    return out;
  }
}

export interface DlssgOptions {
  width: number;
  height: number;
  /** Total input frames (max(1, count)); a hint the worker uses to size history. */
  frameCount: number;
  /** Frames to synthesise per interval = native multiplier - 1 (1 = 2x). */
  generatedCount: number;
  /** Return generated frames in SharedArrayBuffers (for hand-off to Worker threads without copying). */
  sharedFrames?: boolean;
}

export class DlssgSession {
  /** Frames for which the worker reported generation disabled (status ok, but no in-between frames). */
  disabledFrames = 0;

  private constructor(
    private readonly proc: ReturnType<typeof Bun.spawn>,
    private readonly reader: ExactReader,
    readonly maximum: number,
    readonly width: number,
    readonly height: number,
    readonly generatedCount: number,
  ) {}

  static async open(workerDir: string, opts: DlssgOptions): Promise<DlssgSession> {
    const proc = Bun.spawn([join(workerDir, "dlssg-worker.exe"), "--serve"], {
      cwd: workerDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    // Drain stderr so the worker never blocks on a full pipe. The text is discarded:
    // failures surface as a status code or a short read in ExactReader.
    void new Response(proc.stderr).text().catch(() => "");

    const reader = new ExactReader(proc.stdout as ReadableStream<Uint8Array>, opts.sharedFrames ?? false);
    const setup = new DataView(new ArrayBuffer(20));
    setup.setUint32(0, SETUP_MAGIC, true);
    setup.setUint32(4, opts.width, true);
    setup.setUint32(8, opts.height, true);
    setup.setUint32(12, Math.max(1, opts.frameCount), true);
    setup.setUint32(16, opts.generatedCount, true);
    (proc.stdin as { write(b: Uint8Array): unknown; flush(): unknown }).write(new Uint8Array(setup.buffer));
    await (proc.stdin as { flush(): number | Promise<number> }).flush();

    const replyBytes = await reader.read(16);
    const reply = new DataView(replyBytes.buffer, replyBytes.byteOffset, 16);
    if (reply.getUint32(0, true) !== SETUP_OUT_MAGIC) throw new Error("DLSSG setup: bad reply magic");
    const status = reply.getUint32(4, true);
    if (status !== 0) throw new Error(`DLSS Frame Generation could not be set up (status ${status}). Check the runtime folder and that your GPU driver is up to date.`);
    const maximum = reply.getUint32(8, true);
    if (opts.generatedCount > maximum) throw new Error(`This GPU/runtime can generate at most ${maximum} in-between frame(s) per source frame; ${opts.generatedCount} was requested. Use a lower multiplier.`);
    return new DlssgSession(proc, reader, maximum, opts.width, opts.height, opts.generatedCount);
  }

  /**
   * Feed one real frame; returns the synthesised in-between frames that precede
   * it (empty on a reset / when generation is disabled for this frame). Motion is
   * float16 (height, width, 2) packed as raw uint16.
   */
  async processFrame(rgba: Uint8Array, motion: Uint16Array, index: number, reset: boolean, tsNum: bigint, tsDen: bigint): Promise<Uint8Array[]> {
    const header = new DataView(new ArrayBuffer(32));
    header.setUint32(0, FRAME_MAGIC, true);
    header.setUint32(4, index, true);
    header.setUint32(8, reset ? 1 : 0, true);
    header.setUint32(12, 0, true);
    header.setBigInt64(16, tsNum, true);
    header.setBigInt64(24, tsDen, true);
    const stdin = this.proc.stdin as { write(b: Uint8Array): unknown; flush(): number | Promise<number> };
    stdin.write(new Uint8Array(header.buffer));
    stdin.write(rgba);
    stdin.write(new Uint8Array(motion.buffer, motion.byteOffset, motion.byteLength));
    await stdin.flush();

    const replyBytes = await this.reader.read(16);
    const reply = new DataView(replyBytes.buffer, replyBytes.byteOffset, 16);
    if (reply.getUint32(0, true) !== FRAME_OUT_MAGIC) throw new Error("DLSSG frame: bad reply magic");
    if (reply.getUint32(4, true) !== 0) throw new Error(`DLSS Frame Generation failed while processing a frame (status ${reply.getUint32(4, true)}).`);
    const generated = reply.getUint32(8, true);
    const disabled = reply.getUint32(12, true);
    if (disabled) this.disabledFrames++;
    if (disabled || generated === 0) return [];
    const frameBytes = this.width * this.height * 4;
    const frames: Uint8Array[] = [];
    for (let i = 0; i < generated; i++) frames.push(await this.reader.read(frameBytes));
    return frames;
  }

  async close(): Promise<void> {
    try {
      (this.proc.stdin as { end(): unknown }).end();
      await this.proc.exited;
    } catch {
      this.proc.kill();
    }
  }
}
