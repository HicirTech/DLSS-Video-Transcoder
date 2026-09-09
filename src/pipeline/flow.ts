/**
 * Optical-flow motion vectors for the DLSS / DLSSG / DLSSNR motion-vector
 * contract, ported from the reference DIS generator (dref guides.py).
 *
 * Output unit and convention, which `FrameInput.motion` (engine.ts) already
 * expects so the engine only packs to R16G16_FLOAT with MV.Scale = 1.0: a
 * backward per-pixel field in RENDER-RESOLUTION PIXELS, interleaved (x, y),
 * origin top-left, +x right, +y down, no y flip. DIS sign convention:
 * `calc(current, previous)` maps current -> previous, `MV[p] = prevPos - curPos`.
 *
 * OpenCV is unavailable in Bun, so the producer is a pure-TS block matcher on a
 * downscaled gray grid (guides.py:24-55). The ffmpeg path is a seam, not a
 * producer: ffmpeg only exposes block-granular codec vectors, never dense flow.
 * Everything here is GPU-free, so it is unit-testable without a GPU.
 */

// -- Reference reset/duplicate thresholds (guides.py DLSSGGuideGenerator) ------

/** Scene score above this forces a temporal reset (guides.py:45). */
export const RESET_SCENE_SCORE = 0.24;
/** Scene score below this is a duplicate frame: emit zero motion (guides.py:44). */
export const DUPLICATE_SCENE_SCORE = 0.0005;
/** Finite-vector fraction below this forces a reset (guides.py:63). */
export const RESET_CONFIDENCE = 0.98;
/** Default long-side resolution the flow is computed at (guides.py:21). */
export const DEFAULT_FLOW_WIDTH = 640;

// -- float32 -> float16 (IEEE-754 half) ---------------------------------------

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Float16Array when the runtime provides it — Bun 1.4 does — otherwise null. */
interface HalfArray {
  set(values: ArrayLike<number>, offset?: number): void;
}
const HALF_ARRAY = (globalThis as unknown as { Float16Array?: new (buffer: ArrayBufferLike) => HalfArray }).Float16Array ?? null;

/**
 * Encode one float32 as an IEEE-754 half (Uint16): normals, subnormals, signed
 * zero, overflow -> Inf and NaN, rounding the mantissa to nearest-even as
 * R16G16_FLOAT does.
 */
export function floatToHalf(value: number): number {
  f32[0] = value;
  return bitsToHalf(u32[0]!);
}

/**
 * floatToHalf on the raw IEEE-754 bits of a float32, so a whole buffer can be
 * converted through a Uint32Array view with integer ops only instead of one
 * scalar store/load per element.
 */
export function bitsToHalf(x: number): number {
  const sign = (x >>> 16) & 0x8000;
  const rawExp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;

  if (rawExp === 0xff) {
    // Inf (mant 0) or NaN (mant != 0, keep it quiet/non-zero).
    return sign | 0x7c00 | (mant ? 0x0200 : 0);
  }

  let exp = rawExp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7c00; // overflow -> Inf
  if (exp <= 0) {
    if (exp < -10) return sign; // underflow -> signed zero
    // Subnormal: shift the implicit-1 mantissa down into 10 bits.
    const m = mant | 0x800000;
    const shift = 14 - exp;
    let half = m >>> shift;
    const rem = m & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (half & 1))) half++;
    return sign | half;
  }
  // Normal: keep top 10 mantissa bits, round the dropped 13 to nearest-even.
  let half = (exp << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++; // carry into exp is fine
  return sign | half;
}

