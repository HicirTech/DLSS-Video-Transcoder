/**
 * The dlssg-host serve loop over real pipes and a real shared mapping, through tests/fake-dlssg-host.ts,
 * with the test playing the parent: replies in frame order, each frame read in place and the generated
 * frames left in the output slot, all of a session's frames or none, disabled and reset replies without
 * payload, a failed status then exit, exit 0 when stdin ends, a setup whose shared memory is missing,
 * too small or empty of frames refused before any generator opens, and a stdout that holds nothing but
 * protocol messages although the generator writes to it on every call. Then the host entry's argument
 * refusals, which return before any GPU work.
 */
import type { Subprocess } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SharedMemory } from "../src/native/shared-memory.ts";
import {
  FRAME_RESULT_BYTES,
  HostStatus,
  SETUP_REPLY_BYTES,
  decodeFrameResult,
  decodeSetupReply,
  encodeFrameHeader,
  encodeSetup,
  type DlssgFrameResult,
  type DlssgSetupReply,
} from "../src/pipeline/dlssg-protocol.ts";
import { dlssgHost } from "../src/pipeline/dlssg-host-launch.ts";
import { sharedFrameLayout, viewRange } from "../src/pipeline/dlssg-shared-layout.ts";
import { FrameReader } from "../src/pipeline/frame-reader.ts";
import { generatedByte, motionByte, rgbaByte } from "./fake-dlssg-host.ts";

const FAKE_HOST = join(import.meta.dir, "fake-dlssg-host.ts");
const WIDTH = 8;
const HEIGHT = 4;
const GENERATED_COUNT = 3;
const LAYOUT = sharedFrameLayout({ width: WIDTH, height: HEIGHT, generatedCount: GENERATED_COUNT });
const CHILD_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 5_000;

interface SentFrame {
  frameId: number;
  reset?: boolean;
  /** Zero the header's first byte, as a parent speaking another protocol would. */
  corruptMagic?: boolean;
}

interface Reply {
  result: DlssgFrameResult;
  /** The frames the output slot held when the reply arrived: copies, since the next interval overwrites the slot. */
  frames: Uint8Array[];
}

interface HostEnd {
  /** Stdout bytes after the last whole message; a stray write shows up here or breaks a decode. */
  strayStdoutBytes: number;
  stderr: string;
  exitCode: number;
}

interface HostOptions {
  /** More arguments for the fake host. */
  args?: string[];
  /** Size of the mapping the test creates for the host, or null to create none. */
  mappingBytes?: number | null;
}

/**
 * The test acting as the parent: it owns the shared mapping, starts the fake host on it and trades
 * messages in lock step, since the single input slot allows one frame in flight.
 */
class HostConversation {
  readonly mappingName = `dlssg-host-test-${crypto.randomUUID()}`;
  readonly memory: SharedMemory | null;
  private readonly child: Subprocess<"pipe", "pipe", "pipe">;
  private readonly stdout: FrameReader;
  private readonly stderr: Promise<string>;
  private readonly killTimer: ReturnType<typeof setTimeout>;

