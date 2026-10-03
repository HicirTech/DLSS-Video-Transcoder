import { describe, expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";
import { isWithin } from "../src/server/path-scope.ts";

const ROOT = resolve(sep === "\\" ? "C:\\app\\logs" : "/app/logs");

describe("isWithin", () => {
  test("accepts the root itself and paths under it", () => {
    expect(isWithin(ROOT, ROOT)).toBe(true);
    expect(isWithin(join(ROOT, "out.mp4"), ROOT)).toBe(true);
    expect(isWithin(join(ROOT, "a", "b", "out.mp4"), ROOT)).toBe(true);
  });

  test("accepts a child whose name merely starts with two dots", () => {
    // The bug this covers: a string-prefix check read "..cache" as an escape.
    expect(isWithin(join(ROOT, "..cache", "out.mp4"), ROOT)).toBe(true);
    expect(isWithin(join(ROOT, "..", "logs", "..hidden.mp4"), ROOT)).toBe(true);
  });

  test("rejects escapes and sibling directories that share a prefix", () => {
    expect(isWithin(join(ROOT, "..", "etc", "passwd"), ROOT)).toBe(false);
    expect(isWithin(resolve(ROOT, ".."), ROOT)).toBe(false);
    expect(isWithin(`${ROOT}2${sep}out.mp4`, ROOT)).toBe(false);
    expect(isWithin(`${ROOT}-backup${sep}out.mp4`, ROOT)).toBe(false);
  });
});
