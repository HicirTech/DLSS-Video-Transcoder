/**
 * Optical-flow motion vectors for the DLSS / DLSSG / DLSSNR motion-vector
 * contract, ported from the reference DIS generator (dref guides.py).
 *
 * The estimator consumes two consecutive tightly-packed RGBA8 frames and yields
 * a per-pixel backward motion field in RENDER-RESOLUTION PIXELS, interleaved
 * (x, y), origin top-left, +x right, +y down, no y flip. This is the exact unit
 * and convention `FrameInput.motion` (engine.ts) already expects, so the engine
 * only has to pack it to R16G16_FLOAT and set MV.Scale = 1.0.
 *
 * DIS convention: `flow.calc(current, previous)` maps current -> previous, i.e.
 * `MV[p] = prevPos - curPos`: add MV to a current pixel coord to reach where
 * that pixel was in the previous frame.
 *
 * OpenCV is unavailable in Bun, so the primary dependency-free path here is a
 * simple block-matching flow computed in pure TS on a downscaled grayscale
 * grid (long side ~flowWidth, default 640), then bilinearly resized to full
 * resolution and scaled to render pixels — matching guides.py:24-55. A
 * ffmpeg-based path is provided behind a clear function boundary (arg builder +
 * stub) but is not the producer: ffmpeg only exposes block-granular codec
 * vectors, not dense flow, so it stays a boundary the GPU/native backends can
 * later replace (NVOFA / native DIS).
 *
 * All the math (float16 packing, scene score, gray downscale, block match,
 * bilinear resize) is pure and GPU-free so it is unit-testable without a GPU.
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

/**
 * Encode one float32 as an IEEE-754 half (Uint16). Handles normals,
 * subnormals, signed zero, overflow -> Inf, and NaN, with round-to-nearest-even
 * on the mantissa. Suitable for packing motion vectors into R16G16_FLOAT.
 */
export function floatToHalf(value: number): number {
  f32[0] = value;
  return bitsToHalf(u32[0]!);
}

/**
 * floatToHalf on the raw IEEE-754 bits of a float32. Lets a whole buffer be
 * converted through a Uint32Array view with integer ops only, instead of a
 * scalar store/load per element (13 ms per 720p motion field before).
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

/**
 * Decode an IEEE-754 half (Uint16) back to a JS number. Provided for tests and
 * GPU-readback debugging; not used on the hot path.
 */
