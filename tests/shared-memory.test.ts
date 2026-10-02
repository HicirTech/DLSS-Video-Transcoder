/**
 * SharedMemory against real Windows file mappings: a name opened again aliases the creator's bytes in
 * this process and in another one, a name that is taken, missing or too large is refused with its
 * Win32 error, a size of exactly 4 GiB reaches the high word of the size, and a closed mapping is
 * released. No GPU.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SharedMemory } from "../src/native/shared-memory.ts";

const MODULE = join(import.meta.dir, "..", "src", "native", "shared-memory.ts");
const SIZE = 64 * 1024;
const FOUR_GIB = 2 ** 32;
const CHILD_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 5_000;

function uniqueName(): string {
  return `shared-memory-test-${crypto.randomUUID()}`;
}

/** Closed after each test, so one that fails halfway leaves no mapping for the next. */
const tracked: SharedMemory[] = [];
function track(memory: SharedMemory): SharedMemory {
  tracked.push(memory);
  return memory;
}
afterEach(() => {
  for (const memory of tracked.splice(0)) memory.close();
});

function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
}

describe("SharedMemory", () => {
  test("a new mapping is zero-filled and exactly the size asked for", () => {
    const memory = track(SharedMemory.create(uniqueName(), SIZE));
    expect(memory.bytes.byteLength).toBe(SIZE);
    expect(memory.bytes.every((value) => value === 0)).toBe(true);
  });

  test("a mapping opened by name aliases the creator's bytes in both directions", () => {
    const name = uniqueName();
    const created = track(SharedMemory.create(name, SIZE));
    const opened = track(SharedMemory.open(name, SIZE));
    created.bytes.set([1, 2, 3], 10);
    expect(opened.bytes.subarray(10, 13)).toEqual(Uint8Array.of(1, 2, 3));
    opened.bytes[SIZE - 1] = 0xee;
    expect(created.bytes[SIZE - 1]).toBe(0xee);
  });

  test("another process sees what a process wrote after it opened the name", async () => {
    const name = uniqueName();
    const memory = track(SharedMemory.create(name, SIZE));
    const script = `const { SharedMemory } = await import(${JSON.stringify(MODULE)}); const memory = SharedMemory.open(${JSON.stringify(name)}, ${SIZE}); memory.bytes.set([9, 8, 7], 100); memory.close();`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
    try {
      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    } finally {
      clearTimeout(timer);
    }
    expect(memory.bytes.subarray(100, 103)).toEqual(Uint8Array.of(9, 8, 7));
  }, TEST_TIMEOUT_MS);

  test("a name that is already taken is refused, not shared", () => {
    const name = uniqueName();
    track(SharedMemory.create(name, SIZE));
    expect(messageOf(() => SharedMemory.create(name, SIZE))).toBe(`Shared memory "${name}" already exists; a new mapping needs a name no process has used`);
  });

  test("a name nobody created is refused with the Win32 error and why", () => {
    const name = uniqueName();
    expect(messageOf(() => SharedMemory.open(name, SIZE))).toStartWith(`OpenFileMappingW failed for shared memory "${name}": Win32 error 2 (0x00000002); no process holds a mapping of that name`);
  });

  test("a mapping smaller than the size asked for is refused", () => {
    const name = uniqueName();
    track(SharedMemory.create(name, SIZE));
    const message = messageOf(() => SharedMemory.open(name, SIZE + 1));
    expect(message).toStartWith(`MapViewOfFile failed for shared memory "${name}": Win32 error `);
    expect(message).toEndWith(`; the mapping may be smaller than the ${SIZE + 1} bytes asked for`);
  });

  test("a size that is not a whole number of at least 1 byte is refused", () => {
    for (const size of [0, -1, 1.5, Number.NaN]) {
      expect(messageOf(() => SharedMemory.create("size-test", size))).toBe(`Shared memory "size-test" needs a size of at least 1 byte, got ${size}`);
    }
  });

  test("a size of exactly 4 GiB reaches the high word of the size", () => {
    const name = uniqueName();
    const created = track(SharedMemory.create(name, FOUR_GIB));
    const opened = track(SharedMemory.open(name, FOUR_GIB));
    expect(created.bytes.byteLength).toBe(FOUR_GIB);
    created.bytes[FOUR_GIB - 1] = 0x5a;
    expect(opened.bytes[FOUR_GIB - 1]).toBe(0x5a);
    expect(opened.bytes[FOUR_GIB - 2]).toBe(0);
  });

  test("close is idempotent, and the bytes refuse to be used after it", () => {
    const name = uniqueName();
    const memory = SharedMemory.create(name, SIZE);
    memory.close();
    expect(() => memory.close()).not.toThrow();
    expect(messageOf(() => memory.bytes)).toBe(`Shared memory "${name}" was closed; its bytes are no longer mapped`);
  });

  test("the mapping is gone once its last holder closes", () => {
    const name = uniqueName();
    const created = SharedMemory.create(name, SIZE);
    const opened = SharedMemory.open(name, SIZE);
    created.close();
    opened.bytes[0] = 1;
    opened.close();
    expect(messageOf(() => SharedMemory.open(name, SIZE))).toContain("Win32 error 2");
  });
});