/** Decode an IEEE-754 half (Uint16) back to a JS number; for tests and GPU-readback debugging only. */
export function halfToFloat(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exp = (half >>> 10) & 0x1f;
  const mant = half & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24; // subnormal: 2^-14 * mant/1024
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

/**
 * Pack an interleaved (x, y) Float32 motion buffer into halves, keeping the
 * interleaving (R=x, G=y) so it uploads as DXGI_FORMAT_R16G16_FLOAT unchanged.
 */
export function encodeMotionR16G16(motion: Float32Array): Uint16Array {
  const out = new Uint16Array(motion.length);
  // A Float32Array's byteOffset is always 4-aligned, so the bit view is valid.
  const bits = new Uint32Array(motion.buffer, motion.byteOffset, motion.length);
  for (let i = 0; i < motion.length; i++) out[i] = bitsToHalf(bits[i]!);
  return out;
}

/**
 * Fused upsample + scale (grid pixels -> render pixels, x by outW/inW, y by
 * outH/inH) + half packing, one row at a time. Bit-identical to
 * `encodeMotionR16G16` of the scaled `resizeFlowBilinear` output — the same
 * float32 rounding happens at the same two points — but without its two
 * full-resolution float32 passes and intermediate. Every grid sample must be
 * finite; the caller checks that with `allFinite`.
 */
export function packFlowResizedR16G16(flow: Float32Array, inW: number, inH: number, outW: number, outH: number): Uint16Array {
  const out = new Uint16Array(outW * outH * 2);
  const kx = outW / inW;
  const ky = outH / inH;
  const sx = inW > 1 && outW > 1 ? (inW - 1) / (outW - 1) : 0;
  const sy = inH > 1 && outH > 1 ? (inH - 1) / (outH - 1) : 0;
  // Column positions and weights repeat for every row. The weights stay float64,
  // exactly as resizeFlowBilinear computes them, to keep the results identical.
  const x0s = new Int32Array(outW);
  const x1s = new Int32Array(outW);
  const wxs = new Float64Array(outW);
  for (let ox = 0; ox < outW; ox++) {
    const fx = ox * sx;
    const x0 = Math.floor(fx);
    x0s[ox] = x0;
    x1s[ox] = Math.min(x0 + 1, inW - 1);
    wxs[ox] = fx - x0;
  }
  const row = new Float32Array(outW * 2);
  const rowBits = new Uint32Array(row.buffer);
  // Float16Array (ES2025) rounds to nearest-even, so it matches bitsToHalf on
  // finite values while converting ~5x faster; the scalar loop is the fallback
  // for runtimes without it.
  const outHalf = HALF_ARRAY ? new HALF_ARRAY(out.buffer) : null;
  // Upsampling means sy < 1, so consecutive output rows keep reusing the same
  // two horizontally-interpolated input rows: a two-slot cache drops the
  // horizontal pass from 2*outH runs to about inH. Still float64 until the
  // fround, so the result is unchanged.
  const cachedRow = [new Float64Array(outW * 2), new Float64Array(outW * 2)];
  const cachedIndex = [-1, -1];
  let nextSlot = 0;
  const horizontal = (yRow: number): Float64Array => {
    if (cachedIndex[0] === yRow) return cachedRow[0]!;
    if (cachedIndex[1] === yRow) return cachedRow[1]!;
    const slot = nextSlot;
    nextSlot ^= 1;
    const dst = cachedRow[slot]!;
    cachedIndex[slot] = yRow;
    const base = yRow * inW * 2;
    for (let ox = 0; ox < outW; ox++) {
      const wx = wxs[ox]!;
      const a = base + x0s[ox]! * 2;
      const b = base + x1s[ox]! * 2;
      const o = ox * 2;
      dst[o] = flow[a]! * (1 - wx) + flow[b]! * wx;
      dst[o + 1] = flow[a + 1]! * (1 - wx) + flow[b + 1]! * wx;
    }
    return dst;
  };
  for (let oy = 0; oy < outH; oy++) {
    const fy = oy * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, inH - 1);
    const wy = fy - y0;
    const top = horizontal(y0);
    const bottom = y1 === y0 ? top : horizontal(y1);
    const wt = 1 - wy;
    for (let i = 0; i < outW * 2; i += 2) {
      // Math.fround stands in for the float32 store the reference path makes
      // before the scale multiply; without it the two paths would diverge.
      row[i] = Math.fround(top[i]! * wt + bottom[i]! * wy) * kx;
      row[i + 1] = Math.fround(top[i + 1]! * wt + bottom[i + 1]! * wy) * ky;
    }
    const base = oy * outW * 2;
    if (outHalf) outHalf.set(row, base);
    else for (let i = 0; i < rowBits.length; i++) out[base + i] = bitsToHalf(rowBits[i]!);
  }
  return out;
}

