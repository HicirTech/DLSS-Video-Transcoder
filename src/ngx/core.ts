/**
 * The NGX core (`_nvngx.dll`, shipped inside the display driver) bound through
 * bun:ffi. Only the D3D12 entry points this project uses are wired up.
 */
import { FFIType, ptr } from "bun:ffi";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { callableAt } from "../native/com.ts";
import { NativeStruct, OutPointer, cstring, readCString, wstring } from "../native/memory.ts";
import { NativeModule } from "../native/win32.ts";
import type { ForwarderModule } from "./forwarder-runtime.ts";
import { NgxParameters } from "./params.ts";
import { NGX_ENGINE_TYPE_CUSTOM, NGX_VERSION_API, describeSupport, ngxCheck, ngxOk } from "./results.ts";

export interface NgxCoreLocation {
  path: string;
  folder: string;
  source: "system32" | "driverstore";
  modifiedAt: Date;
}

/** Find every NGX core on this machine; System32 first, then driver-store copies newest first. */
export function locateNgxCores(): NgxCoreLocation[] {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const system32 = join(systemRoot, "System32");
  const found: NgxCoreLocation[] = [];
  const direct = join(system32, "_nvngx.dll");
  if (existsSync(direct)) {
    found.push({ path: direct, folder: system32, source: "system32", modifiedAt: statSync(direct).mtime });
  }
  const repository = join(system32, "DriverStore", "FileRepository");
  if (existsSync(repository)) {
    const stores: NgxCoreLocation[] = [];
    for (const entry of readdirSync(repository)) {
      if (!/^nv.*\.inf_amd64_/i.test(entry)) continue;
      const candidate = join(repository, entry, "_nvngx.dll");
      if (existsSync(candidate)) {
        stores.push({ path: candidate, folder: join(repository, entry), source: "driverstore", modifiedAt: statSync(candidate).mtime });
      }
    }
    stores.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    found.push(...stores);
  }
  return found;
}

/** Builds NVSDK_NGX_FeatureCommonInfo (40 bytes) with a path list; keeps the backing buffers alive. */
export class FeatureCommonInfo {
  readonly struct = new NativeStruct(40);
  private readonly keep: Uint8Array[] = [];
  private readonly pathArray: NativeStruct;

  constructor(searchPaths: string[]) {
    const wide = searchPaths.map((p) => wstring(p));
    this.keep.push(...wide);
    this.pathArray = new NativeStruct(8 * Math.max(1, wide.length));
    wide.forEach((w, i) => this.pathArray.pointer(i * 8, ptr(w)));
    this.struct.pointer(0, wide.length ? this.pathArray.ptr : 0);
    this.struct.u32(8, wide.length);
    // InternalData (16) and LoggingInfo (24..40) stay zero: no app log callback.
  }

  get ptr(): number {
    return this.struct.ptr as unknown as number;
  }
}

export interface FeatureRequirementResult {
  result: number;
  supportedBits: number | null;
  support: string;
  minHwArchitecture: number | null;
  minOsVersion: string | null;
}

/**
 * There is no shutdown here on purpose: NVSDK_NGX_D3D12_Shutdown1 on this driver
 * core releases the D3D12 device it was given and leaves the process unable to
 * create another on that adapter (issue #75), and it faults outright once a
 * feature exists (sr.ts). Every caller leaves NGX to process exit and releases
 * only the objects it owns.
 */
export class NgxCore {
  private readonly module: NativeModule;
  private forwarder: ForwarderModule | null = null;
  private readonly keep: unknown[] = [];

  private constructor(
    readonly location: NgxCoreLocation,
    module: NativeModule,
  ) {
    this.module = module;
  }

  /**
   * `entry: "core"` loads `_nvngx.dll` itself. `entry: "loader"` loads the
   * driver's `nvngx.dll` next to it — the module NVIDIA's static library
   * normally talks to, which then forwards into the core.
   */
  static load(location?: NgxCoreLocation, entry: "core" | "loader" = "core"): NgxCore {
    const chosen = location ?? locateNgxCores()[0];
    if (!chosen) throw new Error("No NGX core (_nvngx.dll) found in System32 or the driver store; is an NVIDIA driver installed?");
    const path = entry === "loader" ? join(chosen.folder, "nvngx.dll") : chosen.path;
    if (!existsSync(path)) throw new Error(`${path} does not exist`);
    return new NgxCore({ ...chosen, path }, NativeModule.load(path));
  }

  address(exportName: string): number {
    return this.module.requireProc(exportName);
  }

  hasExport(exportName: string): boolean {
    return this.module.proc(exportName) !== 0;
  }

  /**
   * Route every NGX call through the generated nvngx.dll shim so the runtime's
   * caller-module check sees the trusted image name. Feature 18 and the neural
   * runtimes reject callers whose return address is in bun's JIT memory; a NULL
   * fault inside the core (or FeatureNotSupported) is the symptom without this.
   */
  useForwarder(forwarder: ForwarderModule | null): void {
    this.forwarder = forwarder;
  }

  // The forwarder's slot 0 is shared mutable state: it is re-pointed at the target
  // immediately before each call, so a ForwarderModule must not be driven from two
  // threads at once.
  private fn(name: string, args: FFIType[], returns: FFIType = FFIType.i32) {
    const address = this.address(name);
    if (!this.forwarder) return callableAt(address, { args, returns });
    const forwarder = this.forwarder;
    const stub = callableAt(forwarder.addresses.fwd_create, { args, returns });
    return (...callArgs: unknown[]) => {
      forwarder.setSlots(address, 0, 0);
      return stub(...callArgs);
    };
  }

