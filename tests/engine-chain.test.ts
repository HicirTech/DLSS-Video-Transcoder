/**
 * createEngineChain (src/pipeline/engine.ts) with stand-in SR and NR engines: a stacked Neural Rendering opens one
 * engine per pass and feeds each the output of the one before, and every engine opened is closed on every path.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_NR_SETTINGS } from "../src/server/api-types.ts";
import { createEngineChain, type Engine, type FrameInput, type NrEngineOptions, registerNeuralEngine, registerSrEngine } from "../src/pipeline/engine.ts";
import type { GpuSession } from "../src/pipeline/gpu.ts";

// The stand-in engines never touch the session.
const unusedSession = {} as GpuSession;
const FRAME_SIZE = { width: 4, height: 2 };

/** An engine that appends its own mark to every frame, so the order the frames went through shows in the output. */
class MarkingEngine implements Engine {
  readonly inputs: FrameInput[] = [];
  closes = 0;

  constructor(
    readonly name: string,
    readonly outputWidth: number,
    readonly outputHeight: number,
    private readonly mark: number,
    private readonly closeFailure: Error | null = null,
  ) {}

  process(frame: FrameInput): Uint8Array {
    this.inputs.push(frame);
    return Uint8Array.from([...frame.rgba, this.mark]);
  }

  close(): void {
    this.closes++;
    if (this.closeFailure) throw this.closeFailure;
  }
}

/** Registers stand-ins for both engines: NR passes are marked 1, 2, 3, ..., SR is marked 100; `failOpenAt` makes that NR open throw. */
function standIns({ failOpenAt = 0, failCloseAt = 0 }: { failOpenAt?: number; failCloseAt?: number } = {}) {
  const opened = { nr: [] as MarkingEngine[], nrOptions: [] as NrEngineOptions[], sr: [] as MarkingEngine[] };
  registerSrEngine((_session, options) => {
    const sr = new MarkingEngine("sr", options.outputWidth, options.outputHeight, 100);
    opened.sr.push(sr);
    return sr;
  });
  registerNeuralEngine((_session, options) => {
    const pass = opened.nr.length + 1;
    if (pass === failOpenAt) throw new Error(`NR pass ${pass} failed to open`);
    const nr = new MarkingEngine("nr", options.width, options.height, pass, pass === failCloseAt ? new Error(`NR pass ${pass} failed to close`) : null);
    opened.nr.push(nr);
    opened.nrOptions.push(options);
    return nr;
  });
  return opened;
}

const chainOptions = { ...FRAME_SIZE, outputWidth: 8, outputHeight: 4 };
const frame: FrameInput = { rgba: Uint8Array.from([0]), reset: true, motion: new Float32Array(FRAME_SIZE.width * FRAME_SIZE.height * 2) };

describe("createEngineChain", () => {
  test("a Neural Rendering without a stack is one engine, as before", () => {
    const opened = standIns();
    const engine = createEngineChain(unusedSession, { ...chainOptions, neuralRendering: { settings: DEFAULT_NR_SETTINGS } });
    expect(opened.nr).toHaveLength(1);
    expect(engine).toBe(opened.nr[0]!);
  });

  test("a stacked Neural Rendering runs each pass on the output of the one before, all with the frame's reset", () => {
    const opened = standIns();
    const settings = { ...DEFAULT_NR_SETTINGS, style: 2 as const };
    const engine = createEngineChain(unusedSession, { ...chainOptions, neuralRendering: { settings, stack: 3, dllDir: "C:\\nr\\310" } });
    expect(engine.name).toBe("nrx3");
    expect(opened.nr).toHaveLength(3);
    for (const options of opened.nrOptions) expect(options).toMatchObject({ ...FRAME_SIZE, settings, dllDir: "C:\\nr\\310" });

    expect([...engine.process(frame)]).toEqual([0, 1, 2, 3]);
    expect(opened.nr.map((nr) => [...nr.inputs[0]!.rgba])).toEqual([[0], [0, 1], [0, 1, 2]]);
    expect(opened.nr.map((nr) => nr.inputs[0]!.reset)).toEqual([true, true, true]);
    // Only the first engine is given the frame's motion; NR takes none.
    expect(opened.nr.map((nr) => nr.inputs[0]!.motion)).toEqual([frame.motion, null, null]);
  });

  test("after Super Resolution, the stacked passes run at its output size", () => {
    const opened = standIns();
    const engine = createEngineChain(unusedSession, { ...chainOptions, superResolution: { scale: { mode: "factor", factor: 2, width: 8, height: 4 } }, neuralRendering: { settings: DEFAULT_NR_SETTINGS, stack: 2 } });
    expect(engine.name).toBe("sr+nrx2");
    expect([engine.outputWidth, engine.outputHeight]).toEqual([8, 4]);
    expect(opened.nrOptions.map(({ width, height }) => [width, height])).toEqual([[8, 4], [8, 4]]);
    expect([...engine.process(frame)]).toEqual([0, 100, 1, 2]);
  });

  test("a pass that fails to open closes every engine opened before it", () => {
    const opened = standIns({ failOpenAt: 3 });
    expect(() => createEngineChain(unusedSession, { ...chainOptions, superResolution: { scale: { mode: "factor", factor: 2, width: 8, height: 4 } }, neuralRendering: { settings: DEFAULT_NR_SETTINGS, stack: 4 } })).toThrow(
      "NR pass 3 failed to open",
    );
    expect([...opened.sr, ...opened.nr].map((engine) => engine.closes)).toEqual([1, 1, 1]);
  });

  test("closing a chain closes every engine even when one throws, and then rethrows that error", () => {
    const opened = standIns({ failCloseAt: 1 });
    const engine = createEngineChain(unusedSession, { ...chainOptions, neuralRendering: { settings: DEFAULT_NR_SETTINGS, stack: 3 } });
    expect(() => engine.close()).toThrow("NR pass 1 failed to close");
    expect(opened.nr.map((nr) => nr.closes)).toEqual([1, 1, 1]);
  });
});
