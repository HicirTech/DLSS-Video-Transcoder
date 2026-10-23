/**
 * interruptSignal (src/cli/interrupt.ts): the first Ctrl+C aborts the run's signal, so the pipeline's
 * cancellation path runs; the listener is gone after it, so a second Ctrl+C ends the process. No GPU.
 */
import { expect, test } from "bun:test";
import { interruptSignal } from "../src/cli/interrupt.ts";

test("the first SIGINT aborts the signal and removes its listener", () => {
  const before = process.listenerCount("SIGINT");
  const signal = interruptSignal();
  expect(process.listenerCount("SIGINT")).toBe(before + 1);
  expect(signal.aborted).toBe(false);
  process.emit("SIGINT");
  expect(signal.aborted).toBe(true);
  expect(process.listenerCount("SIGINT")).toBe(before);
});
