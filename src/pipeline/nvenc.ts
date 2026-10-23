/**
 * NVENC hardware H.264/HEVC encode via nvEncodeAPI64.dll, driven through the
 * function-pointer table NvEncodeAPICreateInstance fills
 * (NV_ENCODE_API_FUNCTION_LIST). Sessions run on the CUDA context shared with
 * NVOFA (src/native/cuda.ts), so input frames live in CUDA device memory
 * (NV_ENC_INPUT_RESOURCE_TYPE_CUDADEVICEPTR) and the output is an Annex-B
 * elementary stream the caller only has to mux. The DLL is loaded on first use
 * rather than at import, so probeNvencCaps reports a missing one as unavailable
 * and importers that only need NVENC_PRESET need no driver.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { callableAt, type OwnedCallable, type Signature } from "../native/com.ts";
import { cudaCreateContext, cudaFree, cudaMalloc, cudaMemcpyHtoD } from "../native/cuda.ts";
import { copyFromNative, guid, OutU64, readCString } from "../native/memory.ts";
import { clampToRange } from "../server/api-types.ts";

const OK = 0;
const INVALID_VERSION = 15; // NV_ENC_ERR_INVALID_VERSION in NVENCSTATUS, nvEncodeAPI.h (SDK 13.1.15)
const NEED_MORE_INPUT = 17; // NV_ENC_ERR_NEED_MORE_INPUT in NVENCSTATUS, nvEncodeAPI.h (SDK 13.1.15)

// -- ABI and version macros --------------------------------------------------
// ABI from the NVIDIA Video Codec SDK 13.1.15 header (nvEncodeAPI.h): natural
// alignment, no #pragma pack; NVENCAPI (__stdcall) is a no-op on x64, so the
// default bun:ffi convention applies. NVENCSTATUS 0 = NV_ENC_SUCCESS.
// Transcribed from nvEncodeAPI.h: NVENCAPI_VERSION = NVENCAPI_MAJOR_VERSION |
// (NVENCAPI_MINOR_VERSION << 24), and NVENCAPI_STRUCT_VERSION(ver) =
// NVENCAPI_VERSION | (ver << 16) | (0x7 << 28). `extra` carries the
// `| (1u << 31)` that some *_VER macros append.
const NVENCAPI_MAJOR_VERSION = 13;
const NVENCAPI_MINOR_VERSION = 1;
const NVENCAPI_VERSION = NVENCAPI_MAJOR_VERSION | (NVENCAPI_MINOR_VERSION << 24);
const STRUCT_VERSION = (ver: number, extra = 0): number =>
  ((NVENCAPI_VERSION | (ver << 16) | (0x7 << 28)) >>> 0) | (extra >>> 0);
const STRUCT_VER = {
  OPEN_SESSION_EX: STRUCT_VERSION(1),
  FUNCTION_LIST: STRUCT_VERSION(2),
  INITIALIZE_PARAMS: STRUCT_VERSION(7, 1 << 31),
  CONFIG: STRUCT_VERSION(9, 1 << 31),
  PRESET_CONFIG: STRUCT_VERSION(5, 1 << 31),
  PIC_PARAMS: STRUCT_VERSION(7, 1 << 31),
  LOCK_BITSTREAM: STRUCT_VERSION(2, 1 << 31),
  REGISTER_RESOURCE: STRUCT_VERSION(5),
  MAP_INPUT_RESOURCE: STRUCT_VERSION(4),
  CREATE_BITSTREAM_BUFFER: STRUCT_VERSION(1),
} as const;

// -- GUIDs (16-byte little-endian; guid() matches the SDK's raw layout) -------
const CODEC_H264 = guid("{6BC82762-4E63-4CA4-AA85-1E50F321F6BF}");
const CODEC_HEVC = guid("{790CDC88-4522-4D7B-9425-BDA9975F7603}");
const CODEC_GUID = { h264: CODEC_H264, hevc: CODEC_HEVC } as const;
/**
 * The codecs the in-process NVENC SDK can open. A different set from ffmpeg's
 * encoder names in encode-select.ts: "h264" here is "h264_nvenc" there.
 */
export type NvencSdkCodec = keyof typeof CODEC_GUID;