/** True when every value of the buffer is finite. */
export function allFinite(values: Float32Array): boolean {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i]!)) return false;
  return true;
}

// -- Scene-cut score (sparse-grid mean abs luma diff) --------------------------

/** OpenCV RGBA2GRAY luma weights, matching guides.py and video.ts. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Byte offsets of a sparse ~48x27 sample grid over an RGBA8 frame. Kept
 * identical to SceneCutDetector's sampling in video.ts so both produce the same
 * scene score for a frame.
 */
export function buildSampleOffsets(width: number, height: number): Int32Array {
  const stepX = Math.max(1, Math.floor(width / 48));
  const stepY = Math.max(1, Math.floor(height / 27));
  const offsets: number[] = [];
  for (let y = stepY >> 1; y < height; y += stepY) {
    for (let x = stepX >> 1; x < width; x += stepX) offsets.push((y * width + x) * 4);
  }
  return Int32Array.from(offsets);
}

/** Sample sparse-grid luma (0..255) from an RGBA8 frame at the given offsets. */
export function sparseLuma(rgba: Uint8Array, offsets: Int32Array): Float32Array {
  const out = new Float32Array(offsets.length);
  for (let i = 0; i < offsets.length; i++) {
    const o = offsets[i]!;
    out[i] = luma(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!);
  }
  return out;
}

/** Mean absolute difference of two equal-length buffers (0..255 luma domain). */
export function meanAbsLumaDiff(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return a.length ? sum / a.length : 0;
}

/**
 * Normalized [0,1] scene score between two RGBA8 frames: sparse-grid mean abs
 * luma diff / 255. RESET_SCENE_SCORE and DUPLICATE_SCENE_SCORE are thresholds
 * on this value.
 */
export function sparseSceneScore(current: Uint8Array, previous: Uint8Array, width: number, height: number): number {
  const offsets = buildSampleOffsets(width, height);
  return meanAbsLumaDiff(sparseLuma(current, offsets), sparseLuma(previous, offsets)) / 255;
}

// -- Grayscale box-average downscale ------------------------------------------

/**
 * Flow-grid dimensions for a render size: the LONG side becomes ~flowWidth, both
 * dims even and >= 64. Scaling by the long side rather than the width keeps a
 * portrait frame from running the flow on a far larger grid than intended.
 */
export function flowGridSize(width: number, height: number, flowWidth = DEFAULT_FLOW_WIDTH): { flowW: number; flowH: number } {
  const scale = Math.min(1, flowWidth / Math.max(1, width, height));
  const flowW = Math.max(64, Math.round((width * scale) / 2) * 2);
  const flowH = Math.max(64, Math.round((height * scale) / 2) * 2);
  return { flowW, flowH };
}

/**
 * Box-average downscale RGBA8 -> Float32 luma at (flowW, flowH), reproducing
 * cvtColor(RGBA2GRAY) + resize(INTER_AREA).
 */
export function smallGray(rgba: Uint8Array, width: number, height: number, flowW: number, flowH: number): Float32Array {
  const out = new Float32Array(flowW * flowH);
  // Exact integer downscale — the usual case, e.g. 1280x720 -> 640x360. Every
  // output pixel averages the same sx*sy block, so the general path's
  // per-pixel divisions and bounds checks fall away. It sums the same source
  // pixels in the same order, so the two paths agree bit for bit.
  if (width % flowW === 0 && height % flowH === 0) {
    const sx = width / flowW;
    const sy = height / flowH;
    const n = sx * sy;
    for (let oy = 0; oy < flowH; oy++) {
      const yTop = oy * sy;
      for (let ox = 0; ox < flowW; ox++) {
        const xLeft = ox * sx;
        let sum = 0;
        for (let y = 0; y < sy; y++) {
          let base = ((yTop + y) * width + xLeft) * 4;
          for (let x = 0; x < sx; x++, base += 4) sum += luma(rgba[base]!, rgba[base + 1]!, rgba[base + 2]!);
        }
        out[oy * flowW + ox] = sum / n;
      }
    }
    return out;
  }
  for (let oy = 0; oy < flowH; oy++) {
    const y0 = Math.floor((oy * height) / flowH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / flowH));
    for (let ox = 0; ox < flowW; ox++) {
      const x0 = Math.floor((ox * width) / flowW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / flowW));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        let base = (y * width + x0) * 4;
        for (let x = x0; x < x1 && x < width; x++, base += 4) {
          sum += luma(rgba[base]!, rgba[base + 1]!, rgba[base + 2]!);
          n++;
        }
      }
      out[oy * flowW + ox] = n ? sum / n : 0;
    }
  }
  return out;
}

