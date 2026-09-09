/**
 * Guide-stage worker for frame generation: one per DLSSG stage.
 *
 * Owns that stage's motion-guide history — the optical-flow estimator (with its
 * own NVOFA session on this thread), the previous frame's segment/timestamp,
 * and the scene-cut / duplicate decisions — so the ~12 ms of CPU work per
 * evaluation runs off the main thread and in parallel across stages while the
 * main thread keeps the dlssg-worker pipes busy. Frames arrive as
 * SharedArrayBuffer-backed RGBA (no copy); the packed R16G16_FLOAT motion goes
 * back as a transferred ArrayBuffer. The coordinator sends one "prepare" at a
 * time per worker, in stream order, which is what keeps the history correct.
 */
import { createMotionEstimator, type MotionEstimator } from "../flow.ts";
import { tryCreateNvofBackend } from "../nvof.ts";

interface OpenMsg {
  type: "open";
  width: number;
  height: number;
  /** Only the first stage discovers scene cuts; later stages inherit them as segment changes. */
  detectSourceCuts: boolean;
  ordinal?: number;
}
interface PrepareMsg {
  type: "prepare";
  id: number;
  rgba: Uint8Array;
  segment: number;
  tsNum: bigint;
  tsDen: bigint;
}
type InMsg = OpenMsg | PrepareMsg | { type: "close" };

declare const self: Worker;

let estimator: MotionEstimator | null = null;
let detectSourceCuts = false;
let previous: { segment: number; tsNum: bigint; tsDen: bigint } | null = null;
let sceneCuts = 0;
let duplicates = 0;

self.onmessage = (event: MessageEvent<InMsg>) => {
  const m = event.data;
  try {
    if (m.type === "open") {
      const nvof = tryCreateNvofBackend(m.width, m.height, undefined, m.ordinal ?? 0);
      estimator = createMotionEstimator(m.width, m.height, nvof ? { backend: nvof } : {});
      detectSourceCuts = m.detectSourceCuts;
      self.postMessage({ type: "opened", flow: nvof ? "nvof" : "cpu" });
    } else if (m.type === "prepare") {
      if (!estimator) throw new Error("frame-generation guide worker used before open");
      let segment = m.segment;
      // A segment change (timestamp discontinuity, or a cut found by an earlier stage) is a known reset.
      let forceReset = previous !== null && segment !== previous.segment;
      const guide = estimator.processPacked(m.rgba, forceReset);
      if (previous !== null && detectSourceCuts && guide.reset && !forceReset) {
        segment = previous.segment + 1;
        forceReset = true;
        sceneCuts++;
      }
      if (previous !== null && guide.duplicate) duplicates++;
      const reset = previous === null || forceReset || guide.reset;
      const before = previous;
      previous = { segment, tsNum: m.tsNum, tsDen: m.tsDen };
      const half = guide.half;
      self.postMessage(
        {
          type: "prepared",
          id: m.id,
          reset,
          segment,
          previousTsNum: before ? before.tsNum : null,
          previousTsDen: before ? before.tsDen : null,
          half: half ? half.buffer : null,
          sceneCuts,
          duplicates,
        },
        half ? [half.buffer as ArrayBuffer] : [],
      );
    } else if (m.type === "close") {
      estimator?.close();
      estimator = null;
      self.postMessage({ type: "closed" });
    }
  } catch (error) {
    self.postMessage({ type: "error", message: (error as Error).message ?? String(error) });
  }
};
