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

function line(name: string, rc: number, extra: string): void {
  console.log(`${name.padEnd(52)} rc=${rc} ${extra}`);
}

const NONE: ScaleSettings = { mode: "none", factor: 1, width: 0, height: 0 };
const FACTOR2: ScaleSettings = { mode: "factor", factor: 2, width: 0, height: 0 };
const SIZE: ScaleSettings = { mode: "size", factor: 1, width: 1280, height: 1872 };
const settings = { ...DEFAULT_NR_SETTINGS };
const safe = (s: string): string => s.replace(/[^\w.-]/g, "_");

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
      for (const l of lines) console.log(`    ${l}`);
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

async function imageJob(name: string, steps: Steps, scale: ScaleSettings, nr = settings): Promise<void> {
  const output = join(outDir, `img-${safe(name)}.png`);
  const where = provenance();
  try {
    await processImage({ input: image, output, ...stepsOf(steps, scale, nr, "none"), runtimeDir, onProgress: where.onProgress });
    line(`image ${name}`, 0, `sha=${await sha(output)} bytes=${statSync(output).size}`);
  } catch (error) {
    line(`image ${name}`, 1, `error="${(error as Error).message.slice(0, 90)}"`);
  }
  where.print();
}

async function videoJob(name: string, steps: Steps, motion: MotionKind, scale: ScaleSettings, encode: EncodeSettings): Promise<void> {
  const output = join(outDir, `vid-${safe(name)}.${encode.container}`);
  const where = provenance();
  try {
    const r = await processVideo({ input: clip, output, ...stepsOf(steps, scale, settings, motion), encode, runtimeDir, onProgress: where.onProgress });
    // libx265 schedules frame-parallel threads non-deterministically, so its
    // bitstream differs run to run on identical input. Everything else here is
    // reproducible, so only this one reports structure instead of a hash.
    const digest = encode.codec === "hevc" ? "x265-nondeterministic" : streamHash(output);
    line(`video ${name}`, 0, `stream=${digest} ${r.width}x${r.height} frames=${r.frames} cuts=${r.sceneCuts}`);
  } catch (error) {
    line(`video ${name}`, 1, `error="${(error as Error).message.slice(0, 90)}"`);
  }
  where.print();
}

for (const engine of ["bypass", "nr", "sr"] as const) {
  for (const [scaleName, scale] of [["none", NONE], ["factor2", FACTOR2], ["size", SIZE]] as const) {
    await imageJob(`${engine} scale=${scaleName}`, engine, scale);
  }
}
await imageJob("nr all-settings", "nr", NONE, {
  ...settings,
  intensity: 1.5,
  style: 2,
  preset: 1,
  localTone: 0.5,
  localStructure: 1.5,
  skinStructure: 0,
  autoMask: true,
  uiCorrection: true,
});

for (const engine of ["bypass", "nr", "sr"] as const) {
  for (const motion of ["none", "flow"] as const) {
    await videoJob(`${engine} motion=${motion}`, engine, motion, engine === "sr" ? FACTOR2 : NONE, {
      codec: "h264",
      quality: 20,
      container: "mp4",
      copyAudio: false,
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
  await videoJob(`nr ${codec}/${container}`, "nr", "none", NONE, { codec, quality: 22, container, copyAudio: true });
}

await videoJob("nr scale=size copyAudio", "nr", "none", SIZE, { codec: "h264", quality: 20, container: "mp4", copyAudio: true });

// Both steps in one job, which a job of one engine could not run.
await imageJob("sr+nr scale=factor2", "sr+nr", FACTOR2);
for (const motion of ["none", "flow"] as const) {
  await videoJob(`sr+nr motion=${motion}`, "sr+nr", motion, FACTOR2, { codec: "h264", quality: 20, container: "mp4", copyAudio: false });
}
await videoJob("sr+nr h264_nvenc/mp4", "sr+nr", "none", FACTOR2, { codec: "h264_nvenc", quality: 22, container: "mp4", copyAudio: true });

process.exit(0);