/** P1 (fastest) .. P7 (slowest / best quality). */
const PRESET_GUID = {
  p1: guid("{FC0A8D3E-45F8-4CF8-80C7-298871590EBF}"),
  p2: guid("{F581CFB8-88D6-4381-93F0-DF13F9C27DAB}"),
  p3: guid("{36850110-3A07-441F-94D5-3670631F91F6}"),
  p4: guid("{90A7B826-DF06-4862-B9D2-CD6D73A08681}"),
  p5: guid("{21C6E6B4-297A-4CBA-998F-B6CBDE72ADE3}"),
  p6: guid("{8E75C279-6299-4AB6-8302-0B215A335CF5}"),
  p7: guid("{84848C12-6F71-4C13-931B-53E283F57974}"),
} as const;
type NvencPreset = keyof typeof PRESET_GUID;
/** The preset every NVENC encode here runs with, in process (NvencEncoder) and through ffmpeg's -preset alike. */
export const NVENC_PRESET = "p5" satisfies NvencPreset;

// -- Enums -------------------------------------------------------------------
const DEVICE_TYPE_CUDA = 1;
const TUNING_HIGH_QUALITY = 1;
const INPUT_RESOURCE_TYPE_CUDADEVICEPTR = 1;
const BUFFER_USAGE_INPUT_IMAGE = 0;
const BUFFER_FORMAT_ABGR = 0x10000000; // RGBA bytes in memory -> NVENC "ABGR"
const PIC_STRUCT_FRAME = 1;
const PIC_FLAG_EOS = 0x8;

/** Function-pointer indices in NV_ENCODE_API_FUNCTION_LIST (declaration order). */
const FN = {
  initializeEncoder: 11,
  createBitstreamBuffer: 14,
  destroyBitstreamBuffer: 15,
  encodePicture: 16,
  lockBitstream: 17,
  unlockBitstream: 18,
  getSequenceParams: 22,
  mapInputResource: 25,
  unmapInputResource: 26,
  destroyEncoder: 27,
  openEncodeSessionEx: 29,
  registerResource: 30,
  unregisterResource: 31,
  getLastErrorString: 37,
  getEncodePresetConfigEx: 39,
} as const;

const NVENC_STATUS: Record<number, string> = {
  0: "SUCCESS", 1: "NO_ENCODE_DEVICE", 2: "UNSUPPORTED_DEVICE", 3: "INVALID_ENCODERDEVICE",
  4: "INVALID_DEVICE", 5: "DEVICE_NOT_EXIST", 6: "INVALID_PTR", 8: "INVALID_PARAM",
  9: "INVALID_CALL", 10: "OUT_OF_MEMORY", 11: "ENCODER_NOT_INITIALIZED", 12: "UNSUPPORTED_PARAM",
  13: "LOCK_BUSY", 14: "NOT_ENOUGH_BUFFER", 15: "INVALID_VERSION", 16: "MAP_FAILED",
  17: "NEED_MORE_INPUT", 18: "ENCODER_BUSY", 20: "GENERIC", 22: "UNIMPLEMENTED",
  23: "RESOURCE_REGISTER_FAILED", 24: "RESOURCE_NOT_REGISTERED", 25: "RESOURCE_NOT_MAPPED",
};

