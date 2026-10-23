/**
 * Job worker: runs one image or video job off the server's main thread.
 * bun:ffi works inside workers, so the GPU session lives entirely here.
 */
import type { JobRequest } from "../server/api-types.ts";
import { JobCancelledError } from "./cancel.ts";
import { loadEngines } from "./engine-loader.ts";
import type { FrameTally, ProgressReporter } from "./frame-progress.ts";
import { processImage } from "./image.ts";

declare const self: Worker;

export interface RunMessage {
  type: "run";
  id: string;
  request: JobRequest;
  runtimeDir: string;
  appDataPath: string;
}

/**
 * Stop the running job cooperatively: the pipeline stops at its next frame,
 * tears down (children killed, GPU objects released, an owned partial output
 * deleted) and answers "cancelled" — unless it has already posted "finishing",
 * in which case it completes. Terminating the thread instead runs none of that.
 */
export interface CancelMessage {
  type: "cancel";
}

export type WorkerMessage =
  /** `frames` is what the status shows as framesDone and framesTotal: data, so the server never reads it back out of `message`. */
  | { type: "progress"; id: string; fraction: number; message: string; frames?: FrameTally }
  | { type: "log"; id: string; line: string }
  /** The job is past the point where a cancel can stop it; it ends done or failed. */
  | { type: "finishing"; id: string }
  | { type: "done"; id: string; output: string; detail: Record<string, unknown> }
  | { type: "failed"; id: string; error: string }
  | { type: "cancelled"; id: string };

/** Cancels the one job this worker runs; aborted by a CancelMessage. */
const jobCancellation = new AbortController();

function post(message: WorkerMessage): void {
  self.postMessage(message);
}

async function run(message: RunMessage): Promise<void> {
  const { id, request } = message;
  const log = (line: string) => post({ type: "log", id, line });
  const onFinishing = (): void => post({ type: "finishing", id });
  const postProgress: ProgressReporter = (fraction, text, frames) => post({ type: "progress", id, fraction, message: text, frames });
  // Video and frame generation tally once per frame, so those lines stay out of the log.
  const onProgress: ProgressReporter = (fraction, text, frames) => {
    postProgress(fraction, text, frames);
    if (frames === undefined) log(text);
  };
  // A still runs at most warmupFrames + 1 passes, so every pass line is logged.
  const onImageProgress: ProgressReporter = (fraction, text, frames) => {
    postProgress(fraction, text, frames);
    log(text);
  };
  try {
    await loadEngines({ sr: request.superResolution !== undefined, nr: request.neuralRendering !== undefined });
    if (request.kind === "image") {
      const result = await processImage({
        input: request.input,
        output: request.output,
        superResolution: request.superResolution,
        neuralRendering: request.neuralRendering,
        resize: request.resize,
        warmupFrames: request.warmupFrames,
        runtimeDir: message.runtimeDir,
        adapterUuid: request.adapterUuid,
        appDataPath: message.appDataPath,
        signal: jobCancellation.signal,
        onFinishing,
        onProgress: onImageProgress,
      });
      post({ type: "done", id, output: result.output, detail: { ...result } });
      return;
    }
    if (request.frameGen) {
      const { frameGenJobOptions, processFrameGen } = await import("./framegen.ts");
      const result = await processFrameGen(
        frameGenJobOptions(request, request.frameGen, { runtimeDir: message.runtimeDir, appDataPath: message.appDataPath, signal: jobCancellation.signal, onFinishing, onProgress }),
      );
      post({ type: "done", id, output: result.output, detail: { ...result } });
      return;
    }
    const { processVideo, videoJobOptions } = await import("./video.ts");
    const result = await processVideo(
      videoJobOptions(request, { runtimeDir: message.runtimeDir, appDataPath: message.appDataPath, signal: jobCancellation.signal, onFinishing, onProgress }),
    );
    post({ type: "done", id, output: result.output, detail: { ...result } });
  } catch (error) {
    // Thrown and caught on this thread: only the "cancelled" message crosses to the server.
    if (error instanceof JobCancelledError) {
      post({ type: "cancelled", id });
      return;
    }
    post({ type: "failed", id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
}

self.onmessage = (event: MessageEvent<RunMessage | CancelMessage>) => {
  if (event.data?.type === "run") void run(event.data);
  else if (event.data?.type === "cancel") jobCancellation.abort();
};