  constructor({ args = [], mappingBytes = LAYOUT.totalBytes }: HostOptions) {
    this.memory = mappingBytes === null ? null : SharedMemory.create(this.mappingName, mappingBytes);
    this.child = Bun.spawn([process.execPath, FAKE_HOST, "--shared", this.mappingName, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.stdout = new FrameReader(this.child.stdout);
    this.stderr = new Response(this.child.stderr).text();
    this.killTimer = setTimeout(() => this.child.kill(), CHILD_TIMEOUT_MS);
  }

  /** Sends the setup and reads the reply, or null when the host closed stdout without one. */
  async setup(frameCount = 100, size = { width: WIDTH, height: HEIGHT }): Promise<DlssgSetupReply | null> {
    await this.send(encodeSetup({ ...size, frameCount, generatedCount: GENERATED_COUNT }));
    const reply = await this.stdout.next(SETUP_REPLY_BYTES);
    return reply ? decodeSetupReply(reply) : null;
  }

  /** Writes the frame into the input slot, sends its header and reads the reply, and the generated frames out of the output slot. */
  async frame(sent: SentFrame): Promise<Reply | null> {
    const bytes = this.memory!.bytes;
    viewRange(bytes, LAYOUT.rgba).fill(rgbaByte(sent.frameId));
    viewRange(bytes, LAYOUT.motion).fill(motionByte(sent.frameId));
    const header = encodeFrameHeader({ index: sent.frameId, reset: sent.reset ?? false, timestampNumerator: BigInt(sent.frameId), timestampDenominator: 30n });
    if (sent.corruptMagic) header[0] = 0;
    await this.send(header);
    const replyBytes = await this.stdout.next(FRAME_RESULT_BYTES);
    if (!replyBytes) return null;
    const result = decodeFrameResult(replyBytes);
    const frames = result.outcome === "generated" ? LAYOUT.generated.slice(0, result.frameCount).map((slot) => viewRange(bytes, slot).slice()) : [];
    return { result, frames };
  }

  async send(bytes: Uint8Array): Promise<void> {
    this.child.stdin.write(bytes);
    await this.child.stdin.flush();
  }

  /** Ends stdin and waits for the host to exit. */
  async finish(): Promise<HostEnd> {
    try {
      await this.child.stdin.end();
    } catch {
      // A host that failed has already closed its input.
    }
    const exitCode = await this.child.exited;
    let strayStdoutBytes = 0;
    while (await this.stdout.next(1)) strayStdoutBytes++;
    const stderr = await this.stderr;
    this.release();
    return { strayStdoutBytes, stderr, exitCode };
  }

  /** Stops the host if it still runs and closes the mapping; safe to repeat. */
  release(): void {
    clearTimeout(this.killTimer);
    this.child.kill();
    this.memory?.close();
  }
}

const conversations: HostConversation[] = [];
function startHost(options: HostOptions = {}): HostConversation {
  const conversation = new HostConversation(options);
  conversations.push(conversation);
  return conversation;
}
afterEach(() => {
  for (const conversation of conversations.splice(0)) conversation.release();
});

function expectGenerated(reply: Reply | null | undefined, frameId: number): void {
  expect(reply?.result).toEqual({ outcome: "generated", frameCount: GENERATED_COUNT });
  expect(reply!.frames).toHaveLength(GENERATED_COUNT);
  for (const [position, frame] of reply!.frames.entries()) {
    expect(frame.byteLength).toBe(LAYOUT.rgba.byteLength);
    expect(frame.every((value) => value === generatedByte(frameId, position + 1))).toBe(true);
  }
}

describe("dlssg-host serve loop", () => {
  test("answers every frame in order, and stdout holds nothing but the replies", async () => {
    const host = startHost({ args: ["--maximum", "5"] });
    expect(await host.setup()).toEqual({ outcome: "ready", maximum: 5 });
    expect((await host.frame({ frameId: 0, reset: true }))?.result).toEqual({ outcome: "empty" });
    expectGenerated(await host.frame({ frameId: 1 }), 1);
    expectGenerated(await host.frame({ frameId: 2 }), 2);
    const end = await host.finish();
    expect(end.strayStdoutBytes).toBe(0);
    expect(end.stderr).toContain("noise from console.log at source frame 1");
    expect(end.stderr).toContain("noise from process.stdout at source frame 2");
    expect(end.stderr).toContain("noise from console.trace at source frame 1");
    expect(end.stderr).toContain("noise from console.count: 2");
    expect(end.stderr).toContain("noise from console.write at source frame 2");
    expect(end.stderr).toContain("noise from console.info at setup 8x4");
    expect(end.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("the output slot holds the latest interval's frames only, which is why the parent copies them out", async () => {
    const host = startHost();
    await host.setup();
    await host.frame({ frameId: 0, reset: true });
    const first = await host.frame({ frameId: 1 });
    await host.frame({ frameId: 2 });
    expectGenerated(first, 1);
    for (const [position, slot] of LAYOUT.generated.entries()) {
      expect(viewRange(host.memory!.bytes, slot).every((value) => value === generatedByte(2, position + 1))).toBe(true);
    }
    expect((await host.finish()).exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("a disabled interval is replied without payload and the next reply follows at once", async () => {
    const host = startHost({ args: ["--disabled-at", "2"] });
    await host.setup();
    const replies = [];
    for (const frameId of [0, 1, 2, 3]) replies.push(await host.frame({ frameId, reset: frameId === 0 }));
    expect(replies.map((reply) => reply?.result.outcome)).toEqual(["empty", "generated", "disabled", "generated"]);
    expect(replies[2]!.frames).toHaveLength(0);
    expectGenerated(replies[3], 3);
    const end = await host.finish();
    expect(end.strayStdoutBytes).toBe(0);
    expect(end.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("serves until stdin ends, past the frame count the setup declared, then closes the generator and exits 0", async () => {
    const host = startHost();
    await host.setup(1);
    const replies = [];
    for (const frameId of [0, 1, 2]) replies.push(await host.frame({ frameId, reset: frameId === 0 }));
    expect(replies).toHaveLength(3);
    const end = await host.finish();
    expect(end.stderr).toContain("fake generator closed");
    expect(end.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("a generation error is replied as a failed status, then the host closes the generator and exits non-zero", async () => {
    const host = startHost({ args: ["--fail-at", "2"] });
    await host.setup();
    const replies = [];
    for (const frameId of [0, 1, 2]) replies.push(await host.frame({ frameId, reset: frameId === 0 }));
    expect(replies.map((reply) => reply?.result)).toEqual([{ outcome: "empty" }, { outcome: "generated", frameCount: GENERATED_COUNT }, { outcome: "failed", status: HostStatus.generationFailed }]);
    const end = await host.finish();
    expect(end.strayStdoutBytes).toBe(0);
    expect(end.stderr).toContain("scripted failure at source frame 2");
    expect(end.stderr).toContain("fake generator closed");
    expect(end.exitCode).toBe(1);
  }, TEST_TIMEOUT_MS);

  test("a short frame set is a failed reply and leaves the output slot empty, never a partial set", async () => {
    const host = startHost({ args: ["--short-at", "1"] });
    await host.setup();
    expect((await host.frame({ frameId: 0, reset: true }))?.result).toEqual({ outcome: "empty" });
    expect((await host.frame({ frameId: 1 }))?.result).toEqual({ outcome: "failed", status: HostStatus.generationFailed });
    for (const slot of LAYOUT.generated) expect(viewRange(host.memory!.bytes, slot).every((value) => value === 0)).toBe(true);
    const end = await host.finish();
    expect(end.strayStdoutBytes).toBe(0);
    expect(end.stderr).toContain("returned 2 frame(s) where the session sends 3");
    expect(end.exitCode).toBe(1);
  }, TEST_TIMEOUT_MS);

  test("a refused setup is replied with its status and nothing else", async () => {
    const host = startHost({ args: ["--refuse", String(HostStatus.unavailable)] });
    expect(await host.setup()).toEqual({ outcome: "refused", status: HostStatus.unavailable });
    const end = await host.finish();
    expect(end.strayStdoutBytes).toBe(0);
    expect(end.stderr).toContain("scripted refusal");
    expect(end.exitCode).toBe(1);
  }, TEST_TIMEOUT_MS);

  test("a setup naming a mapping that does not exist is refused before the generator opens", async () => {
    const host = startHost({ mappingBytes: null });
    expect(await host.setup()).toEqual({ outcome: "refused", status: HostStatus.sharedMemoryFailed });
    const end = await host.finish();
    expect(end.strayStdoutBytes).toBe(0);
    expect(end.stderr).toContain(`setup refused (status ${HostStatus.sharedMemoryFailed}): OpenFileMappingW failed for shared memory "${host.mappingName}"`);
    expect(end.stderr).not.toContain("noise from console.info at setup");
    expect(end.exitCode).toBe(1);
  }, TEST_TIMEOUT_MS);

  test("a mapping smaller than the setup's frames need is refused before the generator opens", async () => {
    const host = startHost();
    expect(await host.setup(100, { width: 64, height: 64 })).toEqual({ outcome: "refused", status: HostStatus.sharedMemoryFailed });
    const end = await host.finish();
    expect(end.stderr).toContain(`MapViewOfFile failed for shared memory "${host.mappingName}"`);
    expect(end.stderr).toContain("the mapping may be smaller than the 81920 bytes asked for");
    expect(end.stderr).not.toContain("noise from console.info at setup");
    expect(end.exitCode).toBe(1);
  }, TEST_TIMEOUT_MS);

  test("a setup that describes no frame is refused as a bad request", async () => {
    const host = startHost();
    expect(await host.setup(100, { width: 0, height: HEIGHT })).toEqual({ outcome: "refused", status: HostStatus.badRequest });
    const end = await host.finish();
    expect(end.stderr).toContain("Shared frame memory needs a whole width, height and generatedCount of at least 1");
    expect(end.stderr).not.toContain("noise from console.info at setup");
    expect(end.exitCode).toBe(1);
  }, TEST_TIMEOUT_MS);

  test("a frame with a bad magic is replied as a bad request", async () => {
    const host = startHost();
    await host.setup();
    expect((await host.frame({ frameId: 0, reset: true }))?.result).toEqual({ outcome: "empty" });
    expect((await host.frame({ frameId: 1, corruptMagic: true }))?.result).toEqual({ outcome: "failed", status: HostStatus.badRequest });
    const end = await host.finish();
    expect(end.strayStdoutBytes).toBe(0);
    expect(end.stderr).toContain("fake generator closed");
    expect(end.exitCode).toBe(1);
  }, TEST_TIMEOUT_MS);

  test("stdin that ends before a setup asks for nothing: no stdout and exit 0", async () => {
    const end = await startHost().finish();
    expect(end.strayStdoutBytes).toBe(0);
    expect(end.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("stdin that ends inside a frame header is dropped like the end of stdin: no reply to it and exit 0", async () => {
    const host = startHost();
    await host.setup();
    expect((await host.frame({ frameId: 0, reset: true }))?.result).toEqual({ outcome: "empty" });
    await host.send(encodeFrameHeader({ index: 1, reset: false, timestampNumerator: 1n, timestampDenominator: 30n }).subarray(0, 10));
    const end = await host.finish();
    expect(end.strayStdoutBytes).toBe(0);
    expect(end.stderr).toContain("fake generator closed");
    expect(end.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);
});

describe("dlssg-host arguments", () => {
  const HOST = join(import.meta.dir, "..", "src", "pipeline", "dlssg-host.ts");

  async function runCommand(command: string[]): Promise<{ stdout: Uint8Array; stderr: string; exitCode: number }> {
    const child = Bun.spawn(command, { cwd: import.meta.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timer);
    }
  }

  function runArguments(args: string[]): ReturnType<typeof runCommand> {
    return runCommand([process.execPath, HOST, ...args]);
  }

  test("the serve command line dlssgHost builds is accepted: with nothing on stdin the host asks for nothing and exits 0", async () => {
    const run = await runCommand(dlssgHost(import.meta.dir).command({ mode: "--serve", sharedMemoryName: "dlssg-fg-never-opened" }));
    expect(run.stdout.byteLength).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("an unknown mode prints the usage on stderr and exits 2 before touching the GPU", async () => {
    const run = await runArguments(["--bogus"]);
    expect(run.stdout.byteLength).toBe(0);
    expect(run.stderr).toContain("usage: bun src/pipeline/dlssg-host.ts --probe|--serve");
    expect(run.exitCode).toBe(2);
  }, TEST_TIMEOUT_MS);

  test("a relative --runtime is refused, since the parent chooses the host's working folder", async () => {
    const run = await runArguments(["--serve", "--runtime", "runtime", "--shared", "frames"]);
    expect(run.stdout.byteLength).toBe(0);
    expect(run.stderr).toContain('--runtime must be an absolute path, got "runtime"');
    expect(run.exitCode).toBe(2);
  }, TEST_TIMEOUT_MS);

  test("--serve without --shared is refused, since the frames have nowhere to be", async () => {
    const run = await runArguments(["--serve", "--runtime", import.meta.dir]);
    expect(run.stdout.byteLength).toBe(0);
    expect(run.stderr).toContain("--serve needs --shared, the name of the shared frame memory the parent created");
    expect(run.exitCode).toBe(2);
  }, TEST_TIMEOUT_MS);

  test("--probe takes no --shared, and an option without its value or given twice is a usage error", async () => {
    for (const args of [["--probe", "--shared", "frames"], ["--serve", "--shared"], ["--serve", "--shared", "a", "--shared", "b"]]) {
      const run = await runArguments(args);
      expect(run.stdout.byteLength).toBe(0);
      expect(run.stderr).toContain("usage: bun src/pipeline/dlssg-host.ts --probe|--serve");
      expect(run.exitCode).toBe(2);
    }
  }, TEST_TIMEOUT_MS);
});