export function halfToFloat(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exp = (half >>> 10) & 0x1f;
  const mant = half & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24; // subnormal: 2^-14 * mant/1024
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

/**
 * Pack an interleaved (x, y) Float32 motion buffer into R16G16_FLOAT halves.
 * `motion.length` must be width*height*2; the returned Uint16Array aliases the
 * same interleaving (R=x, G=y) ready to upload as DXGI_FORMAT_R16G16_FLOAT.
 */
export function encodeMotionR16G16(motion: Float32Array): Uint16Array {
  const out = new Uint16Array(motion.length);
  // A Float32Array's byteOffset is always 4-aligned, so the bit view is valid.
  const bits = new Uint32Array(motion.buffer, motion.byteOffset, motion.length);
  for (let i = 0; i < motion.length; i++) out[i] = bitsToHalf(bits[i]!);
  return out;
}

/**
 * Bilinearly upsample an interleaved (dx, dy) grid flow to (outW, outH), scale
 * x by outW/inW and y by outH/inH (grid pixels -> render pixels) and pack the
 * result as R16G16_FLOAT halves in ONE pass, one row at a time. Bit-identical
 * to `encodeMotionR16G16` applied to the estimator's scaled
 * `resizeFlowBilinear` output (the same float32 rounding happens at the same
 * two points), but without the two full-resolution float32 passes and the
 * 14.7 MB intermediate a 720p field needs. Every grid sample must be finite.
 */
export function packFlowResizedR16G16(flow: Float32Array, inW: number, inH: number, outW: number, outH: number): Uint16Array {
  const out = new Uint16Array(outW * outH * 2);
  const kx = outW / inW;
  const ky = outH / inH;
  const sx = inW > 1 && outW > 1 ? (inW - 1) / (outW - 1) : 0;
  const sy = inH > 1 && outH > 1 ? (inH - 1) / (outH - 1) : 0;
  // Column sample positions and weights are the same for every row; keep the
  // weights in float64 exactly as resizeFlowBilinear computes them.
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
  for (let oy = 0; oy < outH; oy++) {
    const fy = oy * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, inH - 1);
    const wy = fy - y0;
    const r0 = y0 * inW * 2;
    const r1 = y1 * inW * 2;
    for (let ox = 0; ox < outW; ox++) {
      const wx = wxs[ox]!;
      const i00 = r0 + x0s[ox]! * 2;
      const i10 = r0 + x1s[ox]! * 2;
      const i01 = r1 + x0s[ox]! * 2;
      const i11 = r1 + x1s[ox]! * 2;
      const o = ox * 2;
      // Math.fround reproduces the float32 store of the interpolated value that
      // precedes the scale multiply in the reference path.
      const topX = flow[i00]! * (1 - wx) + flow[i10]! * wx;
      const botX = flow[i01]! * (1 - wx) + flow[i11]! * wx;
      row[o] = Math.fround(topX * (1 - wy) + botX * wy) * kx;
      const topY = flow[i00 + 1]! * (1 - wx) + flow[i10 + 1]! * wx;
      const botY = flow[i01 + 1]! * (1 - wx) + flow[i11 + 1]! * wx;
      row[o + 1] = Math.fround(topY * (1 - wy) + botY * wy) * ky;
    }
    const base = oy * outW * 2;
    for (let i = 0; i < rowBits.length; i++) out[base + i] = bitsToHalf(rowBits[i]!);
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
 * Byte offsets of a sparse ~48x27 sample grid over an RGBA8 frame — the same
 * sampling SceneCutDetector uses in video.ts, so the scene score here carries
 * identical grid semantics.
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
 * luma diff / 255. Reset threshold 0.24, duplicate threshold 0.0005 apply to
 * this value (reference guides.py:43-45).
 */
export function sparseSceneScore(current: Uint8Array, previous: Uint8Array, width: number, height: number): number {
  const offsets = buildSampleOffsets(width, height);
  return meanAbsLumaDiff(sparseLuma(current, offsets), sparseLuma(previous, offsets)) / 255;
}

// -- Grayscale box-average downscale ------------------------------------------

/**
 * Compute the flow-grid dimensions for a render size: scale so the LONG side is
 * ~flowWidth (matching the documented "long-side resolution"); dims rounded to
 * even and clamped to >= 64. Scaling by the long side keeps portrait frames from
 * running the flow at a much larger grid than intended.
 */
export function flowGridSize(width: number, height: number, flowWidth = DEFAULT_FLOW_WIDTH): { flowW: number; flowH: number } {
  const scale = Math.min(1, flowWidth / Math.max(1, width, height));
  const flowW = Math.max(64, Math.round((width * scale) / 2) * 2);
  const flowH = Math.max(64, Math.round((height * scale) / 2) * 2);
  return { flowW, flowH };
}

/**
 * Box-average downscale RGBA8 -> Float32 luma at (flowW, flowH), reproducing
 * cvtColor(RGBA2GRAY) + resize(INTER_AREA). When the grid matches the source
 * this degrades to a plain per-pixel luma pass.
 */
export function smallGray(rgba: Uint8Array, width: number, height: number, flowW: number, flowH: number): Float32Array {
  const out = new Float32Array(flowW * flowH);
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
 * (outW, outH). Magnitudes are NOT rescaled here — that is the caller's job
 * (guides.py multiplies channels by outW/inW and outH/inH afterward).
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
 * A flow backend computes dense per-pixel flow on the (small) gray grid. It
 * returns an interleaved (dx, dy) Float32 field of length w*h*2 in GRID pixels,
 * with `calc(current, previous)` mapping current -> previous (DIS convention).
 * This is the seam a native DIS or NVOFA backend later slots into.
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
 * Dependency-free block-matching flow: for each block in `current`, find the
 * integer displacement into `previous` that minimizes SAD, and assign it to
 * every pixel of the block. The displacement IS the current->previous flow
 * (a block sitting at p in current best matches previous at p+d, so
 * prevPos - curPos = d), matching cv2 calc(current, previous) sign.
 *
 * Coarse (block-constant, integer) but pure and adequate as a CPU fallback and
 * for unit testing; a native DIS/NVOFA backend supersedes it for quality.
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
            let cRow = y * w + bx;
            let qRow = qy * w + bx;
            for (let x = bx; x < bxEnd; x++, cRow++, qRow++) {
              const qx = x + dx;
              cost += qx < 0 || qx >= w ? 255 : Math.abs(current[cRow]! - previous[qy * w + qx]!);
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
 * Build the ffmpeg args that would extract per-frame codec motion vectors from
 * `input`. Pure/testable; kept for the ffmpeg path boundary only. NOTE: these
 * are block-granular compression vectors (mestimate + export_mvs), NOT dense
 * optical flow, so this is a stub the ts/native backends stand in for.
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

/**
 * ffmpeg-based backend boundary. ffmpeg cannot produce the dense per-pixel flow
 * DLSS needs, so `calc` throws: this exists as an explicit seam (and to keep
 * arg construction unit-testable) rather than a working producer.
 */
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
   * Interleaved (x, y) motion in RENDER-RESOLUTION pixels, length width*height*2,
   * or null when there is no usable motion (first frame, scene cut, duplicate,
   * or low confidence) — the engine treats null as zero/reset.
   */
  motion: Float32Array | null;
  /** True on first frame, scene cut, or low flow confidence: clears history. */
  reset: boolean;
  /** Normalized [0,1] scene score (mean abs luma diff / 255). */
  sceneScore: number;
  /** True when the frame is a near-duplicate (sceneScore < 0.0005). */
  duplicate: boolean;
  /** Fraction of finite motion vectors in [0,1] (1.0 on duplicate). */
  confidence: number;
}

/** MotionResult with the field already packed as R16G16_FLOAT (what the DLSSG worker consumes). */
export interface PackedMotionResult {
  /** Interleaved (x, y) halves in render pixels, length width*height*2, or null when there is no usable motion. */
  half: Uint16Array | null;
  reset: boolean;
  sceneScore: number;
  duplicate: boolean;
  confidence: number;
}

export interface MotionEstimator {
  /**
   * Feed the next RGBA8 frame; returns its motion field and reset state.
   * `forceReset` marks a known discontinuity (timestamp gap, new segment) so
   * the frame is treated as a scene cut regardless of its score.
   */
  process(rgba: Uint8Array, forceReset?: boolean): MotionResult;
  /**
   * Same decisions as process(), but the motion comes back packed as halves
   * via one fused resize+scale+pack pass — skipping the full-resolution
   * float32 field that frame generation would only convert anyway.
   */
  processPacked(rgba: Uint8Array, forceReset?: boolean): PackedMotionResult;
  close(): void;
}

export type FlowBackendKind = "auto" | "ts" | "ffmpeg" | "nvof" | "dis";

export interface MotionEstimatorOptions {
  /** Long-side resolution to run flow at (default 640, rounded even, >= 64). */
  flowWidth?: number;
  /** Backend selection (default 'auto' -> pure-TS block matching), or a ready-made backend instance (e.g. NVOFA). */
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
      // Native GPU/DIS backends live behind bun:ffi and are not part of this
      // pure module; wire them here once the DLLs are vendored.
      throw new Error(`optical-flow backend '${kind}' is not available in this build; use 'ts'`);
    default:
      throw new Error(`unknown optical-flow backend '${String(kind)}'`);
  }
}

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

  /**
   * Scene analysis shared by process() and processPacked(): updates the
   * history and returns the grid flow when there is one to upsample. A null
   * `small` means the frame already has its final verdict (first frame, cut,
   * duplicate); confidence is then settled, otherwise the caller decides it.
   */
  private analyze(rgba: Uint8Array, forceReset: boolean): { small: Float32Array | null; reset: boolean; sceneScore: number; duplicate: boolean; confidence: number } {
    if (rgba.length < this.width * this.height * 4) {
      throw new Error(`flow: frame is ${rgba.length} bytes, expected ${this.width * this.height * 4}`);
    }
    const samples = sparseLuma(rgba, this.offsets);
    const gray = smallGray(rgba, this.width, this.height, this.flowW, this.flowH);

    // First frame: nothing to compare against -> forced reset, zero motion.
    if (!this.prevGray || !this.prevSamples) {
      this.prevGray = gray;
      this.prevSamples = samples;
      return { small: null, reset: true, sceneScore: 1, duplicate: false, confidence: 0 };
    }

    const sceneScore = meanAbsLumaDiff(samples, this.prevSamples) / 255;
    const duplicate = sceneScore < DUPLICATE_SCENE_SCORE;
    // A caller-known discontinuity resets exactly like a detected cut (guides.py: force_reset or score > 0.24).
    const sceneReset = forceReset || sceneScore > RESET_SCENE_SCORE;
    if (duplicate || sceneReset) {
      this.prevGray = gray;
      this.prevSamples = samples;
      // Duplicate does not force reset (confidence 1); a scene cut does.
      return { small: null, reset: sceneReset, sceneScore, duplicate, confidence: duplicate ? 1 : 0 };
    }

    // Dense flow on the small grid, current -> previous, in grid pixels.
    const small = this.backend.calc(gray, this.prevGray, this.flowW, this.flowH);
    this.prevGray = gray;
    this.prevSamples = samples;
    return { small, reset: false, sceneScore, duplicate: false, confidence: -1 };
  }

  /** Full-resolution render-pixel float32 field plus the finite fraction (guides.py:52-63). */
  private toFull(small: Float32Array): { full: Float32Array; confidence: number } {
    const full = resizeFlowBilinear(small, this.flowW, this.flowH, this.width, this.height);
    // Convert grid displacement to render-res pixels.
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
    if (a.small === null) return { motion: null, reset: a.reset, sceneScore: a.sceneScore, duplicate: a.duplicate, confidence: a.confidence };
    const { full, confidence } = this.toFull(a.small);
    const reset = confidence < RESET_CONFIDENCE;
    return { motion: reset ? null : full, reset, sceneScore: a.sceneScore, duplicate: false, confidence };
  }

  processPacked(rgba: Uint8Array, forceReset = false): PackedMotionResult {
    const a = this.analyze(rgba, forceReset);
    if (a.small === null) return { half: null, reset: a.reset, sceneScore: a.sceneScore, duplicate: a.duplicate, confidence: a.confidence };
    // Fast path: every grid sample finite (always, for NVOFA and block matching)
    // means the interpolated field is finite too, so confidence is exactly 1 and
    // one fused pass replaces resize + scale + count + pack.
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
 * Create a motion estimator that turns consecutive RGBA8 frames into the DLSS
 * motion-vector field. `backend: 'auto'` (default) uses the dependency-free
 * pure-TS block matcher; 'ffmpeg' selects the (non-producing) ffmpeg boundary;
 * 'nvof'/'dis' are reserved for native backends.
 */
export function createMotionEstimator(width: number, height: number, opts: MotionEstimatorOptions = {}): MotionEstimator {
  if (width <= 0 || height <= 0) throw new Error(`flow: invalid size ${width}x${height}`);
  // A ready-made backend instance (e.g. the NVOFA GPU backend) is used directly;
  // otherwise select one of the pure/built-in backends by kind.
  const chosen = opts.backend;
  const backend = chosen && typeof chosen === "object" ? chosen : selectBackend(chosen ?? "auto", opts);
  return new DisMotionEstimator(width, height, backend, opts.flowWidth ?? DEFAULT_FLOW_WIDTH);
}