// -- Bilinear resize of an interleaved flow field ------------------------------

/**
 * Bilinearly resize an interleaved (dx, dy) flow field from (inW, inH) to
 * (outW, outH). Magnitudes are NOT rescaled here: the caller multiplies the
 * channels by outW/inW and outH/inH afterward, as guides.py does.
 */
export function resizeFlowBilinear(flow: Float32Array, inW: number, inH: number, outW: number, outH: number): Float32Array {
  const out = new Float32Array(outW * outH * 2);
  if (inW === outW && inH === outH) {
    out.set(flow);
    return out;
  }
  const sx = inW > 1 && outW > 1 ? (inW - 1) / (outW - 1) : 0;
  const sy = inH > 1 && outH > 1 ? (inH - 1) / (outH - 1) : 0;
  for (let oy = 0; oy < outH; oy++) {
    const fy = oy * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, inH - 1);
    const wy = fy - y0;
    for (let ox = 0; ox < outW; ox++) {
      const fx = ox * sx;
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, inW - 1);
      const wx = fx - x0;
      const i00 = (y0 * inW + x0) * 2;
      const i10 = (y0 * inW + x1) * 2;
      const i01 = (y1 * inW + x0) * 2;
      const i11 = (y1 * inW + x1) * 2;
      const o = (oy * outW + ox) * 2;
      for (let c = 0; c < 2; c++) {
        const top = flow[i00 + c]! * (1 - wx) + flow[i10 + c]! * wx;
        const bot = flow[i01 + c]! * (1 - wx) + flow[i11 + c]! * wx;
        out[o + c] = top * (1 - wy) + bot * wy;
      }
    }
  }
  return out;
}

// -- Flow backends -------------------------------------------------------------

/**
 * Dense per-pixel flow on the small gray grid: an interleaved (dx, dy) field of
 * length w*h*2 in GRID pixels, `calc(current, previous)` mapping current ->
 * previous (DIS convention). The seam a native DIS or NVOFA backend slots into.
 */
export interface FlowBackend {
  readonly name: string;
  calc(current: Float32Array, previous: Float32Array, w: number, h: number): Float32Array;
  /** Release any native resources (GPU backends); optional for pure backends. */
  close?(): void;
}

export interface BlockMatchOptions {
  /** Square block edge in grid pixels (default 8). */
  block?: number;
  /** Max search displacement in grid pixels, each axis (default 8). */
  search?: number;
}

/**
 * Dependency-free block-matching flow: per block of `current`, the integer
 * displacement into `previous` that minimizes SAD, assigned to every pixel of
 * the block. That displacement is already the current->previous flow — a block
 * at p in current best matches previous at p+d, so prevPos - curPos = d — so it
 * carries the cv2 calc(current, previous) sign with no negation.
 */
