/**
 * openGuideWorker (src/pipeline/framegen-stage.ts), which starts a stage's guide or packer worker:
 * when the open fails the caller is handed no worker, so the open itself must end the thread.
 * Stand-in workers answer the open.
 */
import { describe, expect, test } from "bun:test";
import { openGuideWorker } from "../src/pipeline/framegen-stage.ts";
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
