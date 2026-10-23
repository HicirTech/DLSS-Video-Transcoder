/**
 * Where a job writes: next to the input when its request names no output, with the steps (or tool) named between
 * the stem and the extension, and never over the input itself.
 */
import { basename, dirname, extname, join, resolve } from "node:path";

/** `<input's folder>/<stem>.<suffix><extension>`, e.g. clip.mp4 -> clip.nr.mkv; `extension` carries its dot. */
export function defaultOutputPath(input: string, suffix: string, extension: string): string {
  return join(dirname(input), `${basename(input, extname(input))}.${suffix}${extension}`);
}

/**
 * Why a job may not write to `output`, or null when it may: an output naming the input would destroy the source, as
 * the encoder truncates its output while the decoder is still reading the input.
 */
export function inputAsOutputProblem(input: string, output: string): string | null {
  // resolve() settles separators and "..", and Windows compares file names without regard to case.
  if (resolve(input).toLowerCase() !== resolve(output).toLowerCase()) return null;
  return `The output path ${output} is the input file itself, which the job would overwrite while reading it. Choose another output path, or leave it out to write next to the input under the default name.`;
}
