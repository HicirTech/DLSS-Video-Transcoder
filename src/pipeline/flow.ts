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
  const x = u32[0]!;
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
  for (let i = 0; i < motion.length; i++) out[i] = floatToHalf(motion[i]!);
  return out;
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
 * Compute the flow-grid dimensions for a render size, per guides.py:24-26:
 * scale = min(1, flowWidth/width); dims rounded to even and clamped to >= 64.
 */
export function flowGridSize(width: number, height: number, flowWidth = DEFAULT_FLOW_WIDTH): { flowW: number; flowH: number } {
  const scale = Math.min(1, flowWidth / Math.max(1, width));
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

export interface MotionEstimator {
  /** Feed the next RGBA8 frame; returns its motion field and reset state. */
  process(rgba: Uint8Array): MotionResult;
  close(): void;
}

export type FlowBackendKind = "auto" | "ts" | "ffmpeg" | "nvof" | "dis";

export interface MotionEstimatorOptions {
  /** Long-side resolution to run flow at (default 640, rounded even, >= 64). */
  flowWidth?: number;
  /** Backend selection (default 'auto' -> pure-TS block matching). */
  backend?: FlowBackendKind;
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

  process(rgba: Uint8Array): MotionResult {
    if (rgba.length < this.width * this.height * 4) {
      throw new Error(`flow: frame is ${rgba.length} bytes, expected ${this.width * this.height * 4}`);
    }
    const samples = sparseLuma(rgba, this.offsets);
    const gray = smallGray(rgba, this.width, this.height, this.flowW, this.flowH);

    // First frame: nothing to compare against -> forced reset, zero motion.
    if (!this.prevGray || !this.prevSamples) {
      this.prevGray = gray;
      this.prevSamples = samples;
      return { motion: null, reset: true, sceneScore: 1, duplicate: false, confidence: 0 };
    }

    const sceneScore = meanAbsLumaDiff(samples, this.prevSamples) / 255;
    const duplicate = sceneScore < DUPLICATE_SCENE_SCORE;
    const sceneReset = sceneScore > RESET_SCENE_SCORE;
    if (duplicate || sceneReset) {
      this.prevGray = gray;
      this.prevSamples = samples;
      // Duplicate does not force reset (confidence 1); a scene cut does.
      return { motion: null, reset: sceneReset, sceneScore, duplicate, confidence: duplicate ? 1 : 0 };
    }

    // Dense flow on the small grid, current -> previous, in grid pixels.
    const small = this.backend.calc(gray, this.prevGray, this.flowW, this.flowH);
    const full = resizeFlowBilinear(small, this.flowW, this.flowH, this.width, this.height);
    // Convert grid displacement to render-res pixels (guides.py:52-55).
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
    const confidence = finite / (this.width * this.height);
    const reset = confidence < RESET_CONFIDENCE;

    this.prevGray = gray;
    this.prevSamples = samples;
    return { motion: reset ? null : full, reset, sceneScore, duplicate: false, confidence };
  }

  close(): void {
    this.prevGray = null;
    this.prevSamples = null;
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
  const backend = selectBackend(opts.backend ?? "auto", opts);
  return new DisMotionEstimator(width, height, backend, opts.flowWidth ?? DEFAULT_FLOW_WIDTH);
}
