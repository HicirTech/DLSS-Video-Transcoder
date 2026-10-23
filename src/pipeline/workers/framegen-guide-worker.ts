/**
 * Guide-side worker for frame generation, in one of two roles:
 *
 *   - guide ("open"): owns one stage's motion-guide history — the optical-flow
 *     estimator with its own NVOFA session on this thread, the previous frame's
 *     segment/timestamp, and the scene-cut counter.
 *   - packer ("open-packer"): upsamples a stage's grid flow to render
 *     resolution, scales it and packs it as R16G16_FLOAT halves.
 *
 * Only the last cascade stage — 2^(stages-1) evaluations per source frame, the
 * bottleneck — is given a separate packer worker so its analysis and packing
 * overlap; earlier stages pack inline (packInline), because more busy threads
 * than the machine has cores only adds contention.
 *
 * Frames arrive as SharedArrayBuffer-backed RGBA (no copy); flow and packed
 * fields go back as transferred ArrayBuffers. The history is only correct
 * because the coordinator sends one request at a time, in stream order.
 */
import { createMotionEstimator, type MotionEstimator } from "../flow.ts";
import { flowGridSize } from "../flow-grid.ts";
import { packFlowResizedR16G16 } from "../flow-resize.ts";
import { FRAMEGEN_CUDA_DEVICE } from "../framegen-device.ts";
import { tryCreateNvofBackend } from "../nvof.ts";

/** Open the guide role: one stage's flow estimator and history. */
export interface GuideOpen {
  type: "open";
  width: number;
  height: number;
  /** Only the first stage discovers scene cuts; later stages inherit them as segment changes. */
  detectSourceCuts: boolean;
  /** Pack on this thread instead of handing the grid flow to a packer thread; openStages (framegen.ts) decides which stage gets one. */
  packInline: boolean;
}
/** Open the packer role for one stage's frame size. */
export interface PackerOpen {
  type: "open-packer";
  width: number;
  height: number;
}
/** Analyse one frame (Uint8Array over a SharedArrayBuffer, so posting it copies nothing). */
export interface GuidePrepare {
  type: "prepare";
  id: number;
  rgba: Uint8Array;
  segment: number;
  tsNum: bigint;
  tsDen: bigint;
}
/** Upsample and pack one grid flow, transferred in. */
export interface GuidePack {
  type: "pack";
  id: number;
  small: ArrayBuffer;
}
type GuideIn = GuideOpen | PackerOpen | GuidePrepare | GuidePack | { type: "close" };

/** How a guide estimates flow: on NVOFA, or on the CPU matcher with the reason NVOFA did not start. */
export interface GuideFlow {
  flow: "nvof" | "cpu";
  flowReason: string | null;
}
/** What the worker answers: "opened" (a guide's says how it estimates flow), one reply per request with its id, "closed", or "error". */
export type GuideOut =
  | ({ type: "opened" } & GuideFlow)
  | { type: "opened" }
  | { type: "prepared"; id: number; reset: boolean; segment: number; previousTsNum: bigint | null; previousTsDen: bigint | null; small: ArrayBuffer | null; half: ArrayBuffer | null; sceneCuts: number }
  | { type: "packed"; id: number; half: ArrayBuffer }
  | { type: "closed" }
  | { type: "error"; message: string };

declare const self: Worker;

const post = (message: GuideOut, transfer: Transferable[] = []): void => self.postMessage(message, transfer);

let estimator: MotionEstimator | null = null;
let detectSourceCuts = false;
let previous: { segment: number; tsNum: bigint; tsDen: bigint } | null = null;
let sceneCuts = 0;
let packInline = false;
let packer: { width: number; height: number; flowW: number; flowH: number } | null = null;

self.onmessage = (event: MessageEvent<GuideIn>) => {
  const m = event.data;
  try {
    if (m.type === "open") {
      const nvof = tryCreateNvofBackend(m.width, m.height, FRAMEGEN_CUDA_DEVICE);
      estimator = createMotionEstimator(m.width, m.height, nvof.backend ? { backend: nvof.backend } : {});
      detectSourceCuts = m.detectSourceCuts;
      packInline = m.packInline;
      post({ type: "opened", flow: nvof.backend ? "nvof" : "cpu", flowReason: nvof.reason });
    } else if (m.type === "open-packer") {
      // The same grid the estimators compute flow on (flowGridSize default long side).
      const { flowW, flowH } = flowGridSize(m.width, m.height);
      packer = { width: m.width, height: m.height, flowW, flowH };
      post({ type: "opened" });
    } else if (m.type === "prepare") {
      if (!estimator) throw new Error("frame-generation guide worker used before open");
      let segment = m.segment;
      // A segment change (timestamp discontinuity, or a cut found by an earlier stage) is a known reset.
      let forceReset = previous !== null && segment !== previous.segment;
      const guide = packInline
        ? (() => {
            const packed = estimator.processPacked(m.rgba, forceReset);
            return { small: null as Float32Array | null, half: packed.half, reset: packed.reset, sceneScore: packed.sceneScore, duplicate: packed.duplicate, confidence: packed.confidence };
          })()
        : estimator.analyzePacked(m.rgba, forceReset);
      if (previous !== null && detectSourceCuts && guide.reset && !forceReset) {
        segment = previous.segment + 1;
        forceReset = true;
        sceneCuts++;
      }
      const reset = previous === null || forceReset || guide.reset;
      const before = previous;
      previous = { segment, tsNum: m.tsNum, tsDen: m.tsDen };
      // Sent back transferred, not copied. Copy the grid flow first: transferring it must not detach a buffer the backend reuses.
      const small = guide.small ? (guide.small.slice().buffer as ArrayBuffer) : null;
      const half = guide.half ? (guide.half.buffer as ArrayBuffer) : null;
      const transfer: ArrayBuffer[] = [];
      if (small) transfer.push(small);
      if (half) transfer.push(half);
      post(
        {
          type: "prepared",
          id: m.id,
          reset,
          segment,
          previousTsNum: before ? before.tsNum : null,
          previousTsDen: before ? before.tsDen : null,
          small,
          half,
          sceneCuts,
        },
        transfer,
      );
    } else if (m.type === "pack") {
      if (!packer) throw new Error("frame-generation packer used before open");
      const packed = packFlowResizedR16G16(new Float32Array(m.small), packer.flowW, packer.flowH, packer.width, packer.height);
      post({ type: "packed", id: m.id, half: packed.buffer as ArrayBuffer }, [packed.buffer as ArrayBuffer]);
    } else if (m.type === "close") {
      estimator?.close();
      estimator = null;
      post({ type: "closed" });
    }
  } catch (error) {
    post({ type: "error", message: (error as Error).message ?? String(error) });
  }
};
