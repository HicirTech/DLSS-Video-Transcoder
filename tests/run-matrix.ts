/**
 * Manual harness (not part of `bun test`): the server-side job paths the CLI
 * cannot reach — processImage and processVideo across engine x scale x motion x
 * codec x container. Prints one line per combination with the output hash, so a
 * refactor can be compared line by line.
 *
 *   bun run tests/run-matrix.ts <outDir> <clip.mp4> <image.png>
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
// Both engines must be registered before engine.ts can construct them; the job
// worker does the same two imports at src/pipeline/worker.ts:36-37.
import "../src/ngx/nr.ts";
import "../src/ngx/sr-engine.ts";
import { processImage } from "../src/pipeline/image.ts";
import { processVideo } from "../src/pipeline/video.ts";
import { DEFAULT_NR_SETTINGS, type EncodeSettings, type ScaleSettings } from "../src/server/api-types.ts";

const ROOT = join(import.meta.dir, "..");
const [outDir, clip, image] = Bun.argv.slice(2) as [string, string, string];
const runtimeDir = join(ROOT, "runtime");

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
  const ffmpeg = join(ROOT, "runtime", "ffmpeg", "bin", "ffmpeg.exe");
  try {
    const proc = Bun.spawnSync([ffmpeg, "-v", "error", "-i", path, "-map", "0:v:0", "-c", "copy", "-f", "md5", "-"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new TextDecoder().decode(proc.stdout).trim();
    return out.startsWith("MD5=") ? out.slice(4, 20) : "NOSTREAM";
  } catch {
    return "NOSTREAM";
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

async function imageJob(name: string, engine: "bypass" | "nr" | "sr", scale: ScaleSettings, nr = settings): Promise<void> {
  const output = join(outDir, `img-${safe(name)}.png`);
  try {
    await processImage({ input: image, output, engine, scale, settings: nr, runtimeDir });
    line(`image ${name}`, 0, `sha=${await sha(output)} bytes=${statSync(output).size}`);
  } catch (error) {
    line(`image ${name}`, 1, `error="${(error as Error).message.slice(0, 90)}"`);
  }
}

async function videoJob(
  name: string,
  engine: "bypass" | "nr" | "sr",
  motion: "none" | "flow",
  scale: ScaleSettings,
  encode: EncodeSettings,
): Promise<void> {
  const output = join(outDir, `vid-${safe(name)}.${encode.container}`);
  try {
    const r = await processVideo({ input: clip, output, engine, motion, scale, settings, encode, runtimeDir });
    // libx265 schedules frame-parallel threads non-deterministically, so its
    // bitstream differs run to run on identical input. Everything else here is
    // reproducible, so only this one reports structure instead of a hash.
    const digest = encode.codec === "hevc" ? "x265-nondeterministic" : streamHash(output);
    line(`video ${name}`, 0, `stream=${digest} ${r.width}x${r.height} frames=${r.frames} cuts=${r.sceneCuts}`);
  } catch (error) {
    line(`video ${name}`, 1, `error="${(error as Error).message.slice(0, 90)}"`);
  }
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

process.exit(0);
