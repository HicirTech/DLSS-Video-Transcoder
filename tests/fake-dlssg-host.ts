/**
 * A dlssg-host stand-in for tests: the real serve loop and stdout claim over a scripted generator, so
 * tests/dlssg-host.test.ts can drive the protocol through real pipes and a real shared mapping without
 * a GPU. The generator checks that frame i arrived in the shared input slot as rgba bytes i and motion
 * bytes i + 128, answers with frames whose bytes say (i, k), and on every call writes to stdout through
 * console methods that Bun 1.4.2 prints there, and through process.stdout.
 *
 *   bun tests/fake-dlssg-host.ts --shared NAME [--maximum M] [--refuse STATUS] [--disabled-at I] [--fail-at I] [--short-at I]
 */
import type { DlssgIntervalInput, DlssgIntervalResult } from "../src/ngx/dlssg-feature.ts";
import type { DlssgSetup } from "../src/pipeline/dlssg-protocol.ts";
import { claimStdout, serveDlssg, type GeneratorOpening } from "../src/pipeline/dlssg-serve.ts";

function textOption(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]! : null;
}

function option(name: string): number | null {
  const text = textOption(name);
  return text === null ? null : Number(text);
}

/** The byte every pixel of generated frame k (1-based) of source frame i carries. */
export function generatedByte(frameId: number, index: number): number {
  return (frameId * 8 + index) & 0xff;
}

export function rgbaByte(frameId: number): number {
  return frameId & 0xff;
}

export function motionByte(frameId: number): number {
  return (frameId + 128) & 0xff;
}

function checkPayload(input: DlssgIntervalInput): void {
  if (!input.rgba.every((value) => value === rgbaByte(input.frameId)) || !input.motion.every((value) => value === motionByte(input.frameId))) {
    throw new Error(`source frame ${input.frameId} arrived misframed`);
  }
}

function writeNoise(frameId: number): void {
  console.log(`noise from console.log at source frame ${frameId}`);
  console.dirxml(`noise from console.dirxml at source frame ${frameId}`);
  console.table([frameId]);
  console.count("noise from console.count");
  console.group(`noise from console.group at source frame ${frameId}`);
  console.groupEnd();
  console.trace(`noise from console.trace at source frame ${frameId}`);
  console.write(`noise from console.write at source frame ${frameId}\n`);
  process.stdout.write(`noise from process.stdout at source frame ${frameId}\n`);
}

function interval(input: DlssgIntervalInput): DlssgIntervalResult {
  writeNoise(input.frameId);
  checkPayload(input);
  if (input.frameId === option("--fail-at")) throw new Error(`scripted failure at source frame ${input.frameId}`);
  if (input.reset) return { outcome: "reset" };
  if (input.frameId === option("--disabled-at")) return { outcome: "disabled" };
  const frameCount = input.frameId === option("--short-at") ? input.generatedCount - 1 : input.generatedCount;
  const frames = Array.from({ length: frameCount }, (_, index) => new Uint8Array(input.rgba.byteLength).fill(generatedByte(input.frameId, index + 1)));
  return { outcome: "generated", frames };
}

function open(setup: DlssgSetup): GeneratorOpening {
  console.info(`noise from console.info at setup ${setup.width}x${setup.height}`);
  const refusal = option("--refuse");
  if (refusal !== null) return { outcome: "refused", status: refusal, reason: "scripted refusal" };
  return { outcome: "opened", generator: { maximum: option("--maximum") ?? 5, interval, close: () => console.error("fake generator closed") } };
}

if (import.meta.main) {
  const stdout = claimStdout();
  const sharedMemoryName = textOption("--shared");
  if (sharedMemoryName === null) throw new Error("fake-dlssg-host needs --shared NAME, the shared memory the test created");
  process.exit(serveDlssg(stdout, sharedMemoryName, open));
}
