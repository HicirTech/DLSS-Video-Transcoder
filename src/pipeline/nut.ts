/**
 * NUT + rational-PTS framing for the frame-generation encode path: ffmpeg argv
 * builders plus the int64 PTS timeline and nearest-timestamp resample, in exact
 * bigint rational arithmetic. Pure — nothing here spawns ffmpeg or touches a
 * GPU; video.ts wires the args to Bun.spawn and feeds the frame bytes. The
 * three process contracts referred to below are A (NVENC probe), B (decode to
 * raw frames) and C (encode the video-only intermediate).
 *
 * Why NUT at all: a bare `rawvideo` stream with `-r <fps>` stamps one constant
 * rate over whatever frames arrive, so it cannot carry a per-frame timeline
 * when the output frame count differs from the input's (DLSSG 2x/3x/4x native,
 * or a cascade + nearest-timestamp resample). A NUT container keeps the exact
 * rational clock (e.g. 60000/1001) end to end, so Matroska/MP4 millisecond
 * timebase rounding never touches it. See
 * ai-context/dlss5-visual-enhancer/core-ffmpeg.md.
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

/** Normalizing constructor — every Rational in this module is reduced with den > 0. */
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
 * Parse an ffmpeg rate string: `"60000/1001"`, `"24"` or `"23.976"`. A decimal
 * becomes an exact fraction over a power of ten — never a float, so a rate that
 * came in as text survives the round trip bit-exact.
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

export function ratMul(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

export function ratDiv(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den, a.den * b.num);
}

