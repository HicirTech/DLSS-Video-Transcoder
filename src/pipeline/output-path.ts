/**
 * Where a job writes when its request names no output: next to the input, with
 * the engine (or tool) named between the stem and the extension.
 */
import { basename, dirname, extname, join } from "node:path";

/** `<input's folder>/<stem>.<suffix><extension>`, e.g. clip.mp4 -> clip.nr.mkv; `extension` carries its dot. */
export function defaultOutputPath(input: string, suffix: string, extension: string): string {
  return join(dirname(input), `${basename(input, extname(input))}.${suffix}${extension}`);
}
