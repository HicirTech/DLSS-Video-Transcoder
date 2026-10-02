/**
 * The parent side of the DLSS Frame Generation host, driven against tests/fake-dlssg-host.ts over
 * real pipes and a real shared mapping: the frames it returns, which stay valid when the next interval
 * overwrites the output slot; which message each refusal, failure and early exit becomes (with the
 * host's stderr, a Bun crash report cut to its panic line); the shared memory released on every path;
 * a probe that prints nothing or never finishes; and how dlssgHost starts the host. No GPU.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { basename, isAbsolute, join, resolve } from "node:path";
import { SharedMemory } from "../src/native/shared-memory.ts";
import { DlssgSession, probeDlssgHost, type DlssgOptions } from "../src/pipeline/dlssg.ts";
import { HOST_PROCESS_NAME, dlssgHost, type DlssgHost } from "../src/pipeline/dlssg-host-launch.ts";
import { motionFieldBytes, rgbaFrameBytes } from "../src/pipeline/dlssg-protocol.ts";
import { sharedFrameLayout } from "../src/pipeline/dlssg-shared-layout.ts";
import { generatedByte, motionByte, rgbaByte } from "./fake-dlssg-host.ts";

const FAKE_HOST = join(import.meta.dir, "fake-dlssg-host.ts");
const WIDTH = 8;
const HEIGHT = 4;
const GENERATED_COUNT = 3;
const CLOSE_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 20_000;

/** The names of the shared memory that the hosts of this file were started with, oldest first. */
const startedMappings: string[] = [];

/** A host whose command is fixed, or built from the name of the shared memory a --serve launch hands it. */
function fakeHost(command: string[] | ((sharedMemoryName: string) => string[])): DlssgHost {
  return {
    cwd: import.meta.dir,
    env: undefined,
    hint: "Check the fake.",
    command: (launch) => {
      if (launch.mode === "--serve") startedMappings.push(launch.sharedMemoryName);
      if (typeof command !== "function") return command;
      return command(launch.mode === "--serve" ? launch.sharedMemoryName : "");
    },
  };
}

function servingHost(args: string[]): DlssgHost {
  return fakeHost((sharedMemoryName) => [process.execPath, FAKE_HOST, ...args, "--shared", sharedMemoryName]);
}

function openSession(host: DlssgHost, options: Partial<DlssgOptions> = {}): Promise<DlssgSession> {
  return DlssgSession.openOn(host, { width: WIDTH, height: HEIGHT, generatedCount: GENERATED_COUNT, ...options });
}

function sendFrame(session: DlssgSession, frameId: number): Promise<Uint8Array[]> {
  const rgba = new Uint8Array(rgbaFrameBytes(WIDTH, HEIGHT)).fill(rgbaByte(frameId));
  const motion = new Uint8Array(motionFieldBytes(WIDTH, HEIGHT)).fill(motionByte(frameId));
  return session.processFrame(rgba, new Uint16Array(motion.buffer), frameId, frameId === 0, BigInt(frameId), 30n);
}

/** True once no process holds the shared memory called `name`. */
function isReleased(name: string): boolean {
  try {
    SharedMemory.open(name, 1).close();
    return false;
  } catch {
    return true;
  }
}

/**
 * A host that answers the setup ready, then answers the first frame header with a result claiming one
 * generated frame more than the session has room for, and exits shortly after.
 */
const READY_THEN_TOO_MANY_FRAMES = `const input = Bun.stdin.stream().getReader(); await input.read(); process.stdout.write(new Uint8Array(new Uint32Array([0x31524746, 0, 5, 0]).buffer)); await input.read(); process.stdout.write(new Uint8Array(new Uint32Array([0x324f4746, 0, ${GENERATED_COUNT + 1}, 0]).buffer)); setTimeout(() => process.exit(0), 300);`;