export function blockMatchFlow(current: Float32Array, previous: Float32Array, w: number, h: number, opts: BlockMatchOptions = {}): Float32Array {
  const block = Math.max(1, opts.block ?? 8);
  const search = Math.max(1, opts.search ?? 8);
  const out = new Float32Array(w * h * 2);
  for (let by = 0; by < h; by += block) {
    const byEnd = Math.min(by + block, h);
    for (let bx = 0; bx < w; bx += block) {
      const bxEnd = Math.min(bx + block, w);
      let bestDx = 0;
      let bestDy = 0;
      let bestCost = Infinity;
      for (let dy = -search; dy <= search; dy++) {
        for (let dx = -search; dx <= search; dx++) {
          let cost = 0;
          for (let y = by; y < byEnd; y++) {
            const qy = y + dy;
            if (qy < 0 || qy >= h) {
              cost += 255 * (bxEnd - bx); // off-frame penalty, whole row
              continue;
            }
            const cRow = y * w;
            const qRow = qy * w;
            for (let x = bx; x < bxEnd; x++) {
              const qx = x + dx;
              cost += qx < 0 || qx >= w ? 255 : Math.abs(current[cRow + x]! - previous[qRow + qx]!);
            }
          }
          // Prefer the smaller displacement on ties for a stable, low-noise field.
          if (cost < bestCost || (cost === bestCost && Math.abs(dx) + Math.abs(dy) < Math.abs(bestDx) + Math.abs(bestDy))) {
            bestCost = cost;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }
      for (let y = by; y < byEnd; y++) {
        let o = (y * w + bx) * 2;
        for (let x = bx; x < bxEnd; x++, o += 2) {
          out[o] = bestDx;
          out[o + 1] = bestDy;
        }
      }
    }
  }
  return out;
}

/** The pure-TS block-matching backend (default / 'auto' / 'ts'). */
export function createBlockMatchBackend(opts: BlockMatchOptions = {}): FlowBackend {
  return {
    name: "ts-blockmatch",
    calc: (current, previous, w, h) => blockMatchFlow(current, previous, w, h, opts),
  };
}

/**
 * ffmpeg args that extract per-frame codec motion vectors from `input`. These
 * are block-granular compression vectors (mestimate + export_mvs), NOT the dense
 * optical flow DLSS needs, which is why the ffmpeg backend below never produces.
 */
export function buildMvExtractArgs(ffmpeg: string, input: string): string[] {
  return [
    ffmpeg,
    "-v",
    "error",
    "-flags2",
    "+export_mvs",
    "-i",
    input,
    "-vf",
    "mestimate=epzs,codecview=mv=pf+bf+bb",
    "-f",
    "null",
    "-",
  ];
}

/** ffmpeg backend seam; `calc` throws because ffmpeg cannot produce dense flow. */
export function createFfmpegBackend(): FlowBackend {
  return {
    name: "ffmpeg-stub",
    calc: () => {
      throw new Error("ffmpeg backend does not produce dense optical flow; use the 'ts' backend (or a native NVOFA/DIS backend)");
    },
  };
}

// -- Estimator -----------------------------------------------------------------

export interface MotionResult {
  /**
   * Interleaved (x, y) motion in RENDER-RESOLUTION pixels, length width*height*2.
   * Null whenever there is no usable motion — first frame, scene cut, duplicate
   * or low confidence — which the engine treats as zero motion plus reset.
   */
  motion: Float32Array | null;
  /** First frame, scene cut, or confidence below RESET_CONFIDENCE: drop temporal history. */
  reset: boolean;
  /** Normalized [0,1] scene score (mean abs luma diff / 255). */
  sceneScore: number;
  /** Near-duplicate frame (sceneScore below DUPLICATE_SCENE_SCORE); not a reset. */
  duplicate: boolean;
  /** Fraction of finite motion vectors in [0,1]; 1.0 on a duplicate. */
  confidence: number;
}

/** MotionResult with the field already packed as R16G16_FLOAT, the form the DLSSG worker consumes. */
export interface PackedMotionResult {
  /** Interleaved (x, y) halves in render pixels, length width*height*2; null as in MotionResult.motion. */
  half: Uint16Array | null;
  reset: boolean;
  sceneScore: number;
  duplicate: boolean;
  confidence: number;
}

/**
 * The analysis half of processPacked(): scene decisions plus the grid-resolution
 * flow, so the expensive upsample + pack can run on another thread. At most one
 * of `small` / `half` is ever set — `small` on the fast path, for the caller to
 * finish with packFlowResizedR16G16; `half` when a non-finite grid sample forced
 * the exact path to build the full field here.
 */
export interface AnalyzedMotion {
  small: Float32Array | null;
  half: Uint16Array | null;
  reset: boolean;
  sceneScore: number;
  duplicate: boolean;
  confidence: number;
}

export interface MotionEstimator {
  /**
   * Feed the next RGBA8 frame. `forceReset` marks a discontinuity only the
   * caller can see (timestamp gap, new segment) and makes the frame a scene cut
   * whatever its score.
   */
  process(rgba: Uint8Array, forceReset?: boolean): MotionResult;
  /**
   * process() with the motion already packed as halves, skipping the
   * full-resolution float32 field frame generation would only convert anyway.
   */
  processPacked(rgba: Uint8Array, forceReset?: boolean): PackedMotionResult;
  /** processPacked() split in two: decisions + grid flow here, packing left to the caller (see AnalyzedMotion). */
  analyzePacked(rgba: Uint8Array, forceReset?: boolean): AnalyzedMotion;
  close(): void;
}

export type FlowBackendKind = "auto" | "ts" | "ffmpeg" | "nvof" | "dis";

export interface MotionEstimatorOptions {
  /** Long-side resolution to run flow at (default 640, rounded even, >= 64). */
  flowWidth?: number;
  /** Backend kind (default 'auto' -> pure-TS block matching), or a ready-made instance such as the NVOFA backend. */
  backend?: FlowBackendKind | FlowBackend;
  /** Override the block-match backend tuning (ts backend only). */
  blockMatch?: BlockMatchOptions;
}

function selectBackend(kind: FlowBackendKind, opts: MotionEstimatorOptions): FlowBackend {
  switch (kind) {
    case "auto":
    case "ts":
      return createBlockMatchBackend(opts.blockMatch);
    case "ffmpeg":
      return createFfmpegBackend();
    case "nvof":
    case "dis":
      // Native GPU/DIS backends live behind bun:ffi, which this GPU-free module
      // cannot pull in; callers pass such a backend in as an instance instead.
      throw new Error(`optical-flow backend '${kind}' is not available in this build; use 'ts'`);
    default:
      throw new Error(`unknown optical-flow backend '${String(kind)}'`);
  }
}

/**
 * What scene analysis decided about one frame. A `settled` frame already has its
 * final verdict and confidence — first frame, scene cut or duplicate, none of
 * which produce a flow field. Otherwise the grid flow comes back and the caller
 * settles reset and confidence once it knows how much of the upsampled field is
 * finite.
 */
type Analysis =
  | { settled: true; reset: boolean; sceneScore: number; duplicate: boolean; confidence: number }
  | { settled: false; small: Float32Array; sceneScore: number };

class DisMotionEstimator implements MotionEstimator {
  private readonly flowW: number;
  private readonly flowH: number;
  private readonly offsets: Int32Array;
  private prevGray: Float32Array | null = null;
  private prevSamples: Float32Array | null = null;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly backend: FlowBackend,
    flowWidth: number,
  ) {
    const { flowW, flowH } = flowGridSize(width, height, flowWidth);
    this.flowW = flowW;
    this.flowH = flowH;
    this.offsets = buildSampleOffsets(width, height);
  }

  /** Scene analysis shared by every entry point: advances the history and returns the grid flow when there is one to upsample. */
  private analyze(rgba: Uint8Array, forceReset: boolean): Analysis {
    if (rgba.length < this.width * this.height * 4) {
      throw new Error(`flow: frame is ${rgba.length} bytes, expected ${this.width * this.height * 4}`);
    }
    const samples = sparseLuma(rgba, this.offsets);
    const gray = smallGray(rgba, this.width, this.height, this.flowW, this.flowH);

    // Nothing to compare the first frame against, so it is a forced reset.
    if (!this.prevGray || !this.prevSamples) {
      this.prevGray = gray;
      this.prevSamples = samples;
      return { settled: true, reset: true, sceneScore: 1, duplicate: false, confidence: 0 };
    }

    const sceneScore = meanAbsLumaDiff(samples, this.prevSamples) / 255;
    const duplicate = sceneScore < DUPLICATE_SCENE_SCORE;
    // A caller-known discontinuity resets exactly like a detected cut (guides.py: force_reset or score above threshold).
    const sceneReset = forceReset || sceneScore > RESET_SCENE_SCORE;
    if (duplicate || sceneReset) {
      this.prevGray = gray;
      this.prevSamples = samples;
      // A duplicate holds the temporal history (confidence 1); a cut discards it.
      return { settled: true, reset: sceneReset, sceneScore, duplicate, confidence: duplicate ? 1 : 0 };
    }

    // Grid pixels, current -> previous; the caller scales to render pixels.
    const small = this.backend.calc(gray, this.prevGray, this.flowW, this.flowH);
    this.prevGray = gray;
    this.prevSamples = samples;
    return { settled: false, small, sceneScore };
  }

  /**
   * Exact path: full-resolution render-pixel field plus the finite fraction,
   * with non-finite vectors zeroed (guides.py:52-63).
   */
  private toFull(small: Float32Array): { full: Float32Array; confidence: number } {
    const full = resizeFlowBilinear(small, this.flowW, this.flowH, this.width, this.height);
    // resizeFlowBilinear leaves magnitudes in grid pixels.
    const kx = this.width / this.flowW;
    const ky = this.height / this.flowH;
    let finite = 0;
    for (let i = 0; i < this.width * this.height; i++) {
      const xi = i * 2;
      const yi = xi + 1;
      const x = full[xi]! * kx;
      const y = full[yi]! * ky;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        full[xi] = x;
        full[yi] = y;
        finite++;
      } else {
        full[xi] = 0;
        full[yi] = 0;
      }
    }
    return { full, confidence: finite / (this.width * this.height) };
  }

  process(rgba: Uint8Array, forceReset = false): MotionResult {
    const a = this.analyze(rgba, forceReset);
    if (a.settled) return { motion: null, reset: a.reset, sceneScore: a.sceneScore, duplicate: a.duplicate, confidence: a.confidence };
    const { full, confidence } = this.toFull(a.small);
    const reset = confidence < RESET_CONFIDENCE;
    return { motion: reset ? null : full, reset, sceneScore: a.sceneScore, duplicate: false, confidence };
  }

  analyzePacked(rgba: Uint8Array, forceReset = false): AnalyzedMotion {
    const a = this.analyze(rgba, forceReset);
    if (a.settled) return { small: null, half: null, reset: a.reset, sceneScore: a.sceneScore, duplicate: a.duplicate, confidence: a.confidence };
    if (allFinite(a.small)) return { small: a.small, half: null, reset: false, sceneScore: a.sceneScore, duplicate: false, confidence: 1 };
    const { full, confidence } = this.toFull(a.small);
    const reset = confidence < RESET_CONFIDENCE;
    return { small: null, half: reset ? null : encodeMotionR16G16(full), reset, sceneScore: a.sceneScore, duplicate: false, confidence };
  }

  processPacked(rgba: Uint8Array, forceReset = false): PackedMotionResult {
    const a = this.analyze(rgba, forceReset);
    if (a.settled) return { half: null, reset: a.reset, sceneScore: a.sceneScore, duplicate: a.duplicate, confidence: a.confidence };
    // A finite grid — always so for block matching and NVOFA — interpolates to a
    // finite field, so confidence is exactly 1 and one fused pass can replace
    // resize + scale + count + pack.
    if (allFinite(a.small)) {
      return { half: packFlowResizedR16G16(a.small, this.flowW, this.flowH, this.width, this.height), reset: false, sceneScore: a.sceneScore, duplicate: false, confidence: 1 };
    }
    const { full, confidence } = this.toFull(a.small);
    const reset = confidence < RESET_CONFIDENCE;
    return { half: reset ? null : encodeMotionR16G16(full), reset, sceneScore: a.sceneScore, duplicate: false, confidence };
  }

  close(): void {
    this.prevGray = null;
    this.prevSamples = null;
    this.backend.close?.();
  }
}

/**
 * Motion estimator turning consecutive RGBA8 frames of the given render size
 * into the DLSS motion-vector field. It keeps the previous frame's gray grid and
 * samples, so one estimator serves one stream and must not be shared.
 */
export function createMotionEstimator(width: number, height: number, opts: MotionEstimatorOptions = {}): MotionEstimator {
  if (width <= 0 || height <= 0) throw new Error(`flow: invalid size ${width}x${height}`);
  // A ready-made instance (e.g. the NVOFA GPU backend) is used as given; its
  // close() then runs through the estimator's close(), not the caller's.
  const chosen = opts.backend;
  const backend = chosen && typeof chosen === "object" ? chosen : selectBackend(chosen ?? "auto", opts);
  return new DisMotionEstimator(width, height, backend, opts.flowWidth ?? DEFAULT_FLOW_WIDTH);
}
