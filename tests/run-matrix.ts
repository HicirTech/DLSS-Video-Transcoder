/**
 * Manual harness (not part of `bun test`): the server-side job paths across
 * steps x scale x motion x codec x container — processImage, which no CLI
 * command runs, and processVideo, which the video command runs one combination
 * at a time. Prints one line per combination with the output hash, so a
 * refactor can be compared line by line. The rows named after an engine (bypass,
 * nr, sr) are the combinations jobs ran before each step had its own switch, and
 * keep their names so a baseline from then still lines up.
 *
 *   bun run tests/run-matrix.ts <outDir> <clip.mp4> <image.png>
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
// Both engines must be registered before engine.ts can construct them; a job
// or the video command imports the one it runs through src/pipeline/engine-loader.ts.
import "../src/ngx/nr.ts";
import "../src/ngx/sr-engine.ts";
import { DEFAULT_RUNTIME_DIR } from "../src/paths.ts";
import { processImage } from "../src/pipeline/image.ts";
import { findTool } from "../src/pipeline/tools.ts";
import { processVideo } from "../src/pipeline/video.ts";
import { DEFAULT_NR_SETTINGS, type EncodeSettings, type MotionKind, type NeuralRenderingStep, type NrSettings, type ScaleSettings, type SuperResolutionStep } from "../src/server/api-types.ts";

const [outDir, clip, image] = Bun.argv.slice(2) as [string, string, string];
const runtimeDir = DEFAULT_RUNTIME_DIR;

async function sha(path: string): Promise<string> {
  try {
    return createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex").slice(0, 16);
  } catch {
    return "MISSING";
  }
}

/**
 * MD5 of the elementary stream, container metadata excluded. Matroska stamps a
 * random Segment UID per mux, so two identical encodes never share a file hash;
 * this is what actually proves a refactor left the pixels alone.
 */
