/**
 * NVENC hardware H.264/HEVC encode via nvEncodeAPI64.dll on a CUDA context.
 *
 * The video pipeline (video.ts / framegen.ts) currently pushes uncompressed RGBA
 * through an ffmpeg pipe, which is the throughput ceiling (8 MB/frame + two
 * swscale conversions). NVENC lets us encode on the GPU and hand ffmpeg only the
 * compressed elementary stream to mux, removing that ceiling.
 *
 * This module drives NVENC through its function-pointer table
 * (NvEncodeAPICreateInstance fills NV_ENCODE_API_FUNCTION_LIST). It reuses the
 * CUDA context created for NVOFA (src/native/cuda.ts), so encode input lives in
 * CUDA device memory (NV_ENC_INPUT_RESOURCE_TYPE_CUDADEVICEPTR).
 *
 * ABI is from the NVIDIA Video Codec SDK 13.1.15 header (nvEncodeAPI.h),
 * verified field-by-field. Natural alignment, no #pragma pack; NVENCAPI
 * (__stdcall) is a no-op on x64 so the default bun:ffi convention applies.
 * NVENCSTATUS 0 = NV_ENC_SUCCESS. 16-byte GUIDs are passed by value, which on
 * Win64 means a hidden pointer to the 16 bytes, so GUID params bind as "ptr".
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { callableAt, type Signature } from "../native/com.ts";
import { cudaCreateContext, cudaFree, cudaMalloc, cudaMemcpyHtoD } from "../native/cuda.ts";
import { copyFromNative, guid, OutU64, readCString } from "../native/memory.ts";

const OK = 0;

// -- Version macros (nvEncodeAPI.h) -----------------------------------------
// NVENCAPI_VERSION      = 13 | (1 << 24)                      = 0x0100000D
// STRUCT_VERSION(ver)   = NVENCAPI_VERSION | (ver<<16) | (7<<28)
const NVENCAPI_VERSION = 13 | (1 << 24); // 0x0100000D
const STRUCT_VERSION = (ver: number, extra = 0): number =>
  ((NVENCAPI_VERSION | (ver << 16) | (0x7 << 28)) >>> 0) | (extra >>> 0);
const V = {
  OPEN_SESSION_EX: STRUCT_VERSION(1), // 0x7101000D
  FUNCTION_LIST: STRUCT_VERSION(2), // 0x7102000D
  INITIALIZE_PARAMS: STRUCT_VERSION(7, 1 << 31), // 0xF107000D
  CONFIG: STRUCT_VERSION(9, 1 << 31), // 0xF109000D
  PRESET_CONFIG: STRUCT_VERSION(5, 1 << 31), // 0xF105000D
  PIC_PARAMS: STRUCT_VERSION(7, 1 << 31), // 0xF107000D
  LOCK_BITSTREAM: STRUCT_VERSION(2, 1 << 31), // 0xF102000D
  REGISTER_RESOURCE: STRUCT_VERSION(5), // 0x7105000D
  MAP_INPUT_RESOURCE: STRUCT_VERSION(4), // 0x7104000D
  CREATE_BITSTREAM_BUFFER: STRUCT_VERSION(1), // 0x7101000D
  CAPS_PARAM: STRUCT_VERSION(1), // 0x7101000D
} as const;

// -- GUIDs (16-byte little-endian; guid() matches the SDK's raw layout) -------
const CODEC_H264 = guid("{6BC82762-4E63-4CA4-AA85-1E50F321F6BF}");
const CODEC_HEVC = guid("{790CDC88-4522-4D7B-9425-BDA9975F7603}");
const CODEC_GUID = { h264: CODEC_H264, hevc: CODEC_HEVC } as const;
export type NvencCodec = keyof typeof CODEC_GUID;

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
export type NvencPreset = keyof typeof PRESET_GUID;

// -- Enums -------------------------------------------------------------------
const DEVICE_TYPE_CUDA = 1;
const TUNING_HIGH_QUALITY = 1;
const INPUT_RESOURCE_TYPE_CUDADEVICEPTR = 1;
const BUFFER_USAGE_INPUT_IMAGE = 0;
const BUFFER_FORMAT_ABGR = 0x10000000; // RGBA bytes in memory -> NVENC "ABGR"
const PIC_STRUCT_FRAME = 1;
const PIC_FLAG_EOS = 0x8;

/** NV_ENC_CAPS enum ordinals we query (see nvEncodeAPI.h enum _NV_ENC_CAPS). */
const CAPS = {
  WIDTH_MAX: 16,
  HEIGHT_MAX: 17,
  NUM_ENCODER_ENGINES: 49,
  SUPPORT_YUV444: 33, // NV_ENC_CAPS_SUPPORT_YUV444_ENCODE
} as const;

