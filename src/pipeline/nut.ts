/**
 * NUT + rational-PTS framing for the frame-generation encode path.
 *
 * When the number of output frames differs from the number of input frames
 * (DLSSG 2x/3x/4x native, or a cascade + nearest-timestamp resample), a bare
 * `rawvideo` stream with `-r <fps>` cannot carry the per-frame timestamps: it
 * only stamps a single constant rate over whatever frames arrive. The reference
 * pipeline solves this by muxing the raw frames into a NUT container that
 * preserves the *exact rational* frame clock (e.g. 60000/1001) and driving
 * ffmpeg with `-fps_mode passthrough` (+ `-enc_time_base:v demux` on the
 * timestamp-preserving path), so MKV/MP4 millisecond-timebase rounding never
 * touches 60000/1001.
 *
 * This module is PURE: it builds ffmpeg argument vectors and computes the
 * integer (int64) PTS timeline / nearest-timestamp resample selection using
 * exact rational (bigint) arithmetic. Nothing here spawns ffmpeg or touches a
 * GPU; the caller (src/pipeline/video.ts) wires the args to Bun.spawn and feeds
 * the frame bytes. See AI-context/impl-specs-full.md, section
 * "FFmpeg pipeline: NVENC probe, NUT+PTS framing".
 */

/** An exact rational number (kept as bigint num/den so 60000/1001 never drifts). */
export interface Rational {
  num: bigint;
  den: bigint;
}

function bigAbs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

function gcd(a: bigint, b: bigint): bigint {
  a = bigAbs(a);
  b = bigAbs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1n;
}