/** -1 if a<b, 0 if equal, 1 if a>b. */
export function ratCmp(a: Rational, b: Rational): number {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

/** Ceiling. Negatives take the first branch because bigint `/` truncates toward zero, which already ceils them. */
export function ratCeil(r: Rational): bigint {
  if (r.num <= 0n) return r.num / r.den;
  return (r.num + r.den - 1n) / r.den;
}

export function ratAdd(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function ratSub(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function ratAbs(r: Rational): Rational {
  return r.num < 0n ? { num: -r.num, den: r.den } : r;
}

/** Floor: toward negative infinity, unlike bigint `/`. */
export function ratFloor(r: Rational): bigint {
  const q = r.num / r.den;
  return r.num < 0n && r.num % r.den !== 0n ? q - 1n : q;
}

/** r as a JS number (lossy; for display and float-only consumers such as ffmpeg -r). */
export function ratToNumber(r: Rational): number {
  return Number(r.num) / Number(r.den);
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
  /** ffmpeg binary; prepended as argv[0] when provided, so the result is a full argv. */
  ffmpeg?: string;
  input: string;
  /** Rescale to the engine's working size during decode, so no CPU resize is needed. */
  scale?: { width: number; height: number };
  /** Raw pixel format for the engine; default "rgba". */
  pixFmt?: string;
}

/**
 * DECODE stage (contract B): source video-only stream to raw frames on stdout in
 * presentation order. `-fps_mode passthrough` is what keeps every source frame
 * exactly once — the default would drop or duplicate to hit a constant rate.
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
  width: number;
  height: number;
  /** Exact rational target rate; a string is passed to ffmpeg as-is. */
  rate: Rational | string;
  /** Raw pixel format arriving on stdin; default "rgba". */
  pixFmt?: string;
}

/**
 * rawvideo -> NUT pre-stage, CFR frame-gen only: the rawvideo demuxer's
 * `-framerate` stamps PTS = n/rate at the exact rational, and `-c:v copy` puts
 * that clock into a NUT byte stream for the encode stage's `-f nut -i pipe:0`.
 *
 * CFR only, because the demuxer derives every PTS from the one rate. Arbitrary
 * per-packet PTS (the nearest-timestamp/VFR writer, values from
 * computeOutputTimestamps) needs a real NUT muxer instead.
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
  /** Video-only intermediate output path (a `.nut` temp file); audio is muxed in a later pass. */
  output: string;
  /** Codec + quality args, owned by video.ts and inserted verbatim. */
  codecArgs: string[];
  /**
   * Add `-enc_time_base:v demux`. Default true — this is the point of the NUT
   * path. False for the plain `-framerate` CFR variant, where `-fps_mode
   * passthrough` alone already carries the PTS.
   */
  preserveTimestamps?: boolean;
  /** Add `-copyts` (keep the input time origin). */
  copyts?: boolean;
  /** Add `-avoid_negative_ts disabled`; required once `-copyts` lets the origin go negative. */
  avoidNegativeTs?: boolean;
}

/**
 * ENCODE stage (contract C, NUT variant): NUT byte stream on stdin to the
 * video-only intermediate. `-fps_mode passthrough` is ALWAYS present so the
 * demux PTS survive; `-enc_time_base:v demux` pins the encoder's time base to
 * the demuxer's 1/rate so nothing re-quantizes it.
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
  /** ceil(duration * targetRate). */
  outputCount: number;
  /** Integer PTS in the target time base 1/targetRate, i.e. 0..outputCount-1. */
  pts: bigint[];
  /**
   * The nearest-timestamp resample: output frame k emits the pixels of fine
   * frame `sourceSelection[k]` (an index into the 0..fineCount-1 expanded source
   * timeline) at PTS `pts[k]`. Repeated indices are legitimate duplicates, not a
   * bug — they are how a non-integer rate ratio holds a frame.
   */
  sourceSelection: number[];
  /** Length of the fine-expanded source timeline: (N-1)*grid + 1 for N inputs. */
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
 * N input frames at seconds j/sourceRate expand to (N-1)*grid+1 uniformly
 * spaced frames at seconds i/(grid*sourceRate); output slot k (time
 * k/targetRate) then takes the nearest of those, clamped to the last one. On a
 * native grid that collapses to i=k plus grid-1 trailing duplicates of the last
 * frame — the tail the fine expansion cannot reach, since interpolation needs a
 * following source frame.
 *
 * @param inputPtsList  Only the count is read: the timeline comes from
 *                      sourceRate, so the source must be CFR. Non-empty.
 * @param sourceRate    Exact source frame rate.
 * @param targetRate    Exact target frame rate (e.g. 480 or 60000/1001).
 * @param grid          Fine-expansion multiplier: native_multiplier for the
 *                      native topology, or 1<<stages for a cascade. grid<=1 (or
 *                      targetRate<=sourceRate) is treated as passthrough.
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
 * Just the int64 PTS to stamp onto the NUT packets. Callers that also need to
 * know *which* frame goes at each PTS want planOutputFrames instead.
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

/** The NVENC encoders we probe. Order matches EncodeSettings["codec"] in api-types.ts. */
export const NVENC_CODECS = ["h264_nvenc", "hevc_nvenc", "av1_nvenc"] as const;
export type NvencCodec = (typeof NVENC_CODECS)[number];

/** Display names, kept identical to the reference encoder.py `probe_nvenc_codecs` strings. */
export const NVENC_DISPLAY_NAMES: Record<NvencCodec, string> = {
  h264_nvenc: "H.264 (NVIDIA NVENC)",
  hevc_nvenc: "H.265 (NVIDIA NVENC)",
  av1_nvenc: "AV1 (NVIDIA NVENC)",
};

/** NVENC encoder -> the CPU encoder producing the same format. */
export const NVENC_TO_CPU: Record<NvencCodec, string> = {
  h264_nvenc: "libx264",
  hevc_nvenc: "libx265",
  av1_nvenc: "libsvtav1",
};

/** Ordered CPU fallbacks: AV1 lists two because an ffmpeg build may carry either encoder. */
export function cpuFallbackChain(codec: NvencCodec): string[] {
  return codec === "av1_nvenc" ? ["libsvtav1", "libaom-av1"] : [NVENC_TO_CPU[codec]];
}

/** First CPU fallback only; cpuFallbackChain is the full ordered list. */
export function cpuFallbackCodec(codec: NvencCodec): string {
  return NVENC_TO_CPU[codec];
}

export interface NvencProbeOptions {
  ffmpeg?: string;
  codec: NvencCodec;
  /**
   * Probe frame size; default 256x256, as in the reference. A pass here only
   * proves the encoder exists — NVENC size caps are per codec and per chip, so
   * re-probe at the real WxH before committing to it.
   */
  width?: number;
  height?: number;
  /** CUDA/GPU ordinal to pin (`-gpu <n>`); omit to let ffmpeg pick. */
  gpu?: number;
}

/**
 * ffmpeg args for a one-frame lavfi encode to `-f null` (contract A). The probe
 * has to actually encode: NVENC failures surface at session open, not from
 * `-encoders` listing the name. Success == exit code 0.
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
