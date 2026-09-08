/**
 * Job worker: runs one image or video job off the server's main thread.
 * bun:ffi works inside workers, so the GPU session lives entirely here.
 *
 * Messages in:  { type: "run", id, request: JobRequest, runtimeDir, appDataPath }
 * Messages out: { type: "progress", id, fraction, message }
 *               { type: "log", id, line }
 *               { type: "done", id, output, detail }
 *               { type: "failed", id, error }
 */
import type { JobRequest } from "../server/api-types.ts";
import { processImage } from "./image.ts";

declare const self: Worker;

export interface RunMessage {
  type: "run";
  id: string;
  request: JobRequest;
  runtimeDir: string;
  appDataPath: string;
}

export type WorkerMessage =
  | { type: "progress"; id: string; fraction: number; message: string }
  | { type: "log"; id: string; line: string }
  | { type: "done"; id: string; output: string; detail: Record<string, unknown> }
  | { type: "failed"; id: string; error: string };

function post(message: WorkerMessage): void {
  self.postMessage(message);
}

async function run(message: RunMessage): Promise<void> {
  const { id, request } = message;
  const log = (line: string) => post({ type: "log", id, line });
  try {
    if (request.engine === "nr") {
      // Registers the neural engine with the engine factory (kept out of the
      // bypass path so a missing runtime never blocks plumbing checks).
      await import("../ngx/nr.ts");
    } else if (request.engine === "sr") {
      await import("../ngx/sr-engine.ts");
    }
    if (request.kind === "image") {
      const result = await processImage({
        input: request.input,
        output: request.output,
        engine: request.engine,
        scale: request.scale,
        settings: request.settings,
        runtimeDir: message.runtimeDir,
        appDataPath: message.appDataPath,
        onProgress: (fraction, text) => {
          post({ type: "progress", id, fraction, message: text });
          log(text);
        },
      });
      post({ type: "done", id, output: result.output, detail: { ...result } });
      return;
    }
    if (request.frameGen) {
      const { processFrameGen } = await import("./framegen.ts");
      const result = await processFrameGen({
        input: request.input,
        output: request.output,
        multiplier: request.frameGen.multiplier,
        quality: request.encode?.quality,
        codec: request.encode?.codec,
        runtimeDir: message.runtimeDir,
        onProgress: (fraction, text, frames) => {
          post({ type: "progress", id, fraction, message: text });
          if (frames === undefined) log(text);
        },
      });
      post({ type: "done", id, output: result.output, detail: { ...result } });
      return;
    }
    const { processVideo } = await import("./video.ts");
    const result = await processVideo({
      input: request.input,
      output: request.output,
      engine: request.engine,
      motion: request.motion,
      scale: request.scale,
      settings: request.settings,
      encode: request.encode,
      runtimeDir: message.runtimeDir,
      appDataPath: message.appDataPath,
      onProgress: (fraction, text, frames) => {
        post({ type: "progress", id, fraction, message: text });
        if (frames === undefined) log(text);
      },
    });
    post({ type: "done", id, output: result.output, detail: { ...result } });
  } catch (error) {
    post({ type: "failed", id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
}

self.onmessage = (event: MessageEvent<RunMessage>) => {
  if (event.data?.type === "run") void run(event.data);
};