  /**
   * NVSDK_NGX_D3D12_Init_Ext(appId, appDataPath, device, sdkVersion, featureInfo).
   * The public header names the fifth argument a parameter object, but the
   * driver dereferences it as NVSDK_NGX_FeatureCommonInfo (path list + logging),
   * and passing NULL faults inside the core. Always hand it a real struct.
   */
  initExt(device: number, appId: bigint, appDataPath: string, featureInfo: FeatureCommonInfo | null): number {
    const path = wstring(appDataPath);
    this.keep.push(path, featureInfo);
    const result = this.fn("NVSDK_NGX_D3D12_Init_Ext", [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr])(
      appId,
      path,
      device,
      NGX_VERSION_API,
      featureInfo ? featureInfo.ptr : null,
    ) as number;
    return result;
  }

  /**
   * NVSDK_NGX_D3D12_Init_ProjectID(projectId, engineType, engineVersion, appDataPath, device, sdkVersion, featureInfo).
   * Argument order follows the driver export as used by shipping NGX loaders; the
   * static-library wrapper in the public header swaps the last two. Opt-in only.
   */
  initProjectId(device: number, projectId: string, engineVersion: string, appDataPath: string, featureInfo: FeatureCommonInfo | null): number {
    const id = cstring(projectId);
    const version = cstring(engineVersion);
    const path = wstring(appDataPath);
    this.keep.push(id, version, path, featureInfo);
    const result = this.fn("NVSDK_NGX_D3D12_Init_ProjectID", [
      FFIType.ptr,
      FFIType.i32,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.i32,
      FFIType.ptr,
    ])(id, NGX_ENGINE_TYPE_CUSTOM, version, path, device, NGX_VERSION_API, featureInfo ? featureInfo.ptr : null) as number;
    return result;
  }

  /** Init_Ext with an arbitrary fifth argument (used with the spy parameter object). */
  initExtRaw(device: number, appId: bigint, appDataPath: string, fifth: number): number {
    const path = wstring(appDataPath);
    this.keep.push(path);
    const result = this.fn("NVSDK_NGX_D3D12_Init_Ext", [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr])(
      appId,
      path,
      device,
      NGX_VERSION_API,
      fifth === 0 ? null : fifth,
    ) as number;
    return result;
  }

  /** The four-argument NVSDK_NGX_D3D12_Init(appId, appDataPath, device, sdkVersion) export. */
  initPlain(device: number, appId: bigint, appDataPath: string): number {
    const path = wstring(appDataPath);
    this.keep.push(path);
    const result = this.fn("NVSDK_NGX_D3D12_Init", [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.i32])(appId, path, device, NGX_VERSION_API) as number;
    return result;
  }

  capabilityParameters(): NgxParameters {
    const out = new OutPointer();
    ngxCheck(this.fn("NVSDK_NGX_D3D12_GetCapabilityParameters", [FFIType.ptr])(out.ptr) as number, "GetCapabilityParameters");
    return new NgxParameters(out.value, "capability");
  }

  allocateParameters(): NgxParameters {
    const out = new OutPointer();
    ngxCheck(this.fn("NVSDK_NGX_D3D12_AllocateParameters", [FFIType.ptr])(out.ptr) as number, "AllocateParameters");
    return new NgxParameters(out.value, "allocated");
  }

  destroyParameters(params: NgxParameters): void {
    if (params.origin !== "allocated") return;
    this.fn("NVSDK_NGX_D3D12_DestroyParameters", [FFIType.ptr])(params.ptr);
  }

  /** Static capability query; does not require Init. */
  featureRequirements(adapter: number, featureId: number, appId: bigint, appDataPath: string, featureInfo: FeatureCommonInfo | null): FeatureRequirementResult {
    const path = wstring(appDataPath);
    // NVSDK_NGX_FeatureDiscoveryInfo: SDKVersion, FeatureID, Identifier{type, union}, ApplicationDataPath, FeatureInfo
    const info = new NativeStruct(56);
    info.u32(0, NGX_VERSION_API);
    info.u32(4, featureId);
    info.u32(8, 0); // NVSDK_NGX_Application_Identifier_Type_Application_Id
    info.u64(16, appId);
    info.pointer(40, ptr(path));
    info.pointer(48, featureInfo ? featureInfo.ptr : 0);
    const out = new NativeStruct(264);
    const result = this.fn("NVSDK_NGX_D3D12_GetFeatureRequirements", [FFIType.ptr, FFIType.ptr, FFIType.ptr])(adapter, info.ptr, out.ptr) as number;
    if (!ngxOk(result)) {
      return { result, supportedBits: null, support: "query failed", minHwArchitecture: null, minOsVersion: null };
    }
    const bits = out.getU32(0);
    const minOs = readCString(out.ptr as unknown as number + 8, 255);
    return {
      result,
      supportedBits: bits,
      support: describeSupport(bits),
      minHwArchitecture: out.getU32(4),
      minOsVersion: minOs.length ? minOs : null,
    };
  }

  createFeature(cmdList: number, featureId: number, params: { readonly ptr: number }): { result: number; handle: number } {
    const out = new OutPointer();
    const result = this.fn("NVSDK_NGX_D3D12_CreateFeature", [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr])(cmdList, featureId, params.ptr, out.ptr) as number;
    return { result, handle: out.value };
  }

  evaluateFeature(cmdList: number, handle: number, params: { readonly ptr: number }): number {
    return this.fn("NVSDK_NGX_D3D12_EvaluateFeature", [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr])(cmdList, handle, params.ptr, null) as number;
  }

  releaseFeature(handle: number): number {
    return this.fn("NVSDK_NGX_D3D12_ReleaseFeature", [FFIType.ptr])(handle) as number;
  }
}