/** Function-pointer indices in NV_ENCODE_API_FUNCTION_LIST (declaration order). */
const FN = {
  getEncodeCaps: 7,
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

const lib = dlopen("nvEncodeAPI64.dll", {
  NvEncodeAPICreateInstance: { args: [FFIType.ptr], returns: FFIType.i32 },
  NvEncodeAPIGetMaxSupportedVersion: { args: [FFIType.ptr], returns: FFIType.i32 },
});

let fnList: bigint[] | null = null;

/** Create the NVENC instance once and cache its 43-entry function-pointer table. */
function functions(): bigint[] {
  if (fnList) return fnList;
  // NV_ENCODE_API_FUNCTION_LIST: version@0, reserved@4, 43 pointers @8.., reserved2[275]. Size 2552.
  const list = new Uint8Array(2552);
  new DataView(list.buffer).setUint32(0, V.FUNCTION_LIST, true);
  const st = lib.symbols.NvEncodeAPICreateInstance(ptr(list)) as number;
  if (st !== OK) throw new Error(`NvEncodeAPICreateInstance failed: NVENC ${statusName(st)}`);
  const dv = new DataView(list.buffer);
  const out: bigint[] = [];
  for (let i = 0; i < 43; i++) out.push(dv.getBigUint64(8 + i * 8, true));
  fnList = out;
  return out;
}

function fn(index: number, sig: Signature): (...args: unknown[]) => unknown {
  const addr = Number(functions()[index]!);
  if (addr === 0) throw new Error(`NVENC function slot ${index} is null`);
  return callableAt(addr, sig);
}

function statusName(st: number): string {
  return `${NVENC_STATUS[st] ?? "error"} (${st})`;
}

/** Driver's max supported NVENC API version, encoded (major*16 + minor)? SDK: (major<<4)|minor style via return. */
export function nvencMaxSupportedVersion(): { major: number; minor: number; raw: number } | null {
  try {
    const out = new Uint32Array(1);
    const st = lib.symbols.NvEncodeAPIGetMaxSupportedVersion(ptr(out)) as number;
    if (st !== OK) return null;
    const raw = out[0]!;
    // SDK encodes as (major<<4) | minor  (e.g. 13.1 -> (13<<4)|1 = 209).
    return { major: raw >> 4, minor: raw & 0xf, raw };
  } catch {
    return null;
  }
}

export interface NvencCaps {
  available: boolean;
  detail: string;
  driverMajor?: number;
  driverMinor?: number;
  widthMax?: number;
  heightMax?: number;
  encoderEngines?: number;
  yuv444?: boolean;
}

/**
 * Bring up NVENC on GPU `ordinal`: create the instance, open a CUDA encode
 * session, query a few H.264 caps, and tear down. Proves the whole
 * CUDA + NVENC FFI/ABI chain without encoding a frame.
 */
export function probeNvenc(ordinal = 0): NvencCaps {
  const ver = nvencMaxSupportedVersion();
  let encoder = 0n;
  try {
    const ctx = cudaCreateContext(ordinal);

    // NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS (1552B): version@0, deviceType@4,
    // device@8 (CUcontext), reserved@16, apiVersion@24.
    const open = new Uint8Array(1552);
    const odv = new DataView(open.buffer);
    odv.setUint32(0, V.OPEN_SESSION_EX, true);
    odv.setUint32(4, DEVICE_TYPE_CUDA, true);
    odv.setBigUint64(8, ctx, true);
    odv.setUint32(24, NVENCAPI_VERSION >>> 0, true);
    const encOut = new OutU64();
    const st = fn(FN.openEncodeSessionEx, { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 })(ptr(open), encOut.ptr) as number;
    if (st !== OK) return { available: false, detail: `nvEncOpenEncodeSessionEx failed: NVENC ${statusName(st)}`, driverMajor: ver?.major, driverMinor: ver?.minor };
    encoder = encOut.value;

    const getCaps = fn(FN.getEncodeCaps, { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 });
    const queryCap = (cap: number): number | undefined => {
      const param = new Uint8Array(256); // NV_ENC_CAPS_PARAM
      const pdv = new DataView(param.buffer);
      pdv.setUint32(0, V.CAPS_PARAM, true);
      pdv.setUint32(4, cap, true);
      const val = new Int32Array(1);
      const r = getCaps(encoder, ptr(CODEC_H264), ptr(param), ptr(val)) as number;
      return r === OK ? val[0]! : undefined;
    };

    const widthMax = queryCap(CAPS.WIDTH_MAX);
    const heightMax = queryCap(CAPS.HEIGHT_MAX);
    const encoderEngines = queryCap(CAPS.NUM_ENCODER_ENGINES);
    const yuv444 = queryCap(CAPS.SUPPORT_YUV444);

    return {
      available: true,
      detail: "ok",
      driverMajor: ver?.major,
      driverMinor: ver?.minor,
      widthMax,
      heightMax,
      encoderEngines,
      yuv444: yuv444 === undefined ? undefined : yuv444 !== 0,
    };
  } catch (error) {
    return { available: false, detail: (error as Error).message, driverMajor: ver?.major, driverMinor: ver?.minor };
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
  codec?: NvencCodec; // default h264
  preset?: NvencPreset; // default p4 (balanced)
  /** Constant-quality target (H.264/HEVC 0..51, lower = better). Default 20. */
  cq?: number;
  ordinal?: number;
  /**
   * Zero-copy input: register this external CUDA device pointer (e.g. a D3D12
   * shared buffer imported via cuda-interop) as the ABGR input, with `pitch`
   * bytes per row. When set, encode() is not used — call encodeGpuResident()
   * after the producer has written the frame into this buffer. The encoder does
   * not own/free the pointer.
   */
  input?: { devPtr: bigint; pitch: number };
}

/**
 * A live NVENC encoder producing an Annex-B elementary stream. Input is one
 * tightly-packed RGBA frame per call (uploaded to a CUDA buffer registered as an
 * ABGR input resource). B-frames and lookahead are disabled so encode is strictly
 * one-in-one-out in display order — each `encode()` returns exactly one frame's
 * bytes and no reordering is needed downstream.
 */
export class NvencEncoder {
  private closed = false;
  private frameIdx = 0;

  private constructor(
    private readonly enc: bigint,
    readonly width: number,
    readonly height: number,
    readonly codec: NvencCodec,
    private readonly device: bigint, // CUDA input buffer (ABGR)
    private readonly pitch: number, // bytes per row of the input buffer
    private readonly ownsDevice: boolean, // false when device is an external (shared) pointer
    private readonly registered: bigint,
    private readonly bitstream: bigint,
    private readonly api: {
      encodePicture: (...a: unknown[]) => unknown;
      lockBitstream: (...a: unknown[]) => unknown;
      unlockBitstream: (...a: unknown[]) => unknown;
      mapInput: (...a: unknown[]) => unknown;
      unmapInput: (...a: unknown[]) => unknown;
      unregister: (...a: unknown[]) => unknown;
      destroyBitstream: (...a: unknown[]) => unknown;
      destroyEncoder: (...a: unknown[]) => unknown;
      lastError: (...a: unknown[]) => unknown;
    },
    /** Kept alive because nvEncInitializeEncoder read encodeConfig from it. */
    private readonly _presetConfig: Uint8Array,
  ) {}

  static open(opts: NvencEncoderOptions): NvencEncoder {
    const width = opts.width;
    const height = opts.height;
    const codec: NvencCodec = opts.codec ?? "h264";
    const preset: NvencPreset = opts.preset ?? "p4";
    const cq = Math.max(0, Math.min(51, opts.cq ?? 20));
    const codecGuid = CODEC_GUID[codec];
    const presetGuid = PRESET_GUID[preset];
    // Zero-copy: register the caller's external pointer + pitch; else own a packed buffer.
    const pitch = opts.input?.pitch ?? width * 4;
    const ownsDevice = !opts.input;

    const ctx = cudaCreateContext(opts.ordinal ?? 0);

    // 1. Open the encode session on the CUDA context.
    const open = new Uint8Array(1552);
    const odv = new DataView(open.buffer);
    odv.setUint32(0, V.OPEN_SESSION_EX, true);
    odv.setUint32(4, DEVICE_TYPE_CUDA, true);
    odv.setBigUint64(8, ctx, true);
    odv.setUint32(24, NVENCAPI_VERSION >>> 0, true);
    const encOut = new OutU64();
    ckenc(fn(FN.openEncodeSessionEx, { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 })(ptr(open), encOut.ptr), "nvEncOpenEncodeSessionEx", 0n);
    const enc = encOut.value;

    const lastError = fn(FN.getLastErrorString, { args: [FFIType.u64], returns: FFIType.ptr });
    const check = (st: unknown, what: string): void => ckenc(st, what, enc, lastError);

    try {
      // 2. Fetch the preset config (fills a NV_ENC_CONFIG we can tweak + pass back).
      const presetConfig = new Uint8Array(5128);
      const pdv = new DataView(presetConfig.buffer);
      pdv.setUint32(0, V.PRESET_CONFIG, true);
      pdv.setUint32(8, V.CONFIG, true); // presetCfg.version
      const getPreset = fn(FN.getEncodePresetConfigEx, { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 });
      check(getPreset(enc, ptr(codecGuid), ptr(presetGuid), TUNING_HIGH_QUALITY, ptr(presetConfig)), "nvEncGetEncodePresetConfigEx");

      // Force strictly one-in-one-out: no B-frames, no lookahead, zero reorder delay.
      // Offsets are within the PRESET_CONFIG buffer (presetCfg starts at +8).
      pdv.setInt32(8 + 24, 1, true); // NV_ENC_CONFIG.frameIntervalP = 1 (IPP, no B)
      const RC_BITFIELD = 8 + 40 + 36; // presetCfg + rcParams(+40) + bitfield word(+36)
      let bits = pdv.getUint32(RC_BITFIELD, true);
      bits &= ~(1 << 5); // clear enableLookahead
      bits |= 1 << 9; // set zeroReorderDelay
      pdv.setUint32(RC_BITFIELD, bits, true);
      // Constant-quality target: targetQuality is a u8 at rcParams+88
      // (after version,rcMode,constQP,avg/max/vbv*,bitfield,min/max/initialQP,
      // temporallayerIdxMask,temporalLayerQP[8]). Rate-control mode comes from
      // the preset; targetQuality steers CQ within it.
      pdv.setUint8(8 + 40 + 88, cq); // rcParams.targetQuality

      // 3. Initialize the encoder.
      const init = new Uint8Array(1800);
      const idv = new DataView(init.buffer);
      idv.setUint32(0, V.INITIALIZE_PARAMS, true);
      init.set(codecGuid, 4); // encodeGUID
      init.set(presetGuid, 20); // presetGUID
      idv.setUint32(36, width, true);
      idv.setUint32(40, height, true);
      idv.setUint32(44, width, true); // darWidth
      idv.setUint32(48, height, true); // darHeight
      idv.setUint32(52, opts.fpsNum, true);
      idv.setUint32(56, opts.fpsDen, true);
      idv.setUint32(60, 0, true); // enableEncodeAsync = 0 (sync)
      idv.setUint32(64, 1, true); // enablePTD = 1
      idv.setBigUint64(88, BigInt(ptr(presetConfig) + 8), true); // encodeConfig = &presetCfg
      idv.setUint32(136, TUNING_HIGH_QUALITY, true);
      check(fn(FN.initializeEncoder, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 })(enc, ptr(init)), "nvEncInitializeEncoder");

      // 4. Output bitstream buffer.
      const cbb = new Uint8Array(776);
      new DataView(cbb.buffer).setUint32(0, V.CREATE_BITSTREAM_BUFFER, true);
      check(fn(FN.createBitstreamBuffer, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 })(enc, ptr(cbb)), "nvEncCreateBitstreamBuffer");
      const bitstream = new DataView(cbb.buffer).getBigUint64(16, true);

      // 5. CUDA input buffer (own a packed one, or use the caller's external
      // shared pointer) + register it as an ABGR input resource.
      const device = opts.input ? opts.input.devPtr : cudaMalloc(pitch * height);
      const reg = new Uint8Array(1536);
      const rdv = new DataView(reg.buffer);
      rdv.setUint32(0, V.REGISTER_RESOURCE, true);
      rdv.setUint32(4, INPUT_RESOURCE_TYPE_CUDADEVICEPTR, true);
      rdv.setUint32(8, width, true);
      rdv.setUint32(12, height, true);
      rdv.setUint32(16, pitch, true);
      rdv.setBigUint64(24, device, true); // resourceToRegister = CUdeviceptr
      rdv.setUint32(40, BUFFER_FORMAT_ABGR, true);
      rdv.setUint32(44, BUFFER_USAGE_INPUT_IMAGE, true);
      check(fn(FN.registerResource, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 })(enc, ptr(reg)), "nvEncRegisterResource");
      const registered = rdv.getBigUint64(32, true);

      return new NvencEncoder(enc, width, height, codec, device, pitch, ownsDevice, registered, bitstream, {
        encodePicture: fn(FN.encodePicture, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 }),
        lockBitstream: fn(FN.lockBitstream, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 }),
        unlockBitstream: fn(FN.unlockBitstream, { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 }),
        mapInput: fn(FN.mapInputResource, { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 }),
        unmapInput: fn(FN.unmapInputResource, { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 }),
        unregister: fn(FN.unregisterResource, { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 }),
        destroyBitstream: fn(FN.destroyBitstreamBuffer, { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 }),
        destroyEncoder: fn(FN.destroyEncoder, { args: [FFIType.u64], returns: FFIType.i32 }),
        lastError,
      }, presetConfig);
    } catch (error) {
      try { fn(FN.destroyEncoder, { args: [FFIType.u64], returns: FFIType.i32 })(enc); } catch { /* best effort */ }
      throw error;
    }
  }

  /** Encode one tightly-packed RGBA frame (width*height*4 bytes); returns its Annex-B bytes. */
  encode(rgba: Uint8Array): Uint8Array {
    if (this.closed) throw new Error("NvencEncoder.encode after close");
    if (!this.ownsDevice) throw new Error("NvencEncoder: this encoder uses an external input pointer; call encodeGpuResident() instead of encode()");
    const expected = this.width * this.height * 4;
    if (rgba.byteLength !== expected) throw new Error(`NVENC encode: expected ${expected} RGBA bytes, got ${rgba.byteLength}`);
    // Upload to the owned CUDA buffer (pitch = width*4, tightly packed), then encode.
    cudaMemcpyHtoD(this.device, rgba, expected);
    return this.encodeMapped();
  }

  /**
   * Encode the frame already resident in the registered input buffer — used by
   * the zero-copy path, where a D3D12 producer has written RGBA straight into the
   * shared CUDA buffer (and ordering is guaranteed by the caller, e.g. a fence
   * wait or a completed submit). No CPU upload.
   */
  encodeGpuResident(): Uint8Array {
    if (this.closed) throw new Error("NvencEncoder.encodeGpuResident after close");
    return this.encodeMapped();
  }

  /** Map the registered input, encode one picture, and read back its Annex-B bytes. */
  private encodeMapped(): Uint8Array {
    const map = new Uint8Array(1544);
    const mdv = new DataView(map.buffer);
    mdv.setUint32(0, V.MAP_INPUT_RESOURCE, true);
    mdv.setBigUint64(16, this.registered, true);
    this.check(this.api.mapInput(this.enc, ptr(map)), "nvEncMapInputResource");
    const mapped = mdv.getBigUint64(24, true);

    try {
      const pic = new Uint8Array(3360);
      const cdv = new DataView(pic.buffer);
      cdv.setUint32(0, V.PIC_PARAMS, true);
      cdv.setUint32(4, this.width, true);
      cdv.setUint32(8, this.height, true);
      cdv.setUint32(12, this.pitch, true); // inputPitch
      cdv.setUint32(20, this.frameIdx, true); // frameIdx
      cdv.setBigUint64(24, BigInt(this.frameIdx), true); // inputTimeStamp
      cdv.setBigUint64(40, mapped, true); // inputBuffer
      cdv.setBigUint64(48, this.bitstream, true); // outputBitstream
      cdv.setUint32(64, BUFFER_FORMAT_ABGR, true); // bufferFmt
      cdv.setUint32(68, PIC_STRUCT_FRAME, true); // pictureStruct
      const st = this.api.encodePicture(this.enc, ptr(pic)) as number;
      if (st === 17) throw new Error("NVENC returned NEED_MORE_INPUT unexpectedly (B-frames/lookahead should be disabled)");
      this.check(st, "nvEncEncodePicture");
      this.frameIdx++;
      return this.lockAndRead();
    } finally {
      this.check(this.api.unmapInput(this.enc, mapped), "nvEncUnmapInputResource");
    }
  }

  /** Lock the output bitstream, copy the encoded bytes out, and unlock. */
  private lockAndRead(): Uint8Array {
    const lock = new Uint8Array(1544);
    const ldv = new DataView(lock.buffer);
    ldv.setUint32(0, V.LOCK_BITSTREAM, true);
    ldv.setBigUint64(8, this.bitstream, true); // outputBitstream
    this.check(this.api.lockBitstream(this.enc, ptr(lock)), "nvEncLockBitstream");
    const size = ldv.getUint32(36, true); // bitstreamSizeInBytes
    const dataPtr = ldv.getBigUint64(56, true); // bitstreamBufferPtr
    const bytes = copyFromNative(Number(dataPtr), size);
    this.check(this.api.unlockBitstream(this.enc, this.bitstream), "nvEncUnlockBitstream");
    return bytes;
  }

  /** Flush the encoder (end of stream). No pending output with zero reorder delay. */
  finish(): Uint8Array {
    if (this.closed) return new Uint8Array(0);
    const pic = new Uint8Array(3360);
    const cdv = new DataView(pic.buffer);
    cdv.setUint32(0, V.PIC_PARAMS, true);
    cdv.setUint32(16, PIC_FLAG_EOS, true); // encodePicFlags = EOS
    // inputBuffer / outputBitstream stay NULL for an EOS flush.
    const st = this.api.encodePicture(this.enc, ptr(pic)) as number;
    if (st !== OK && st !== 17) this.check(st, "nvEncEncodePicture(EOS)");
    return new Uint8Array(0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.api.unregister(this.enc, this.registered); } catch { /* best effort */ }
    try { this.api.destroyBitstream(this.enc, this.bitstream); } catch { /* best effort */ }
    if (this.ownsDevice) { try { cudaFree(this.device); } catch { /* best effort */ } }
    try { this.api.destroyEncoder(this.enc); } catch { /* best effort */ }
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