function load() {
  return dlopen("nvEncodeAPI64.dll", {
    NvEncodeAPICreateInstance: { args: [FFIType.ptr], returns: FFIType.i32 },
    NvEncodeAPIGetMaxSupportedVersion: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
}

let lib: ReturnType<typeof load> | null = null;

/** The DLL's entry points, loaded on first use; throws the dlopen error when NVENC is not installed. */
function nvencSymbols(): ReturnType<typeof load>["symbols"] {
  lib ??= load();
  return lib.symbols;
}

let fnList: bigint[] | null = null;

/** Create the NVENC instance once and cache its 43-entry function-pointer table. */
function functions(): bigint[] {
  if (fnList) return fnList;
  // NV_ENCODE_API_FUNCTION_LIST: version@0, reserved@4, 43 pointers @8.., reserved2[275]. Size 2552.
  const list = new Uint8Array(2552);
  new DataView(list.buffer).setUint32(0, STRUCT_VER.FUNCTION_LIST, true);
  const st = nvencSymbols().NvEncodeAPICreateInstance(list) as number;
  if (st !== OK) throw new Error(`NvEncodeAPICreateInstance failed: NVENC ${statusName(st)}`);
  const dv = new DataView(list.buffer);
  const out: bigint[] = [];
  for (let i = 0; i < 43; i++) out.push(dv.getBigUint64(8 + i * 8, true));
  fnList = out;
  return out;
}

function fn(index: number, sig: Signature): OwnedCallable {
  const addr = Number(functions()[index]!);
  if (addr === 0) throw new Error(`NVENC function slot ${index} is null`);
  return callableAt(addr, sig);
}

function statusName(st: number): string {
  return `${NVENC_STATUS[st] ?? "error"} (${st})`;
}

/**
 * nvEncOpenEncodeSessionEx on a CUDA context. Returns the raw status, because the probe turns a
 * failure into a report and the encoder into an exception.
 */
function openEncodeSession(context: bigint): { status: number; session: bigint } {
  // NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS (1552B): version@0, deviceType@4,
  // device@8 (CUcontext), reserved@16, apiVersion@24.
  const params = new Uint8Array(1552);
  const view = new DataView(params.buffer);
  view.setUint32(0, STRUCT_VER.OPEN_SESSION_EX, true);
  view.setUint32(4, DEVICE_TYPE_CUDA, true);
  view.setBigUint64(8, context, true);
  view.setUint32(24, NVENCAPI_VERSION >>> 0, true);
  const sessionOut = new OutU64();
  const status = fn(FN.openEncodeSessionEx, { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 })(params, sessionOut.bytes) as number;
  return { status, session: sessionOut.value };
}

/**
 * Highest NVENC API version the installed driver supports, or null if the driver
 * refuses the query. The DLL returns it packed as (major << 4) | minor, so 13.1
 * comes back as 209.
 */
function nvencMaxSupportedVersion(): { major: number; minor: number } | null {
  try {
    const out = new Uint32Array(1);
    const st = nvencSymbols().NvEncodeAPIGetMaxSupportedVersion(out) as number;
    if (st !== OK) return null;
    const raw = out[0]!;
    return { major: raw >> 4, minor: raw & 0xf };
  } catch {
    return null;
  }
}

/** The way out of NV_ENC_ERR_INVALID_VERSION: the driver speaks an older NVENC API than this build. */
function driverVersionHint(): string {
  const supported = nvencMaxSupportedVersion();
  return `; this build needs NVENC API ${NVENCAPI_MAJOR_VERSION}.${NVENCAPI_MINOR_VERSION} and the driver supports ${supported ? `${supported.major}.${supported.minor}` : "an unknown version"}: update the NVIDIA driver`;
}

/** Whether NVENC opened on a device, and why not when it did not. */
export type NvencCaps = { available: true } | { available: false; detail: string };

/**
 * Bring up NVENC on CUDA device `ordinal`: create the instance, open a CUDA
 * encode session and destroy it again, which proves the whole CUDA + NVENC
 * FFI/ABI chain without encoding a frame. The primary context it retains stays
 * pushed on this thread, so call it only on a thread that ends with its job (a
 * job worker, an encode worker or the CLI); see cudaReleaseContext.
 */
export function probeNvencCaps(ordinal: number): NvencCaps {
  let encoder = 0n;
  try {
    const opened = openEncodeSession(cudaCreateContext(ordinal));
    if (opened.status !== OK) return { available: false, detail: `nvEncOpenEncodeSessionEx failed: NVENC ${statusName(opened.status)}${opened.status === INVALID_VERSION ? driverVersionHint() : ""}` };
    encoder = opened.session;
    return { available: true };
  } catch (error) {
    return { available: false, detail: (error as Error).message };
  } finally {
    if (encoder !== 0n) {
      try { fn(FN.destroyEncoder, { args: [FFIType.u64], returns: FFIType.i32 })(encoder); } catch { /* best effort */ }
    }
  }
}

// -- Encoder -----------------------------------------------------------------

export interface NvencEncoderOptions {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  codec?: NvencSdkCodec; // default h264
  /** Constant-quality target, lower = better; held inside SETTING_RANGES.quality. Default 20. */
  cq?: number;
  /** CUDA device to encode on: the renderer's, resolved by LUID (GpuSession.cudaOrdinal), never a guess. */
  ordinal: number;
  /**
   * Zero-copy input pool: external CUDA device pointers (e.g. D3D12 shared
   * buffers imported via cuda-interop) registered as ABGR inputs, `pitch` bytes
   * per row. The caller owns and frees them; the encoder only registers them.
   * When set, callers use encodeGpuResident(i) instead of encode(); a pool
   * larger than one lets the producer run ahead of the encoder.
   */
  inputs?: { devPtr: bigint; pitch: number }[];
}

/** An NVENC call's status checked against one encode session, naming the call in the error. */
type CheckStatus = (status: unknown, what: string) => void;

/**
 * The preset's NV_ENC_CONFIG, tweaked to strictly one frame in and one frame out at constant quality `cq`. Returns the
 * whole NV_ENC_PRESET_CONFIG, which the caller keeps alive: nvEncInitializeEncoder reads the config inside it.
 */
function presetConfigFor(enc: bigint, check: CheckStatus, { codecGuid, presetGuid, cq }: { codecGuid: Uint8Array; presetGuid: Uint8Array; cq: number }): Uint8Array {
  // NV_ENC_PRESET_CONFIG (5128B): version@0, then the NV_ENC_CONFIG the
  // driver fills at +8, which we tweak below and hand back to init.
  const presetConfig = new Uint8Array(5128);
  const presetView = new DataView(presetConfig.buffer);
  presetView.setUint32(0, STRUCT_VER.PRESET_CONFIG, true);
  presetView.setUint32(8, STRUCT_VER.CONFIG, true); // presetCfg.version
  // The GUIDs go by value; a 16-byte struct passed by value is a hidden pointer on Win64, so they bind as ptr.
  const getPreset = fn(FN.getEncodePresetConfigEx, { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 });
  check(getPreset(enc, codecGuid, presetGuid, TUNING_HIGH_QUALITY, presetConfig), "nvEncGetEncodePresetConfigEx");

  // Force strictly one-in-one-out, which the class contract depends on.
  // Offsets are into the NV_ENC_CONFIG at presetConfig+8.
  presetView.setInt32(8 + 24, 1, true); // NV_ENC_CONFIG.frameIntervalP = 1 (IPP, no B)
  const RC_BITFIELD = 8 + 40 + 36; // config + rcParams(+40) + its bitfield word(+36)
  let bits = presetView.getUint32(RC_BITFIELD, true);
  bits &= ~(1 << 5); // clear enableLookahead
  bits |= 1 << 9; // set zeroReorderDelay
  presetView.setUint32(RC_BITFIELD, bits, true);
  // targetQuality is a u8 at rcParams+88 (after version, rcMode, constQP,
  // avg/max/vbv*, bitfield, min/max/initialQP, temporallayerIdxMask,
  // temporalLayerQP[8]). The preset picks the rate-control mode; this only
  // steers the CQ target within it.
  presetView.setUint8(8 + 40 + 88, cq);
  return presetConfig;
}

/** What nvEncInitializeEncoder is told: the codec and preset, the frame size and rate, and the tweaked preset config. */
interface EncoderSettings {
  codecGuid: Uint8Array;
  presetGuid: Uint8Array;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  presetConfig: Uint8Array;
}

function initializeEncoder(enc: bigint, check: CheckStatus, settings: EncoderSettings): void {
  // NV_ENC_INITIALIZE_PARAMS (1800B); offsets below name its fields.
  const init = new Uint8Array(1800);
  const initView = new DataView(init.buffer);
  initView.setUint32(0, STRUCT_VER.INITIALIZE_PARAMS, true);
  init.set(settings.codecGuid, 4); // encodeGUID
  init.set(settings.presetGuid, 20); // presetGUID
  initView.setUint32(36, settings.width, true); // encodeWidth
  initView.setUint32(40, settings.height, true); // encodeHeight
  initView.setUint32(44, settings.width, true); // darWidth
  initView.setUint32(48, settings.height, true); // darHeight
  initView.setUint32(52, settings.fpsNum, true); // frameRateNum
  initView.setUint32(56, settings.fpsDen, true); // frameRateDen
  initView.setUint32(60, 0, true); // enableEncodeAsync = 0: blocking encodePicture, no event handles
  initView.setUint32(64, 1, true); // enablePTD = 1: driver decides picture type
  initView.setBigUint64(88, BigInt(ptr(settings.presetConfig) + 8), true); // encodeConfig -> the tweaked NV_ENC_CONFIG
  initView.setUint32(136, TUNING_HIGH_QUALITY, true); // tuningInfo
  check(fn(FN.initializeEncoder, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 })(enc, init), "nvEncInitializeEncoder");
}

/** nvEncCreateBitstreamBuffer; returns the buffer's handle. */
function createBitstreamBuffer(enc: bigint, check: CheckStatus): bigint {
  // NV_ENC_CREATE_BITSTREAM_BUFFER: the handle lands at +16.
  const createBitstreamParams = new Uint8Array(776);
  const view = new DataView(createBitstreamParams.buffer);
  view.setUint32(0, STRUCT_VER.CREATE_BITSTREAM_BUFFER, true);
  check(fn(FN.createBitstreamBuffer, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 })(enc, createBitstreamParams), "nvEncCreateBitstreamBuffer");
  return view.getBigUint64(16, true);
}

