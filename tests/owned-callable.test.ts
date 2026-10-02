import { expect, test } from "bun:test";
import type { OwnedCallable } from "../src/native/com.ts";
import { NativeStruct, OutU32 } from "../src/native/memory.ts";

// The checks that matter here are the @ts-expect-error lines: `bunx tsc --noEmit` fails once a
// Pointer argument stops being a compile error.
test("an owned callable takes the buffer that owns memory and refuses its ptr() address", () => {
  const received: unknown[][] = [];
  const callable = ((...args: unknown[]) => {
    received.push(args);
    return 0;
  }) as OwnedCallable;
  const struct = new NativeStruct(16);
  const out = new OutU32();

  callable(0x1000, struct.bytes, out.bytes, null, 7n);
  // @ts-expect-error a struct's `.ptr` keeps nothing alive through the call
  callable(0x1000, struct.ptr);

  expect(received.map((args) => args.length)).toEqual([5, 2]);
  expect(received[0]![1]).toBe(struct.bytes);
});
