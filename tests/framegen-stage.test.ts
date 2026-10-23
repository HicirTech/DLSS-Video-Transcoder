/**
 * How a stage's guide and packer workers start and end (src/pipeline/framegen-stage.ts): a failed open ends its own
 * thread, as the caller is handed no worker, and a release asks the guide to free its NVOFA session before ending it.
 * Stand-in workers answer.
 */
import { describe, expect, test } from "bun:test";
import type { DlssgSession } from "../src/pipeline/dlssg.ts";
import { openGuideWorker, releaseStageParts } from "../src/pipeline/framegen-stage.ts";
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
