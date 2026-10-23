/** The output path a command takes as its second positional, checked against the container the command writes. */
import { extname } from "node:path";
import { ENCODE_CONTAINERS, type EncodeSettings } from "../server/api-types.ts";
import { usageError } from "./usage-error.ts";

interface OutputContainer {
  /** The container the command writes. */
  container: EncodeSettings["container"];
  /** The command whose help page follows the error. */
  command: "video" | "fg";
  /** Why that container, as the error names it: "the container frame generation writes". */
  writes: string;
  /** Whether --container can switch to the container a misnamed output asks for, so the error may suggest it. */
  switchable: boolean;
}

/**
 * The output path, when one is given, must end in the container's extension: ffmpeg picks the muxer from the
 * name, while the audio codec and the mux flags follow the container, so a mismatch writes neither as asked.
 */
export function outputArgument(output: string | undefined, { container, command, writes, switchable }: OutputContainer): string | undefined {
  if (output === undefined) return undefined;
  const extension = extname(output).slice(1).toLowerCase();
  if (extension === container) return output;
  const named = switchable && (ENCODE_CONTAINERS as readonly string[]).includes(extension) ? ` or add --container ${extension}` : "";
  usageError(`output ${output} must end in .${container}, ${writes}; rename it${named}`, command);
}
