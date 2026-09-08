import { expect, test } from "bun:test";
import { NativeStruct, asPtr } from "../src/native/memory.ts";
import { NgxParamObject } from "../src/ngx/param-object.ts";
import { NgxParameters } from "../src/ngx/params.ts";

test("our parameter object round-trips values through the NGX vtable (msvc layout)", () => {
  const obj = new NgxParamObject();
  const p = new NgxParameters(obj.ptr, "allocated");
  // The runtime drives this object through its vtable; confirm the layout it detects is ours.
  expect(NgxParameters.detectLayout(p)).toBe("msvc");

  p.setU32("Width", 1920);
  p.setI32("Signed", -7);
  p.setF32("Scale", 1.5);
  p.setF64("Precise", 0.3125);
  p.setU64("Big", 0x1_2345_6789n);
  const resource = new NativeStruct(16);
  p.setResource("Color", asPtr(resource.ptr));

  expect(p.getU32("Width")).toBe(1920);
  expect(p.getI32("Signed")).toBe(-7);
  expect(p.getF32("Scale")).toBeCloseTo(1.5, 6);
  expect(obj.getF64("Precise")).toBeCloseTo(0.3125, 12); // NgxParameters has no getF64
  expect(p.getU64("Big")).toBe(0x1_2345_6789n);
  expect(p.getPointer("Color")).toBe(asPtr(resource.ptr));
  expect(p.getU32("NeverSet")).toBeNull();

  // Values our own TS setters wrote are visible to vtable reads and vice versa.
  obj.setU32("FromTs", 42);
  expect(p.getU32("FromTs")).toBe(42);
  p.setU32("FromVtable", 99);
  expect(obj.getU32("FromVtable")).toBe(99);

  obj.reset();
  expect(p.getU32("Width")).toBeNull();
  obj.close();
});
