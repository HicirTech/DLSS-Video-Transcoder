/**
 * The flow of frames through one decode-worker / encode-worker run: each decoded frame goes
 * through the caller's per-frame step to the encode worker, whose acknowledgement gives the decode
 * worker credit for another, until both ends are drained and the encoder is told to finish. The two
 * video orchestrators (threaded-encode.ts, async-nr-encode.ts) differ only in that per-frame step,
 * so the credits, acknowledgements, progress line and finish condition live here, once. The run's
 * lifecycle (settling once, stopping, cleanup) is WorkerPairRun's.
 */
import { frameProgress } from "./frame-progress.ts";
import type { WorkerPairRun } from "./worker-pair-run.ts";
import type { DecodeCredit, DecodeOut, DecodeStart } from "./workers/decode-worker.ts";

/** What both encode workers answer, whatever else an "encoded" ack carries. */
type EncodeReply = { type: "opened" } | { type: "encoded" } | { type: "done" } | { type: "error"; message: string };

/** What a finished run reports. */
export interface FrameCounts {
  frames: number;
  sceneCuts: number;
}

/** One frame as the decode worker posted it. */
interface DecodedFrame {
  index: number;
  buf: ArrayBuffer;
}

interface FrameFlow<Ack extends { type: "encoded" }> {
  decodeWorker: Worker;
  encodeWorker: Worker;
  /** Posted to the decode worker once the encoder has opened. */
  decodeStart: Omit<DecodeStart, "type">;
  /** The decode worker's initial credit: the most frames in flight between decode and the encoder's acknowledgement. */
  creditWindow: number;
  totalFrames: number | null;
  onProgress: (fraction: number, message: string, frames?: number) => void;
  /**
   * Runs one decoded frame through the engine and posts the result to the encode worker; returns
   * whether the frame was a scene cut. `frameNumber` counts the frames already handed over, in
   * decode order. An exception fails the run as "engine: ...".
   */
  processFrame(frame: DecodedFrame, frameNumber: number): boolean;
  /** Called first for every reply from the encode worker, a stale one after a stop included. */
  onEncodeReply?(): void;
  /** Called for each "encoded" ack while the run is live, before the decode worker is given its credit. */
  onEncoded?(ack: Ack): void;
}

/** Installs both workers' message handlers, which drive `run` as the frames flow. */
export function connectFrameFlow<Ack extends { type: "encoded" }>(run: WorkerPairRun<FrameCounts>, flow: FrameFlow<Ack>): void {
  let handedOver = 0; // frames given to the encode worker
  let sceneCuts = 0;
  let decodeEnded = false;
  const finishIfDone = (): void => {
    if (run.running && decodeEnded && run.framesWritten === handedOver) run.finish();
  };
  const grantCredit = (frames: number): void => {
    const credit: DecodeCredit = { type: "credit", n: frames };
    flow.decodeWorker.postMessage(credit);
  };

  flow.encodeWorker.onmessage = (event: MessageEvent) => {
    const reply = event.data as EncodeReply | Ack;
    flow.onEncodeReply?.();
    if (reply.type === "encoded") run.recordEncoded();
    // After a stop the encoder may still answer "opened" or "encoded": neither may start the decoder or report progress.
    if (!run.active) return;
    if (reply.type === "opened") {
      const start: DecodeStart = { type: "start", ...flow.decodeStart };
      flow.decodeWorker.postMessage(start);
      grantCredit(flow.creditWindow);
    } else if (reply.type === "encoded") {
      flow.onEncoded?.(reply as Ack);
      if (!decodeEnded) grantCredit(1);
      const written = run.framesWritten;
      const { fraction, message } = frameProgress(written, flow.totalFrames);
      flow.onProgress(fraction, message, written);
      finishIfDone();
    } else if (reply.type === "done") {
      run.succeed({ frames: handedOver, sceneCuts });
    } else if (reply.type === "error") {
      run.fail(`encode: ${reply.message}`);
    }
  };

  flow.decodeWorker.onmessage = (event: MessageEvent<DecodeOut>) => {
    const message = event.data;
    if (!run.active) return;
    if (message.type === "frame") {
      try {
        if (flow.processFrame(message, handedOver)) sceneCuts++;
        handedOver++;
      } catch (error) {
        run.fail(`engine: ${(error as Error).message}`);
      }
    } else if (message.type === "end") {
      decodeEnded = true;
      finishIfDone();
    } else if (message.type === "error") {
      run.fail(`decode: ${message.message}`);
    }
  };
}