function streamHash(path: string): string {
  // The ffmpeg the pipeline itself found: processVideo has already refused the row when there is none.
  const ffmpeg = findTool("ffmpeg");
  if (ffmpeg === null) return "NOFFMPEG";
  try {
    const proc = Bun.spawnSync([ffmpeg, "-v", "error", "-i", path, "-map", "0:v:0", "-c", "copy", "-f", "md5", "-"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return `HASHFAIL(exit ${proc.exitCode})`;
    const out = new TextDecoder().decode(proc.stdout).trim();
    return out.startsWith("MD5=") ? out.slice(4, 20) : "NOSTREAM";
  } catch (error) {
    return `HASHFAIL(${(error as Error).message.slice(0, 40)})`;
  }
}

function line(name: string, exitCode: number, extra: string): void {
  console.log(`${name.padEnd(52)} rc=${exitCode} ${extra}`);
}

/** An error row keeps the first ERROR_MESSAGE_CHARS characters of its message. */
const ERROR_MESSAGE_CHARS = 90;

function failureLine(name: string, error: unknown): void {
  line(name, 1, `error="${(error as Error).message.slice(0, ERROR_MESSAGE_CHARS)}"`);
}

const NONE: ScaleSettings = { mode: "none", factor: 1, width: 0, height: 0 };
const FACTOR2: ScaleSettings = { mode: "factor", factor: 2, width: 0, height: 0 };
const SIZE: ScaleSettings = { mode: "size", factor: 1, width: 1280, height: 1872 };
const settings = { ...DEFAULT_NR_SETTINGS };
const safe = (name: string): string => name.replace(/[^\w.-]/g, "_");

/**
 * Progress lines that say WHERE a row ran — the GPU (adapter, LUID, CUDA
 * device) and the encode / optical-flow path taken. A hash alone cannot show
 * that a job picked a different DXGI entry of the same GPU, so each row is
 * followed by these lines and a baseline diff shows a changed pick.
 */
function provenance(): { onProgress: (fraction: number, message: string) => void; print: () => void } {
  const lines: string[] = [];
  return {
    onProgress: (_fraction, message) => {
      if (/^(GPU: |encode: |optical flow: )/.test(message)) lines.push(message);
    },
    print: () => {
      for (const message of lines) console.log(`    ${message}`);
    },
  };
}

/** A job's steps and resize: an engine name for what a job of one engine ran (see the header), or "sr+nr" for both steps. */
type Steps = "bypass" | "nr" | "sr" | "sr+nr";

/** bypass is no step with the scale as a resize, nr Neural Rendering with it as a resize, sr Super Resolution to it. */
function stepsOf(steps: Steps, scale: ScaleSettings, nr: NrSettings, motion: MotionKind): { superResolution?: SuperResolutionStep; neuralRendering?: NeuralRenderingStep; resize?: ScaleSettings } {
  const superResolution = steps === "sr" || steps === "sr+nr" ? { scale, motion } : undefined;
  const neuralRendering = steps === "nr" || steps === "sr+nr" ? { settings: nr } : undefined;
  return { superResolution, neuralRendering, resize: superResolution ? undefined : scale };
}

async function imageJob({ name, steps, scale, nr = settings }: { name: string; steps: Steps; scale: ScaleSettings; nr?: NrSettings }): Promise<void> {
  const output = join(outDir, `img-${safe(name)}.png`);
  const where = provenance();
  try {
    await processImage({ input: image, output, ...stepsOf(steps, scale, nr, "none"), runtimeDir, onProgress: where.onProgress });
    line(`image ${name}`, 0, `sha=${await sha(output)} bytes=${statSync(output).size}`);
  } catch (error) {
    failureLine(`image ${name}`, error);
  }
  where.print();
}

async function videoJob({ name, steps, motion, scale, encode }: { name: string; steps: Steps; motion: MotionKind; scale: ScaleSettings; encode: EncodeSettings }): Promise<void> {
  const output = join(outDir, `vid-${safe(name)}.${encode.container}`);
  const where = provenance();
  try {
    const result = await processVideo({ input: clip, output, ...stepsOf(steps, scale, settings, motion), encode, runtimeDir, onProgress: where.onProgress });
    // libx265 schedules frame-parallel threads non-deterministically, so its
    // bitstream differs run to run on identical input. Everything else here is
    // reproducible, so only this one reports structure instead of a hash.
    const digest = encode.codec === "hevc" ? "x265-nondeterministic" : streamHash(output);
    line(`video ${name}`, 0, `stream=${digest} ${result.width}x${result.height} frames=${result.frames} cuts=${result.sceneCuts}`);
  } catch (error) {
    failureLine(`video ${name}`, error);
  }
  where.print();
}

for (const engine of ["bypass", "nr", "sr"] as const) {
  for (const [scaleName, scale] of [["none", NONE], ["factor2", FACTOR2], ["size", SIZE]] as const) {
    await imageJob({ name: `${engine} scale=${scaleName}`, steps: engine, scale });
  }
}
// Intensity at or below NR_INTENSITY_EFFECTIVE_MAX, where the runtime still responds to it, so a value that is not
// passed on shows in the hash; preset, skinStructure and uiCorrection are in NR_SETTINGS_IGNORED_BY_RUNTIME.
await imageJob({
  name: "nr all-settings",
  steps: "nr",
  scale: NONE,
  nr: {
    ...settings,
    intensity: 0.5,
    style: 2,
    preset: 1,
    localTone: 0.5,
    localStructure: 1.5,
    skinStructure: 0,
    autoMask: true,
    uiCorrection: true,
  },
});

for (const engine of ["bypass", "nr", "sr"] as const) {
  for (const motion of ["none", "flow"] as const) {
    await videoJob({
      name: `${engine} motion=${motion}`,
      steps: engine,
      motion,
      scale: engine === "sr" ? FACTOR2 : NONE,
      encode: { codec: "h264", quality: 20, container: "mp4", copyAudio: false },
    });
  }
}

for (const [codec, container] of [
  ["h264", "mp4"],
  ["hevc", "mkv"],
  ["h264_nvenc", "mp4"],
  ["hevc_nvenc", "mov"],
  ["av1_nvenc", "mp4"],
] as const) {
  await videoJob({ name: `nr ${codec}/${container}`, steps: "nr", motion: "none", scale: NONE, encode: { codec, quality: 22, container, copyAudio: true } });
}

await videoJob({ name: "nr scale=size copyAudio", steps: "nr", motion: "none", scale: SIZE, encode: { codec: "h264", quality: 20, container: "mp4", copyAudio: true } });

// Both steps in one job, which a job of one engine could not run.
await imageJob({ name: "sr+nr scale=factor2", steps: "sr+nr", scale: FACTOR2 });
for (const motion of ["none", "flow"] as const) {
  await videoJob({ name: `sr+nr motion=${motion}`, steps: "sr+nr", motion, scale: FACTOR2, encode: { codec: "h264", quality: 20, container: "mp4", copyAudio: false } });
}
await videoJob({ name: "sr+nr h264_nvenc/mp4", steps: "sr+nr", motion: "none", scale: FACTOR2, encode: { codec: "h264_nvenc", quality: 22, container: "mp4", copyAudio: true } });

process.exit(0);
