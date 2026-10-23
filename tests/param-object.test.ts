import { expect, test } from "bun:test";
import { NativeStruct, asPtr } from "../src/native/memory.ts";
import { NgxParamObject } from "../src/ngx/param-object.ts";
import { NgxParameters } from "../src/ngx/params.ts";

test("our parameter object round-trips values through the NGX vtable (msvc layout)", () => {
  const paramObject = new NgxParamObject();
  try {
    const vtableParameters = new NgxParameters(paramObject.ptr, "allocated");
    // The runtime drives this object through its vtable; confirm the layout it detects is ours.
    expect(NgxParameters.detectLayout(vtableParameters)).toBe("msvc");

    vtableParameters.setU32("Width", 1920);
    vtableParameters.setI32("Signed", -7);
    vtableParameters.setF32("Scale", 1.5);
    vtableParameters.setF64("Precise", 0.3125);
    vtableParameters.setU64("Big", 0x1_2345_6789n);
    const resource = new NativeStruct(16);
    vtableParameters.setResource("Color", asPtr(resource.ptr));

    expect(vtableParameters.getU32("Width")).toBe(1920);
    expect(vtableParameters.getI32("Signed")).toBe(-7);
    expect(vtableParameters.getF32("Scale")).toBeCloseTo(1.5, 6);
    expect(paramObject.getF64("Precise")).toBeCloseTo(0.3125, 12); // NgxParameters has no getF64
    expect(vtableParameters.getU64("Big")).toBe(0x1_2345_6789n);
    expect(vtableParameters.getPointer("Color")).toBe(asPtr(resource.ptr));
    expect(vtableParameters.getU32("NeverSet")).toBeNull();

    // Values our own TS setters wrote are visible to vtable reads and vice versa.
    paramObject.setU32("FromTs", 42);
    expect(vtableParameters.getU32("FromTs")).toBe(42);
    vtableParameters.setU32("FromVtable", 99);
    expect(paramObject.getU32("FromVtable")).toBe(99);

    paramObject.reset();
    expect(vtableParameters.getU32("Width")).toBeNull();
  } finally {
    paramObject.close();
  }
});