/** Build a normalized Rational (den > 0, reduced). Throws on a zero denominator. */
export function rational(num: bigint | number, den: bigint | number = 1n): Rational {
  let n = BigInt(num);
  let d = BigInt(den);
  if (d === 0n) throw new Error("rational: denominator must not be zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { num: n / g, den: d / g };
}

/**
 * Parse an ffmpeg-style rate string. Accepts an exact rational `"60000/1001"`,
 * a plain integer `"24"`, or a decimal `"23.976"` (decimals are converted to an
 * exact fraction over a power of ten, NOT rounded to float).
 */
export function parseRational(text: string): Rational {
  const s = text.trim();
  if (s.includes("/")) {
    const [n, d] = s.split("/");
    return rational(BigInt(n!.trim()), BigInt(d!.trim()));
  }
  if (s.includes(".")) {
    const neg = s.startsWith("-");
    const body = neg ? s.slice(1) : s;
    const [whole, frac = ""] = body.split(".");
    const den = 10n ** BigInt(frac.length);
    const num = BigInt(whole || "0") * den + BigInt(frac || "0");
    return rational(neg ? -num : num, den);
  }
  return rational(BigInt(s), 1n);
}

/** Render a Rational back to an ffmpeg `"num/den"` rate string. */
export function formatRational(r: Rational): string {
  return `${r.num}/${r.den}`;
}

/** a * b, reduced. */
export function ratMul(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

/** a / b, reduced. */
export function ratDiv(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den, a.den * b.num);
}

/** Compare two rationals: -1 if a<b, 0 if equal, 1 if a>b. */
export function ratCmp(a: Rational, b: Rational): number {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

/** ceil of a non-negative rational to a bigint. */
export function ratCeil(r: Rational): bigint {
  if (r.num <= 0n) return r.num / r.den; // truncates toward zero for <=0 (unused here)
  return (r.num + r.den - 1n) / r.den;
}

/** Round a non-negative fraction num/den to the nearest bigint (ties round up). */
function roundDiv(num: bigint, den: bigint): bigint {
  const q = num / den;
  const r = num % den;
  return 2n * r >= den ? q + 1n : q;
}

// ---------------------------------------------------------------------------
// (1) NUT + rawvideo argument construction
// ---------------------------------------------------------------------------

export interface DecodeArgsOptions {
  /** ffmpeg binary; prepended as argv[0] when provided. */
  ffmpeg?: string;
  /** Source media path. */
  input: string;
  /** Optional working-size rescale applied during decode. */
  scale?: { width: number; height: number };
  /** Raw pixel format for the engine (default "rgba"). */
  pixFmt?: string;
}

/**
 * DECODE stage (contract B): decode the source video-only stream to raw frames
 * on stdout, preserving presentation order. `-fps_mode passthrough` keeps every
 * source frame exactly once; `-an -sn -dn` drops audio/subtitle/data.
 */
export function buildDecodeArgs(opts: DecodeArgsOptions): string[] {
  const pixFmt = opts.pixFmt ?? "rgba";
  const args: string[] = [];
  if (opts.ffmpeg) args.push(opts.ffmpeg);
  args.push("-hide_banner", "-v", "warning", "-nostdin", "-i", opts.input, "-map", "0:v:0", "-an", "-sn", "-dn");
  if (opts.scale) args.push("-vf", `scale=${opts.scale.width}:${opts.scale.height}:flags=lanczos`);
  args.push("-f", "rawvideo", "-pix_fmt", pixFmt, "-fps_mode", "passthrough", "pipe:1");
  return args;
}

export interface NutPrestageOptions {
  ffmpeg?: string;
  /** Output frame width. */
  width: number;
  /** Output frame height. */
  height: number;
  /** Exact rational target rate (Rational or "num/den" string). */
  rate: Rational | string;
  /** Raw pixel format arriving on stdin (default "rgba"). */
  pixFmt?: string;
}

/**
 * Optional rawvideo -> NUT pre-stage for the *CFR* frame-gen case. Reads raw
 * frames on stdin, stamps CFR PTS = n/rate via the rawvideo demuxer's
 * `-framerate` (exact rational), and stream-copies into a NUT byte stream on
 * stdout. This is the no-PyAV way to inject the exact rational clock; the
 * encoder stage below then consumes `-f nut -i pipe:0`. (Arbitrary per-packet
 * PTS — a nearest-timestamp/VFR writer — needs a real NUT muxer instead; the
 * PTS values for that come from computeOutputTimestamps.)
 */
export function buildNutPrestageArgs(opts: NutPrestageOptions): string[] {
  const rate = typeof opts.rate === "string" ? opts.rate : formatRational(opts.rate);
  const pixFmt = opts.pixFmt ?? "rgba";
  const args: string[] = [];
  if (opts.ffmpeg) args.push(opts.ffmpeg);
  args.push(
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-f",
    "rawvideo",
    "-pixel_format",
    pixFmt,
    "-video_size",
    `${opts.width}x${opts.height}`,
    "-framerate",
    rate,
    "-i",
    "pipe:0",
    "-map",
    "0:v:0",
    "-an",
    "-c:v",
    "copy",
    "-f",
    "nut",
    "pipe:1",
  );
  return args;
}

export interface EncodeArgsOptions {
  ffmpeg?: string;
  /** Video-only intermediate output path (a `.nut` temp file). */
  output: string;
  /** Codec + quality args (owned by video.ts), inserted verbatim. */
  codecArgs: string[];
  /**
   * Preserve the demux (NUT) timestamps exactly by adding `-enc_time_base:v
   * demux`. Default true — this is the whole point of the NUT framing path.
   * Set false for the plain `-framerate`-CFR variant that carries PTS through
   * `-fps_mode passthrough` alone.
   */
  preserveTimestamps?: boolean;
  /** Add `-copyts` (keep input time origin). */
  copyts?: boolean;
  /** Add `-avoid_negative_ts disabled` (needed with -copyts / negative origin). */
  avoidNegativeTs?: boolean;
}

/**
 * ENCODE stage (contract C, NUT variant): consume the NUT byte stream on stdin
 * and encode the video-only intermediate. `-fps_mode passthrough` is ALWAYS
 * present so the exact demux PTS survive; `-enc_time_base:v demux` pins the
 * encoder's time base to the NUT demuxer's (1/rate), avoiding any re-quantize.
 */
export function buildEncodeArgs(opts: EncodeArgsOptions): string[] {
  const preserve = opts.preserveTimestamps ?? true;
  const args: string[] = [];
  if (opts.ffmpeg) args.push(opts.ffmpeg);
  args.push("-hide_banner", "-loglevel", "warning", "-y");
  if (opts.copyts) args.push("-copyts");
  args.push("-f", "nut", "-i", "pipe:0", "-map", "0:v:0", "-an", "-fps_mode", "passthrough");
  if (preserve) args.push("-enc_time_base:v", "demux");
  if (opts.avoidNegativeTs) args.push("-avoid_negative_ts", "disabled");
  args.push(...opts.codecArgs, opts.output);
  return args;
}

// ---------------------------------------------------------------------------
// (2) Rational-PTS timeline + nearest-timestamp resample
// ---------------------------------------------------------------------------

export type FramingMode = "native" | "cascade";

export interface OutputFramePlan {
  /** "native" when targetRate == grid*sourceRate exactly, else "cascade". */
  mode: FramingMode;
  /** Frames the fine (dyadic/native) expansion produces per source interval. */
  grid: number;
  /** Number of output frames: ceil(duration * targetRate). */
  outputCount: number;
  /** Integer PTS (target time base 1/targetRate) for each output frame: 0..outputCount-1. */
  pts: bigint[];
  /**
   * For each output frame, the index into the fine-expanded source timeline
   * (0..fineCount-1) of the nearest generated/real frame. This is the
   * nearest-timestamp resample: the caller emits `sourceSelection[k]`'s pixels
   * at output PTS `pts[k]`. Repeated indices are legitimate duplicates.
   */
  sourceSelection: number[];
  /** Length of the fine-expanded source timeline: (N-1)*grid + 1 (N = input count). */
  fineCount: number;
}

/** True iff targetRate is exactly grid * sourceRate (integer native multiplier). */
export function isNativeGrid(sourceRate: Rational, targetRate: Rational, grid: number): boolean {
  if (grid < 2) return false;
  return ratCmp(targetRate, ratMul(sourceRate, rational(grid))) === 0;
}

/**
 * Plan the output-frame timeline for a frame-generation encode.
 *
 * @param inputPtsList  PTS of the input frames (target-agnostic; only the count
 *                      matters for CFR sources — the timeline is derived from
 *                      sourceRate). Must be non-empty.
 * @param sourceRate    Exact source frame rate.
 * @param targetRate    Exact target frame rate (e.g. 480 or 60000/1001).
 * @param grid          Fine-expansion multiplier: native_multiplier for the
 *                      native topology, or 1<<stages for a cascade. grid<=1 (or
 *                      targetRate<=sourceRate) is treated as passthrough.
 *
 * Fine timeline: N input frames at seconds j/sourceRate become (N-1)*grid+1
 * uniformly spaced frames at seconds i/(grid*sourceRate). Duration is
 * N/sourceRate (CFR), so outputCount = ceil(N/sourceRate * targetRate). Each
 * output slot k (time k/targetRate) selects the nearest fine frame:
 *   i = round( k * grid * sourceRate / targetRate ), clamped to [0, (N-1)*grid].
 * For the native grid this collapses to i=k for the dyadic frames plus grid-1
 * trailing duplicates of the last frame.
 */
export function planOutputFrames(
  inputPtsList: readonly bigint[],
  sourceRate: Rational,
  targetRate: Rational,
  grid: number,
): OutputFramePlan {
  const n = inputPtsList.length;
  if (n === 0) throw new Error("planOutputFrames: inputPtsList must be non-empty");
  if (sourceRate.num <= 0n || targetRate.num <= 0n) throw new Error("planOutputFrames: rates must be positive");

  // Passthrough: no frame generation (target not above source, or grid disabled).
  if (grid < 2 || ratCmp(targetRate, sourceRate) <= 0) {
    const pts: bigint[] = [];
    const sel: number[] = [];
    for (let i = 0; i < n; i++) {
      pts.push(BigInt(i));
      sel.push(i);
    }
    return { mode: "native", grid: 1, outputCount: n, pts, sourceSelection: sel, fineCount: n };
  }

  const N = BigInt(n);
  const g = BigInt(grid);
  const fineCount = (n - 1) * grid + 1;
  const fineMax = BigInt(fineCount - 1); // = (N-1)*grid

  // duration = N / sourceRate ; outputCount = ceil(duration * targetRate)
  //          = ceil( N * sourceRate.den * targetRate.num / (sourceRate.num * targetRate.den) )
  const ocNum = N * sourceRate.den * targetRate.num;
  const ocDen = sourceRate.num * targetRate.den;
  const outputCount = Number(ratCeil(rational(ocNum, ocDen)));

  // i_real(k) = k * grid * sourceRate / targetRate
  //           = k * grid * sourceRate.num * targetRate.den / (sourceRate.den * targetRate.num)
  const selNumBase = g * sourceRate.num * targetRate.den;
  const selDen = sourceRate.den * targetRate.num;

  const pts: bigint[] = new Array(outputCount);
  const sourceSelection: number[] = new Array(outputCount);
  for (let k = 0; k < outputCount; k++) {
    pts[k] = BigInt(k);
    let i = roundDiv(BigInt(k) * selNumBase, selDen);
    if (i < 0n) i = 0n;
    else if (i > fineMax) i = fineMax;
    sourceSelection[k] = Number(i);
  }

  const mode: FramingMode = isNativeGrid(sourceRate, targetRate, grid) ? "native" : "cascade";
  return { mode, grid, outputCount, pts, sourceSelection, fineCount };
}

/**
 * Convenience wrapper returning just the int64 PTS array (target time base) for
 * the output frames — the timeline stamped onto the NUT packets. Delegates to
 * planOutputFrames; use that for the nearest-timestamp source selection too.
 */
export function computeOutputTimestamps(
  inputPtsList: readonly bigint[],
  sourceRate: Rational,
  targetRate: Rational,
  grid: number,
): bigint[] {
  return planOutputFrames(inputPtsList, sourceRate, targetRate, grid).pts;
}

// ---------------------------------------------------------------------------
// (3) NVENC-availability probe planner + CPU fallback codec map
// ---------------------------------------------------------------------------

/** The NVENC encoder names we probe, in api-types EncodeSettings order. */
export const NVENC_CODECS = ["h264_nvenc", "hevc_nvenc", "av1_nvenc"] as const;
export type NvencCodec = (typeof NVENC_CODECS)[number];

/** Human-readable display names (mirrors reference encoder.py probe_nvenc_codecs). */
export const NVENC_DISPLAY_NAMES: Record<NvencCodec, string> = {
  h264_nvenc: "H.264 (NVIDIA NVENC)",
  hevc_nvenc: "H.265 (NVIDIA NVENC)",
  av1_nvenc: "AV1 (NVIDIA NVENC)",
};

/** NVENC encoder -> CPU sibling. AV1 has a secondary fallback (see cpuFallbackChain). */
export const NVENC_TO_CPU: Record<NvencCodec, string> = {
  h264_nvenc: "libx264",
  hevc_nvenc: "libx265",
  av1_nvenc: "libsvtav1",
};

/** Ordered CPU fallback chain for an NVENC codec (AV1: libsvtav1 then libaom-av1). */
export function cpuFallbackChain(codec: NvencCodec): string[] {
  return codec === "av1_nvenc" ? ["libsvtav1", "libaom-av1"] : [NVENC_TO_CPU[codec]];
}

/** Primary CPU sibling for an NVENC codec. */
export function cpuFallbackCodec(codec: NvencCodec): string {
  return NVENC_TO_CPU[codec];
}

export interface NvencProbeOptions {
  ffmpeg?: string;
  /** NVENC encoder to test. */
  codec: NvencCodec;
  /** Probe frame size (reference uses 256x256; re-probe at real WxH before committing). */
  width?: number;
  height?: number;
  /** CUDA/GPU ordinal to pin (`-gpu <n>`); omit to let ffmpeg pick. */
  gpu?: number;
}

/**
 * Build the ffmpeg args for a 1-frame lavfi encode to `-f null` (contract A):
 *   ffmpeg -v error -f lavfi -i color=size=WxH:rate=1 -frames:v 1 -c:v <codec> [-gpu N] -f null -
 * Success == exit code 0.
 */
export function buildNvencProbeArgs(opts: NvencProbeOptions): string[] {
  const w = opts.width ?? 256;
  const h = opts.height ?? 256;
  const args: string[] = [];
  if (opts.ffmpeg) args.push(opts.ffmpeg);
  args.push("-v", "error", "-f", "lavfi", "-i", `color=size=${w}x${h}:rate=1`, "-frames:v", "1", "-c:v", opts.codec);
  if (opts.gpu !== undefined) args.push("-gpu", String(opts.gpu));
  args.push("-f", "null", "-");
  return args;
}

export interface NvencProbePlan {
  codec: NvencCodec;
  displayName: string;
  /** Full ffmpeg probe argv (contract A). */
  args: string[];
  /** Ordered CPU codecs to try if the probe fails. */
  fallbackChain: string[];
}

/** Plan a single NVENC probe: the ffmpeg args plus the CPU fallback chain. */
export function planNvencProbe(opts: NvencProbeOptions): NvencProbePlan {
  return {
    codec: opts.codec,
    displayName: NVENC_DISPLAY_NAMES[opts.codec],
    args: buildNvencProbeArgs(opts),
    fallbackChain: cpuFallbackChain(opts.codec),
  };
}

/** Plan probes for every NVENC encoder (for the capability/UI probe pass). */
export function planAllNvencProbes(base: Omit<NvencProbeOptions, "codec"> = {}): NvencProbePlan[] {
  return NVENC_CODECS.map((codec) => planNvencProbe({ ...base, codec }));
}