/** Registers CUDA device pointer `devPtr` as an ABGR input image of `pitch` bytes per row; returns the registered resource. */
function registerInput(enc: bigint, check: CheckStatus, { devPtr, width, height, pitch }: { devPtr: bigint; width: number; height: number; pitch: number }): bigint {
  const reg = new Uint8Array(1536);
  const registerView = new DataView(reg.buffer);
  registerView.setUint32(0, STRUCT_VER.REGISTER_RESOURCE, true);
  registerView.setUint32(4, INPUT_RESOURCE_TYPE_CUDADEVICEPTR, true);
  registerView.setUint32(8, width, true);
  registerView.setUint32(12, height, true);
  registerView.setUint32(16, pitch, true);
  registerView.setBigUint64(24, devPtr, true); // resourceToRegister = CUdeviceptr
  registerView.setUint32(40, BUFFER_FORMAT_ABGR, true);
  registerView.setUint32(44, BUFFER_USAGE_INPUT_IMAGE, true);
  check(fn(FN.registerResource, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 })(enc, reg), "nvEncRegisterResource");
  return registerView.getBigUint64(32, true); // registeredResource, written by the driver
}

/** What an encode session holds; a zero handle or an empty list is a part it never got. */
interface EncoderParts {
  enc: bigint;
  registeredList: bigint[];
  bitstream: bigint;
  /** The CUDA input buffer the encoder allocated itself, or 0n for an external pool, which its owner frees. */
  ownedDevice: bigint;
}