/** A bun child that writes `lastWords` to stderr, then segfaults, so Bun prints its crash report (exit code 3). */
function crashingCommand(lastWords: string): string[] {
  return [process.execPath, "-e", `console.error(${JSON.stringify(lastWords)}); require("bun:ffi").read.u8(8)`];
}

/** The message `pending` rejects with; a fulfilment fails the test. */
async function failure(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a rejection");
}

const opened: DlssgSession[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((session) => session.close(CLOSE_TIMEOUT_MS)));
});

describe("DlssgSession against a host process", () => {
  test("returns the host's frames for each source frame", async () => {
    const session = await openSession(servingHost(["--maximum", "5"]));
    opened.push(session);
    expect(session.maximum).toBe(5);
    expect(await sendFrame(session, 0)).toEqual([]);
    const frames = await sendFrame(session, 1);
    expect(frames).toHaveLength(GENERATED_COUNT);
    for (const [position, frame] of frames.entries()) {
      expect(frame.byteLength).toBe(rgbaFrameBytes(WIDTH, HEIGHT));
      expect(frame.every((value) => value === generatedByte(1, position + 1))).toBe(true);
    }
  }, TEST_TIMEOUT_MS);

  test("frames already returned keep their bytes when the next interval overwrites the output slot", async () => {
    const session = await openSession(servingHost([]));
    opened.push(session);
    await sendFrame(session, 0);
    const first = await sendFrame(session, 1);
    const second = await sendFrame(session, 2);
    for (const [position, frame] of first.entries()) expect(frame.every((value) => value === generatedByte(1, position + 1))).toBe(true);
    for (const [position, frame] of second.entries()) expect(frame.every((value) => value === generatedByte(2, position + 1))).toBe(true);
  }, TEST_TIMEOUT_MS);

  test("frames are SharedArrayBuffers when the session is asked for them, and plain buffers otherwise", async () => {
    const plain = await openSession(servingHost([]));
    const shared = await openSession(servingHost([]), { sharedFrames: true });
    opened.push(plain, shared);
    for (const session of [plain, shared]) await sendFrame(session, 0);
    expect((await sendFrame(plain, 1)).every((frame) => frame.buffer instanceof ArrayBuffer)).toBe(true);
    expect((await sendFrame(shared, 1)).every((frame) => frame.buffer instanceof SharedArrayBuffer)).toBe(true);
  }, TEST_TIMEOUT_MS);

  test("a disabled interval is counted and returns no frames", async () => {
    const session = await openSession(servingHost(["--disabled-at", "2"]));
    opened.push(session);
    await sendFrame(session, 0);
    expect(await sendFrame(session, 1)).toHaveLength(GENERATED_COUNT);
    expect(await sendFrame(session, 2)).toEqual([]);
    expect(session.disabledFrames).toBe(1);
  }, TEST_TIMEOUT_MS);

  test("a frame of the wrong size is refused before anything is sent, so the session stays in step with the host", async () => {
    const session = await openSession(servingHost([]));
    opened.push(session);
    const message = await failure(session.processFrame(new Uint8Array(10), new Uint16Array(motionFieldBytes(WIDTH, HEIGHT) / 2), 0, true, 0n, 30n));
    expect(message).toBe(`DLSS Frame Generation was given 10 bytes of colour and ${motionFieldBytes(WIDTH, HEIGHT)} bytes of motion for a session whose frames take ${rgbaFrameBytes(WIDTH, HEIGHT)} and ${motionFieldBytes(WIDTH, HEIGHT)}`);
    expect(await sendFrame(session, 0)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test("a maximum below the request is refused here with the lower-multiplier message", async () => {
    expect(await failure(openSession(servingHost(["--maximum", "2"])))).toMatch(/can generate at most 2 in-between frame\(s\) per source frame; 3 was requested\. Use a lower multiplier\./);
  }, TEST_TIMEOUT_MS);

  test("status 2 becomes the lower-multiplier message, quoting what the host said", async () => {
    expect(await failure(openSession(servingHost(["--refuse", "2"])))).toMatch(/cannot generate 3 in-between frame\(s\) per source frame \(exit code 1\); it said: .*scripted refusal\. Use a lower multiplier\./);
  }, TEST_TIMEOUT_MS);

  test("any other refusal status is reported as it is, quoting what the host said", async () => {
    const message = await failure(openSession(servingHost(["--refuse", "3"])));
    expect(message).toStartWith(`DLSS Frame Generation could not be set up: ${HOST_PROCESS_NAME} refused with status 3 (exit code 1); it said: `);
    expect(message).toMatch(/scripted refusal\. Check the fake\.$/);
  }, TEST_TIMEOUT_MS);

  test("a failed frame reply names the frame and the status, and quotes the host", async () => {
    const session = await openSession(servingHost(["--fail-at", "1"]));
    opened.push(session);
    await sendFrame(session, 0);
    const message = await failure(sendFrame(session, 1));
    expect(message).toStartWith(`DLSS Frame Generation failed while processing frame 1: ${HOST_PROCESS_NAME} replied status 5 (exit code 1); it said: `);
    expect(message).toMatch(/scripted failure at source frame 1 .*\. Check the fake\.$/);
  }, TEST_TIMEOUT_MS);

  test("a host that has exited is reported as stopped, with its exit code, not as a bare pipe error", async () => {
    const session = await openSession(servingHost(["--fail-at", "1"]));
    opened.push(session);
    await sendFrame(session, 0);
    await sendFrame(session, 1).catch(() => []);
    const message = await failure(sendFrame(session, 2));
    expect(message).toStartWith(`${HOST_PROCESS_NAME} stopped unexpectedly while processing frame 2 (exit code 1)`);
    expect(message).toEndWith(". Check the fake.");
  }, TEST_TIMEOUT_MS);

  test("a host reporting more generated frames than the session has room for is refused, not read past the output slot", async () => {
    const session = await openSession(fakeHost([process.execPath, "-e", READY_THEN_TOO_MANY_FRAMES]));
    opened.push(session);
    expect(await failure(sendFrame(session, 0))).toBe(`${HOST_PROCESS_NAME} reported ${GENERATED_COUNT + 1} generated frame(s) for frame 0, more than the ${GENERATED_COUNT} this session has room for. Check the fake.`);
  }, TEST_TIMEOUT_MS);

  test("a host that crashes before answering setup is quoted up to Bun's panic line, not Bun's bug-report footer", async () => {
    const message = await failure(openSession(fakeHost(crashingCommand("opening the feature"))));
    expect(message).toMatch(/stopped before answering the DLSS Frame Generation setup \(exit code 3\); it said: opening the feature \/ panic\(main thread\): Segmentation fault at address 0x8\. Check the fake\.$/);
    expect(message).not.toContain("bun.report");
  }, TEST_TIMEOUT_MS);

  test("a host that stops before answering setup says so, with what it wrote", async () => {
    const host = fakeHost([process.execPath, "-e", "console.error('no runtime here'); process.exit(3)"]);
    expect(await failure(openSession(host))).toMatch(/stopped before answering the DLSS Frame Generation setup \(exit code 3\); it said: no runtime here\. Check the fake\./);
  }, TEST_TIMEOUT_MS);
});

describe("DlssgSession's shared memory", () => {
  test("is released when closing the session ends the host", async () => {
    const session = await openSession(servingHost([]));
    await sendFrame(session, 0);
    const name = startedMappings.at(-1)!;
    expect(isReleased(name)).toBe(false);
    await session.close(CLOSE_TIMEOUT_MS);
    expect(isReleased(name)).toBe(true);
    await session.close(CLOSE_TIMEOUT_MS);
  }, TEST_TIMEOUT_MS);

  test("is released when the host refuses the setup", async () => {
    await failure(openSession(servingHost(["--refuse", "3"])));
    expect(isReleased(startedMappings.at(-1)!)).toBe(true);
  }, TEST_TIMEOUT_MS);

  test("is released when the host dies before answering setup", async () => {
    await failure(openSession(fakeHost(crashingCommand("opening the feature"))));
    expect(isReleased(startedMappings.at(-1)!)).toBe(true);
  }, TEST_TIMEOUT_MS);

  test("that cannot be created fails the open before any process starts", async () => {
    const options = { width: 1_000_000, height: 1_000_000, generatedCount: GENERATED_COUNT };
    const startedBefore = startedMappings.length;
    const message = await failure(openSession(servingHost([]), options));
    expect(message).toStartWith(`DLSS Frame Generation could not create the ${sharedFrameLayout(options).totalBytes}-byte shared memory its frames travel in: `);
    expect(startedMappings).toHaveLength(startedBefore);
  }, TEST_TIMEOUT_MS);
});

describe("probeDlssgHost", () => {
  test("a host that prints no probe line is unavailable, with its exit code and stderr as the reason", async () => {
    const probe = await probeDlssgHost(fakeHost([process.execPath, "-e", "console.error('no runtime here'); process.exit(3)"]));
    expect(probe.available).toBe(false);
    expect(probe.workerVersion).toBe("");
    expect(probe.detail).toBe(`${HOST_PROCESS_NAME} exited 3 without reporting: no runtime here`);
  }, TEST_TIMEOUT_MS);

  test("a host that crashes while probing is quoted up to Bun's panic line", async () => {
    const probe = await probeDlssgHost(fakeHost(crashingCommand("probing the runtime")));
    expect(probe.detail).toBe(`${HOST_PROCESS_NAME} exited 3 without reporting: probing the runtime / panic(main thread): Segmentation fault at address 0x8`);
  }, TEST_TIMEOUT_MS);

  test("a probe that does not finish in time is stopped and reported unavailable", async () => {
    const probe = await probeDlssgHost(fakeHost([process.execPath, "-e", "setInterval(() => {}, 1000)"]), 500);
    expect(probe.available).toBe(false);
    expect(probe.workerVersion).toBe("");
    expect(probe.detail).toBe(`${HOST_PROCESS_NAME} did not finish --probe within 0.5 s and was stopped. Check the fake.`);
  }, TEST_TIMEOUT_MS);
});

describe("dlssgHost", () => {
  test("the host runs under this bun with an absolute runtime root and without NGX's logging switches", () => {
    process.env.__NGX_LOG_LEVEL_FOR_TEST = "1";
    try {
      const host = dlssgHost(join("some", "runtime"));
      const command = host.command({ mode: "--probe" });
      expect(command[0]).toBe(process.execPath);
      expect(command.slice(2, 4)).toEqual(["--probe", "--runtime"]);
      expect(isAbsolute(command[4]!)).toBe(true);
      expect(host.cwd).toBe(join("some", "runtime", "dlssg"));
      expect(Object.keys(host.env!).some((name) => name.toUpperCase().startsWith("__NGX_LOG_"))).toBe(false);
      expect(host.env!.PATH ?? host.env!.Path).toBeDefined();
    } finally {
      delete process.env.__NGX_LOG_LEVEL_FOR_TEST;
    }
  });

  test("the serve command names the shared memory, and the probe command does not", () => {
    const host = dlssgHost(join("some", "runtime"));
    expect(host.command({ mode: "--serve", sharedMemoryName: "dlssg-fg-test" }).slice(-2)).toEqual(["--shared", "dlssg-fg-test"]);
    expect(host.command({ mode: "--probe" })).not.toContain("--shared");
  });

  test("the hint names the folder to check for nvngx_dlssg.dll and the folder the shim is written to", () => {
    const host = dlssgHost(join("some", "runtime"));
    expect(host.hint).toContain(host.cwd);
    expect(host.hint).toContain(join(resolve(join("some", "runtime")), "caller"));
  });

  test("messages name the script the command runs", () => {
    expect(HOST_PROCESS_NAME).toContain(basename(dlssgHost("runtime").command({ mode: "--serve", sharedMemoryName: "dlssg-fg-test" })[1]!));
  });
});
