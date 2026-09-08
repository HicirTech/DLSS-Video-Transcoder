/**
 * DXGI adapter enumeration through bun:ffi, used to pick the NVIDIA GPU on
 * laptops that also carry an integrated GPU.
 */
import { dlopen, FFIType } from "bun:ffi";
import { ComObject, checkHresult } from "./com.ts";
import { NativeStruct, OutPointer, guid, hex32 } from "./memory.ts";

const dxgi = dlopen("dxgi.dll", {
  CreateDXGIFactory1: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
});

export const IID_IDXGIFactory1 = guid("{770aae78-f26f-4dba-a829-253c83d1b387}");
export const IID_IDXGIAdapter1 = guid("{29038f61-3839-4626-91fd-086879011a05}");

const DXGI_ERROR_NOT_FOUND = 0x887a0002 | 0;
const DXGI_ADAPTER_FLAG_SOFTWARE = 2;
export const VENDOR_NVIDIA = 0x10de;

export interface AdapterInfo {
  index: number;
  name: string;
  vendorId: number;
  deviceId: number;
  subSysId: number;
  revision: number;
  dedicatedVideoMemory: bigint;
  dedicatedVideoMemoryMB: number;
  luidLow: number;
  luidHigh: number;
  /** "HHHHHHHH-LLLLLLLL" as printed by other tools. */
  luid: string;
  flags: number;
  software: boolean;
  isNvidia: boolean;
}

export class DxgiAdapter extends ComObject {
  constructor(
    ptr: number,
    readonly info: AdapterInfo,
  ) {
    super(ptr, `IDXGIAdapter1[${info.index}]`);
  }
}

export class DxgiFactory extends ComObject {
  static create(): DxgiFactory {
    const out = new OutPointer();
    const hr = dxgi.symbols.CreateDXGIFactory1(IID_IDXGIFactory1, out.ptr);
    checkHresult(hr, "CreateDXGIFactory1");
    return new DxgiFactory(out.value, "IDXGIFactory1");
  }

  /** Enumerate hardware adapters in DXGI order. The returned objects own their COM references. */
  enumerate(): DxgiAdapter[] {
    const adapters: DxgiAdapter[] = [];
    const out = new OutPointer();
    for (let index = 0; index < 32; index++) {
      out.reset();
      const hr = this.call(12, { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 }, index, out.ptr) as number;
      if (hr === DXGI_ERROR_NOT_FOUND) break;
      checkHresult(hr, `IDXGIFactory1.EnumAdapters1(${index})`);
      const adapterPtr = out.value;
      const desc = new NativeStruct(312);
      const raw = new ComObject(adapterPtr, `IDXGIAdapter1[${index}]`);
      const hrDesc = (raw as unknown as { call: ComObject["call"] }).call.call(
        raw,
        10,
        { args: [FFIType.ptr], returns: FFIType.i32 },
        desc.ptr,
      ) as number;
      checkHresult(hrDesc, `IDXGIAdapter1.GetDesc1(${index})`);
      const nameChars: number[] = [];
      for (let i = 0; i < 128; i++) {
        const code = desc.getU16(i * 2);
        if (code === 0) break;
        nameChars.push(code);
      }
      const vendorId = desc.getU32(256);
      const flags = desc.getU32(304);
      const dedicated = desc.getU64(272);
      const luidLow = desc.getU32(296);
      const luidHigh = desc.getI32(300);
      const info: AdapterInfo = {
        index,
        name: String.fromCharCode(...nameChars),
        vendorId,
        deviceId: desc.getU32(260),
        subSysId: desc.getU32(264),
        revision: desc.getU32(268),
        dedicatedVideoMemory: dedicated,
        dedicatedVideoMemoryMB: Number(dedicated / 1048576n),
        luidLow,
        luidHigh,
        luid: `${hex32(luidHigh).slice(2)}-${hex32(luidLow).slice(2)}`,
        flags,
        software: (flags & DXGI_ADAPTER_FLAG_SOFTWARE) !== 0,
        isNvidia: vendorId === VENDOR_NVIDIA,
      };
      adapters.push(new DxgiAdapter(adapterPtr, info));
    }
    return adapters;
  }
}

/** Pick the adapter to run on: an explicit index, else the NVIDIA GPU with the most memory. */
export function selectAdapter(adapters: DxgiAdapter[], preferredIndex?: number): DxgiAdapter | null {
  if (preferredIndex !== undefined) return adapters.find((a) => a.info.index === preferredIndex) ?? null;
  const nvidia = adapters.filter((a) => a.info.isNvidia && !a.info.software);
  nvidia.sort((a, b) => Number(b.info.dedicatedVideoMemory - a.info.dedicatedVideoMemory));
  return nvidia[0] ?? null;
}