/** Releases a session's parts, newest first; each step is best effort so one failure does not leak the rest. */
function releaseEncoderParts({ enc, registeredList, bitstream, ownedDevice }: EncoderParts): void {
  for (const registered of registeredList) {
    try { fn(FN.unregisterResource, { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 })(enc, registered); } catch { /* best effort */ }
  }
  if (bitstream !== 0n) {
    try { fn(FN.destroyBitstreamBuffer, { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 })(enc, bitstream); } catch { /* best effort */ }
  }
  if (ownedDevice !== 0n) {
    try { cudaFree(ownedDevice); } catch { /* best effort */ }
  }
  try { fn(FN.destroyEncoder, { args: [FFIType.u64], returns: FFIType.i32 })(enc); } catch { /* best effort */ }
}

/**
 * A live NVENC encoder producing an Annex-B elementary stream, one RGBA frame in
 * and one frame's bytes out. B-frames and lookahead are disabled in open(), so
 * output stays in display order and nothing downstream has to reorder.
 */
export class NvencEncoder {
  private closed = false;
  private frameIdx = 0;

  private constructor(
    private readonly enc: bigint,
    readonly width: number,
    readonly height: number,
    private readonly device: bigint, // owned CUDA input buffer (0n when using external pool)
    private readonly pitch: number, // bytes per row of each input buffer
    private readonly ownsDevice: boolean, // false when inputs are external (shared) pointers
    private readonly registeredList: bigint[], // one registered resource per input pool slot
    private readonly bitstream: bigint,
    private readonly api: {
      encodePicture: OwnedCallable;
      lockBitstream: OwnedCallable;
      unlockBitstream: OwnedCallable;
      mapInput: OwnedCallable;
      unmapInput: OwnedCallable;
      lastError: OwnedCallable;
    },
    /** Kept alive because nvEncInitializeEncoder read encodeConfig from it. */
    private readonly _presetConfig: Uint8Array,
  ) {}

