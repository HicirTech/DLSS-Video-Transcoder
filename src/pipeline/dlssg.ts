/**
 * DLSS Frame Generation (NGX feature 11 / DLSSG) driven through NVIDIA's small
 * native worker, `dlssg-worker.exe`, over its binary stdin/stdout protocol.
 *
 * Frame generation binds many D3D12 resources and expects a Streamline-style
 * init that is impractical to reproduce from bun:ffi, so — like the reference
 * project — we run it out of process. The worker owns the NGX device and the
 * DLSSG history; we stream it colour + motion and read back the synthesised
 * in-between frames. The worker image (and the `nvngx_dlssg.dll` beside it) is
 * third-party; run it only from a trusted, user-supplied runtime folder.
 */
import { join } from "node:path";

const SETUP_MAGIC = 0x31534746; // 'FGS1'
const SETUP_OUT_MAGIC = 0x31524746; // 'FGR1'
const FRAME_MAGIC = 0x31464746; // 'FGF1'
const FRAME_OUT_MAGIC = 0x314f4746; // 'FGO1'

export interface DlssgProbe {
  available: boolean;
  multiFrameCountMax: number;
  runtimeVersion: string;
  workerVersion: string;
  detail: string;
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
  };
}

/** Reads exact-size records from a byte stream of arbitrary chunks. */
class ExactReader {
  private pending: Uint8Array[] = [];
  private available = 0;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: ReadableStream<Uint8Array>) {
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
    const out = new Uint8Array(size);
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
}

export class DlssgSession {
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
    // Drain stderr so the worker never blocks on a full pipe; keep the tail for errors.
    void new Response(proc.stderr).text().catch(() => "");

    const reader = new ExactReader(proc.stdout as ReadableStream<Uint8Array>);
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
