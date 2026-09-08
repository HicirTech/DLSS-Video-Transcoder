import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { buildForwarderDll, FORWARDER_EXPORTS } from "../src/ngx/forwarder.ts";
import { loadForwarder, selfTestForwarder } from "../src/ngx/forwarder-runtime.ts";
import { parsePe } from "../src/native/pe.ts";

test("generated shim is a well-formed x64 DLL with the expected exports", () => {
  const built = buildForwarderDll();
  const info = parsePe(built.bytes);
  expect(info.is64).toBe(true);
  expect(info.isDll).toBe(true);
  expect(info.machine).toBe(0x8664);
  expect(info.sections.map((s) => s.name)).toEqual([".text", ".data", ".reloc"]);
  expect(info.exports.map((e) => e.name)).toEqual([...FORWARDER_EXPORTS].sort());
  for (const e of info.exports) expect(e.forwarder).toBeNull();
});

test("shim loads and forwards calls with arguments intact", () => {
  const dir = `${import.meta.dir}\\..\\runtime\\caller`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}\\nvngx.dll`;
  const built = buildForwarderDll();
  require("node:fs").writeFileSync(path, built.bytes);
  const fwd = loadForwarder(path);
  const result = selfTestForwarder(fwd);
  expect(result.detail).toContain("pass through");
  expect(result.ok).toBe(true);
  fwd.module.free();
});
