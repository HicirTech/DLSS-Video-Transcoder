/**
 * How a stage's guide and packer workers start and end (src/pipeline/framegen-stage.ts): a failed open ends its own
 * thread, as the caller is handed no worker, a release asks the guide to free its NVOFA session before ending it, and
 * a guide reply is taken only for the request it answers. Stand-in workers answer.
 */
import { describe, expect, test } from "bun:test";
import type { DlssgSession } from "../src/pipeline/dlssg.ts";
import { Stage, openGuideWorker, releaseStageParts } from "../src/pipeline/framegen-stage.ts";
import type { TimedFrame } from "../src/pipeline/nearest-timestamp-writer.ts";
import { rational } from "../src/pipeline/rational.ts";
import { FakeWorker, RefusingWorker } from "./fake-worker.ts";

const GUIDE_OPEN = { type: "open", width: 1280, height: 720, detectSourceCuts: true, packInline: false } as const;
const PACKER_OPEN = { type: "open-packer", width: 1280, height: 720 } as const;

describe("openGuideWorker", () => {
  test("an error reply ends the guide worker and rejects with what it said", async () => {
    const worker = new FakeWorker();
    const opening = openGuideWorker(GUIDE_OPEN, () => worker.asWorker());
    expect(worker.sent).toEqual([GUIDE_OPEN]);
    worker.reply({ type: "error", message: "NVOFA could not start" });
    await expect(opening).rejects.toThrow("frame-generation guide worker: NVOFA could not start");
    expect(worker.terminated).toBe(true);
  });

  test("a packer worker that fails to load is ended", async () => {
    const worker = new FakeWorker();
    const opening = openGuideWorker(PACKER_OPEN, () => worker.asWorker());
    worker.crash("Cannot find module flow-resize.ts");
    await expect(opening).rejects.toThrow("frame-generation packer worker failed to start: Cannot find module flow-resize.ts");
    expect(worker.terminated).toBe(true);
  });

  test("a worker that cannot be sent the open message is ended", async () => {
    const worker = new RefusingWorker();
    await expect(openGuideWorker(GUIDE_OPEN, () => worker.asWorker())).rejects.toThrow("DataCloneError");
    expect(worker.terminated).toBe(true);
  });

  test("a worker that opens is handed to the caller still running, with how it will estimate flow", async () => {
    const worker = new FakeWorker();
    const opening = openGuideWorker(GUIDE_OPEN, () => worker.asWorker());
    worker.reply({ type: "opened", flow: "nvof", flowReason: null });
    expect(await opening).toEqual({ worker: worker.asWorker(), flow: "nvof", flowReason: null });
    expect(worker.terminated).toBe(false);
  });

  test("a packer that opens is handed over without a flow, since it estimates none", async () => {
    const worker = new FakeWorker();
    const opening = openGuideWorker(PACKER_OPEN, () => worker.asWorker());
    worker.reply({ type: "opened" });
    expect(await opening).toEqual({ worker: worker.asWorker() });
  });
});

describe("Stage", () => {
  const FRAME: TimedFrame = { rgba: new Uint8Array(4), timestamp: rational(0), segment: 0, provenance: "Source", sourceIndex: 0 };
  /** A stage on a stand-in guide; the session is never reached by prepare(). */
  const stageOn = (guide: FakeWorker): Stage =>
    new Stage({ session: {} as DlssgSession, guide: guide.asWorker(), packer: null, generatedCount: 1, zeros: new Uint16Array(0), guideFlow: { flow: "cpu", flowReason: null } });
  const prepared = (id: number) => ({ type: "prepared", id, reset: true, segment: 0, previousTsNum: null, previousTsDen: null, small: null, half: null, sceneCuts: 0 });

  test("a guide reply is matched to the request it answers", async () => {
    const guide = new FakeWorker();
    const preparing = stageOn(guide).prepare(FRAME, 7);
    expect(guide.sentOfType("prepare")).toEqual([{ type: "prepare", id: 7, rgba: FRAME.rgba, segment: 0, tsNum: 0n, tsDen: 1n }]);
    guide.reply(prepared(7));
    expect((await preparing).reset).toBe(true);
  });

  test("a guide reply to another request fails the stage instead of being taken for the pending one", async () => {
    const guide = new FakeWorker();
    const stage = stageOn(guide);
    const preparing = stage.prepare(FRAME, 7);
    guide.reply(prepared(8));
    await expect(preparing).rejects.toThrow("frame-generation guide worker answered request 8 while 7 was pending");
    await expect(stage.prepare(FRAME, 9)).rejects.toThrow("answered request 8 while 7 was pending");
  });
});

describe("releaseStageParts", () => {
  /** A session stand-in that records the budget each close was given. */
  const recordingSession = (budgets: number[]): DlssgSession => ({ close: async (timeoutMs: number) => void budgets.push(timeoutMs) }) as unknown as DlssgSession;

  test("the guide is asked to close and ended only after it answers, then the packer is ended and the session closed", async () => {
    const guide = new FakeWorker();
    const packer = new FakeWorker();
    const budgets: number[] = [];
    const releasing = releaseStageParts({ session: recordingSession(budgets), guide: guide.asWorker(), packer: packer.asWorker() });
    expect(guide.sentOfType("close")).toHaveLength(1);
    expect(guide.terminated).toBe(false);

    guide.reply({ type: "closed" });
    await releasing;

    expect(guide.terminated).toBe(true);
    expect(packer.terminated).toBe(true);
    expect(budgets).toHaveLength(1);
  });

  test("an open that failed partway releases the guide that came up and skips the parts that did not", async () => {
    const guide = new FakeWorker();
    const releasing = releaseStageParts({ session: null, guide: guide.asWorker(), packer: null });
    expect(guide.sentOfType("close")).toHaveLength(1);

    guide.reply({ type: "closed" });
    await releasing;

    expect(guide.terminated).toBe(true);
  });
});
