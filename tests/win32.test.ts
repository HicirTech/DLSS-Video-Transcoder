import { expect, test } from "bun:test";
import { closeHandle, Win32Event } from "../src/native/win32.ts";

test("closeHandle releases a handle that is held as a number", () => {
  const event = new Win32Event();
  expect(event.wait(0)).toBe(false); // an unsignalled event times out while its handle is valid
  closeHandle(event.handle);
  expect(() => event.wait(0)).toThrow(/WaitForSingleObject failed/); // the closed handle is no longer valid
});