  static open(opts: NvencEncoderOptions): NvencEncoder {
    const width = opts.width;
    const height = opts.height;
    const codec: NvencSdkCodec = opts.codec ?? "h264";
    const cq = clampToRange("quality", opts.cq ?? 20);
    const codecGuid = CODEC_GUID[codec];
    const presetGuid = PRESET_GUID[NVENC_PRESET];
    // An external pool dictates its own pitch; an owned buffer is tightly packed.
    const pitch = opts.inputs?.[0]?.pitch ?? width * 4;
    const ownsDevice = !opts.inputs;

    const opened = openEncodeSession(cudaCreateContext(opts.ordinal));
    ckenc(opened.status, "nvEncOpenEncodeSessionEx", 0n);
    const enc = opened.session;

    const lastError = fn(FN.getLastErrorString, { args: [FFIType.u64], returns: FFIType.ptr });
    const check = (st: unknown, what: string): void => ckenc(st, what, enc, lastError);

    // Out here so the failure path can release them: any step below can throw
    // after an earlier one succeeded, and destroyEncoder does not own the CUDA buffer.
    let device = 0n;
    let bitstream = 0n;
    const registeredList: bigint[] = [];

    try {
      const presetConfig = presetConfigFor(enc, check, { codecGuid, presetGuid, cq });
      initializeEncoder(enc, check, { codecGuid, presetGuid, width, height, fpsNum: opts.fpsNum, fpsDen: opts.fpsDen, presetConfig });
      bitstream = createBitstreamBuffer(enc, check);

      // Either one CUDA buffer this encoder owns, or the caller's shared pool;
      // every pointer is registered as an ABGR input resource either way.
      if (!opts.inputs) device = cudaMalloc(pitch * height);
      const devPtrs = opts.inputs ? opts.inputs.map((input) => input.devPtr) : [device];
      for (const devPtr of devPtrs) registeredList.push(registerInput(enc, check, { devPtr, width, height, pitch }));

      return new NvencEncoder(enc, width, height, device, pitch, ownsDevice, registeredList, bitstream, {
        encodePicture: fn(FN.encodePicture, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 }),
        lockBitstream: fn(FN.lockBitstream, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 }),
        unlockBitstream: fn(FN.unlockBitstream, { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 }),
        mapInput: fn(FN.mapInputResource, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 }),
        unmapInput: fn(FN.unmapInputResource, { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 }),
        lastError,
      }, presetConfig);
    } catch (error) {
      releaseEncoderParts({ enc, registeredList, bitstream, ownedDevice: device });
      throw error;
    }
  }

  /** Encode one tightly-packed RGBA frame (width*height*4 bytes); returns its Annex-B bytes. */
  encode(rgba: Uint8Array): Uint8Array {
    if (this.closed) throw new Error("NvencEncoder.encode after close");
    if (!this.ownsDevice) throw new Error("NvencEncoder: this encoder uses an external input pointer; call encodeGpuResident() instead of encode()");
    const expected = this.width * this.height * 4;
    if (rgba.byteLength !== expected) throw new Error(`NVENC encode: expected ${expected} RGBA bytes, got ${rgba.byteLength}`);
    cudaMemcpyHtoD(this.device, rgba, expected);
    return this.encodeMapped(this.registeredList[0]!);
  }

  /**
   * Encode the frame already sitting in input pool slot `slot`, with no CPU
   * upload. The caller must have made the producer's write visible first (a
   * completed D3D12 submit or a fence wait); this does not synchronise.
   */
  encodeGpuResident(slot = 0): Uint8Array {
    if (this.closed) throw new Error("NvencEncoder.encodeGpuResident after close");
    const registered = this.registeredList[slot];
    if (registered === undefined) throw new Error(`NvencEncoder: input pool slot ${slot} out of range (pool size ${this.registeredList.length})`);
    return this.encodeMapped(registered);
  }

  private encodeMapped(registered: bigint): Uint8Array {
    // NV_ENC_MAP_INPUT_RESOURCE: registeredResource in at +16, mappedResource out at +24.
    const map = new Uint8Array(1544);
    const mdv = new DataView(map.buffer);
    mdv.setUint32(0, STRUCT_VER.MAP_INPUT_RESOURCE, true);
    mdv.setBigUint64(16, registered, true);
    this.check(this.api.mapInput(this.enc, map), "nvEncMapInputResource");
    const mapped = mdv.getBigUint64(24, true);

    let encoded = false;
    try {
      // NV_ENC_PIC_PARAMS (3360B); offsets below name its fields.
      const pic = new Uint8Array(3360);
      const cdv = new DataView(pic.buffer);
      cdv.setUint32(0, STRUCT_VER.PIC_PARAMS, true);
      cdv.setUint32(4, this.width, true); // inputWidth
      cdv.setUint32(8, this.height, true); // inputHeight
      cdv.setUint32(12, this.pitch, true); // inputPitch
      cdv.setUint32(20, this.frameIdx, true); // frameIdx
      cdv.setBigUint64(24, BigInt(this.frameIdx), true); // inputTimeStamp
      cdv.setBigUint64(40, mapped, true); // inputBuffer
      cdv.setBigUint64(48, this.bitstream, true); // outputBitstream
      cdv.setUint32(64, BUFFER_FORMAT_ABGR, true); // bufferFmt
      cdv.setUint32(68, PIC_STRUCT_FRAME, true); // pictureStruct
      const st = this.api.encodePicture(this.enc, pic) as number;
      if (st === 17) throw new Error("NVENC returned NEED_MORE_INPUT unexpectedly (B-frames/lookahead should be disabled)");
      this.check(st, "nvEncEncodePicture");
      this.frameIdx++;
      const bytes = this.lockAndRead();
      encoded = true;
      return bytes;
    } finally {
      // Always unmapped, but a failed unmap is reported only when it is the first failure, not over the one before it.
      const unmapped = this.api.unmapInput(this.enc, mapped);
      if (encoded) this.check(unmapped, "nvEncUnmapInputResource");
    }
  }

  /** Copies out of the driver's mapping: the returned bytes outlive the unlock. */
  private lockAndRead(): Uint8Array {
    const lock = new Uint8Array(1544);
    const ldv = new DataView(lock.buffer);
    ldv.setUint32(0, STRUCT_VER.LOCK_BITSTREAM, true);
    ldv.setBigUint64(8, this.bitstream, true); // outputBitstream
    this.check(this.api.lockBitstream(this.enc, lock), "nvEncLockBitstream");
    const size = ldv.getUint32(36, true); // bitstreamSizeInBytes
    const dataPtr = ldv.getBigUint64(56, true); // bitstreamBufferPtr
    const bytes = copyFromNative(Number(dataPtr), size);
    this.check(this.api.unlockBitstream(this.enc, this.bitstream), "nvEncUnlockBitstream");
    return bytes;
  }

  /**
   * Signal end of stream. Always returns empty: with zeroReorderDelay set in
   * open() the encoder never holds a frame back, so there is nothing to drain.
   */
  finish(): Uint8Array {
    if (this.closed) return new Uint8Array(0);
    const pic = new Uint8Array(3360);
    const cdv = new DataView(pic.buffer);
    cdv.setUint32(0, STRUCT_VER.PIC_PARAMS, true);
    cdv.setUint32(16, PIC_FLAG_EOS, true); // encodePicFlags = EOS
    // inputBuffer / outputBitstream stay NULL for an EOS flush.
    const st = this.api.encodePicture(this.enc, pic) as number;
    if (st !== OK && st !== 17) this.check(st, "nvEncEncodePicture(EOS)");
    return new Uint8Array(0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    releaseEncoderParts({ enc: this.enc, registeredList: this.registeredList, bitstream: this.bitstream, ownedDevice: this.device });
  }

  private check(st: unknown, what: string): void {
    ckenc(st, what, this.enc, this.api.lastError);
  }
}

function ckenc(st: unknown, what: string, enc: bigint, lastError?: (...a: unknown[]) => unknown): void {
  if ((st as number) === OK) return;
  let extra = "";
  if (enc !== 0n && lastError) {
    try {
      const p = lastError(enc) as number | bigint;
      const msg = readCString(Number(p));
      if (msg) extra = ` — ${msg}`;
    } catch { /* ignore */ }
  }
  throw new Error(`NVENC ${what} failed: ${statusName(st as number)}${extra}`);
}
