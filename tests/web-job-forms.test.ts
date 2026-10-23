/**
 * What the web forms send and show (web/src/job-requests.ts, web/src/job-plan.ts): every combination of step
 * switches makes a request the API accepts, and the plan works sizes and names out as the jobs do. No GPU.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_SCALE_SETTINGS, FRAME_GEN_CONTAINER, jobSteps, type StepKind } from "../src/server/api-types.ts";
import { validateJobRequest } from "../src/server/validate.ts";
import { defaultSettings, type StoredSettings } from "../web/src/stored-settings.ts";
import { frameGenOutputFps, planJob, planStages } from "../web/src/job-plan.ts";
import { imageRequest, videoRequest } from "../web/src/job-requests.ts";

const UUID = "GPU-524e8373-5fe1-44b3-c0aa-cdbe917e7ed2";
const FORM = { input: " C:\\clips\\clip.mp4 ", output: "", dllDirs: {} };

/** Every combination of the three switches. */
const SWITCHES: Array<Record<StepKind, boolean>> = Array.from({ length: 8 }, (_, mask) => ({ sr: Boolean(mask & 1), nr: Boolean(mask & 2), fg: Boolean(mask & 4) }));

function settingsWith(patch: Partial<StoredSettings>): StoredSettings {
  return { ...defaultSettings(), adapterUuid: UUID, resize: { ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: 0.5 }, ...patch };
}

describe("videoRequest", () => {
  test("every combination of switches is a request the API accepts, running exactly the steps switched on", () => {
    for (const videoSteps of SWITCHES) {
      const request = videoRequest(FORM, settingsWith({ videoSteps }));
      const name = JSON.stringify(videoSteps);
      expect(validateJobRequest(request), name).toBeNull();
      expect(jobSteps(request), name).toEqual((["sr", "nr", "fg"] as const).filter((step) => videoSteps[step]));
      expect(request.input, name).toBe("C:\\clips\\clip.mp4");
    }
  });

  test("the resize goes only without Super Resolution, and the GPU choice only with a step that takes it", () => {
    const fgAlone = videoRequest(FORM, settingsWith({ videoSteps: { sr: false, nr: false, fg: true } }));
    expect(fgAlone.adapterUuid).toBeUndefined();
    expect(fgAlone.resize).toEqual({ ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: 0.5 });
    const all = videoRequest(FORM, settingsWith({ videoSteps: { sr: true, nr: true, fg: true } }));
    expect(all.adapterUuid).toBe(UUID);
    expect(all.resize).toBeUndefined();
  });

  test("frame generation writes its container whatever is stored, and sends the one rate field in use", () => {
    // Not the defaults, so the request can only carry them by sending what is stored.
    const stored = settingsWith({
      videoSteps: { sr: false, nr: false, fg: true },
      encode: { ...defaultSettings().encode, container: "mkv" },
      frameGen: { ...defaultSettings().frameGen, targetFps: "120", engine: "cascade" },
    });
    expect(videoRequest(FORM, stored).encode?.container).toBe(FRAME_GEN_CONTAINER);
    expect(videoRequest(FORM, { ...stored, videoSteps: { sr: false, nr: true, fg: false } }).encode?.container).toBe("mkv");
    expect(videoRequest(FORM, stored).frameGen).toEqual({ targetFps: "120", engine: "cascade" });
    const byMultiplier = { ...stored, frameGen: { ...stored.frameGen, rateBy: "multiplier" as const, multiplier: 3 } };
    expect(videoRequest(FORM, byMultiplier).frameGen).toEqual({ multiplier: 3, engine: "cascade" });
  });

  test("a step's stored settings and version folder ride along with its own step only, and an output path only when given", () => {
    const stored = settingsWith({
      videoSteps: { sr: true, nr: true, fg: false },
      superResolution: { ...defaultSettings().superResolution, motion: "flow" },
      neuralRendering: { ...defaultSettings().neuralRendering, style: 2 },
      nrStack: 3,
    });
    const request = videoRequest({ ...FORM, output: " C:\\out\\x.mp4 ", dllDirs: { sr: "C:\\dlss\\310", nr: "", fg: "C:\\dlssg\\310" } }, stored);
    expect(request.superResolution?.motion).toBe("flow");
    expect(request.neuralRendering?.settings.style).toBe(2);
    expect(request.neuralRendering?.stack).toBe(3);
    expect(request.superResolution?.dllDir).toBe("C:\\dlss\\310");
    expect(request.neuralRendering).not.toHaveProperty("dllDir");
    expect(request.frameGen).toBeUndefined();
    expect(request.output).toBe("C:\\out\\x.mp4");
    expect(videoRequest(FORM, settingsWith({})).output).toBeUndefined();
  });
});

describe("imageRequest", () => {
  test("every combination of the two switches is a request the API accepts, with no motion and the warm-up passes", () => {
    for (const { sr, nr } of SWITCHES.filter((steps) => !steps.fg)) {
      const request = imageRequest({ ...FORM, input: "C:\\stills\\a.png" }, settingsWith({ imageSteps: { sr, nr }, superResolution: { ...defaultSettings().superResolution, motion: "flow" }, warmupFrames: 6, nrStack: 2 }));
      expect(validateJobRequest(request), JSON.stringify({ sr, nr })).toBeNull();
      expect(request.superResolution?.motion).toBeUndefined();
      expect(request.warmupFrames).toBe(6);
      expect(request.neuralRendering?.stack).toBe(nr ? 2 : undefined);
    }
  });
});

describe("planJob", () => {
  const steps = (on: Partial<Record<StepKind, boolean>>) => ({ sr: false, nr: false, fg: false, ...on });
  const plan = (kind: "image" | "video", on: Partial<Record<StepKind, boolean>>, source: { width: number; height: number } | null, nrStack = 1) =>
    planJob({ kind, input: "C:\\clips\\take.2.mov", source, steps: steps(on), srScale: { ...DEFAULT_SCALE_SETTINGS, mode: "factor", factor: 1.5 }, resize: DEFAULT_SCALE_SETTINGS, nrStack, container: "mkv" });

  test("sizes the output as the jobs do: a video's sides even, a still's as they come", () => {
    expect(plan("video", { sr: true }, { width: 1281, height: 721 }).outputSize).toEqual({ width: 1922, height: 1082 });
    expect(plan("video", { nr: true }, { width: 1281, height: 721 }).outputSize).toEqual({ width: 1282, height: 722 });
    expect(plan("image", { nr: true }, { width: 1281, height: 721 }).outputSize).toEqual({ width: 1281, height: 721 });
    expect(plan("video", { sr: true }, null).outputSize).toBeNull();
  });

  test("names the default output after the steps, with the container frame generation fixes", () => {
    expect(plan("video", { sr: true, nr: true, fg: true }, null).defaultOutputName).toBe("take.2.sr-nr-fg.mp4");
    expect(plan("video", { nr: true }, null).defaultOutputName).toBe("take.2.nr.mkv");
    expect(plan("video", {}, null).defaultOutputName).toBe("take.2.copy.mkv");
    expect(plan("image", { sr: true }, null).defaultOutputName).toBe("take.2.sr.png");
  });

  test("names a stacked Neural Rendering after its passes", () => {
    expect(plan("video", { sr: true, nr: true }, null, 3).defaultOutputName).toBe("take.2.sr-nrx3.mkv");
    expect(plan("image", { sr: true }, null, 3).defaultOutputName).toBe("take.2.sr.png");
  });

  test("says when Super Resolution cannot write the size, before the job is sent", () => {
    const shrink = planJob({ kind: "video", input: "C:\\a.mp4", source: { width: 3840, height: 2160 }, steps: steps({ sr: true }), srScale: { ...DEFAULT_SCALE_SETTINGS, mode: "size", width: 1920, height: 1080 }, resize: DEFAULT_SCALE_SETTINGS, nrStack: 1, container: "mp4" });
    expect(shrink.srProblem).toMatch(/^DLSS Super Resolution only enlarges/);
    expect(plan("video", { sr: true }, { width: 1280, height: 720 }).srProblem).toBeNull();
  });

  test("the plan line runs from the decode through each step to what writes the output", () => {
    const planned = plan("video", { sr: true, nr: true, fg: true }, { width: 1280, height: 720 });
    expect(planStages({ plan: planned, source: { width: 1280, height: 720 }, srScale: DEFAULT_SCALE_SETTINGS, resize: DEFAULT_SCALE_SETTINGS, frameGenTarget: "60 fps", writer: "H.264 in MP4" })).toEqual([
      "Decode 1280×720",
      "Super Resolution to 1920×1080",
      "Neural Rendering",
      "Frame generation to 60 fps",
      "H.264 in MP4",
    ]);
  });

  test("the plan line counts a stacked Neural Rendering's passes", () => {
    const planned = plan("image", { nr: true }, { width: 800, height: 600 }, 3);
    expect(planStages({ plan: planned, source: { width: 800, height: 600 }, srScale: DEFAULT_SCALE_SETTINGS, resize: DEFAULT_SCALE_SETTINGS, frameGenTarget: "", writer: "PNG" })).toEqual(["Decode 800×600", "Neural Rendering ×3", "PNG"]);
  });
});

describe("frameGenOutputFps", () => {
  test("a named rate stands alone; a multiple needs the source's nominal rate", () => {
    const frameGen = defaultSettings().frameGen;
    expect(frameGenOutputFps(frameGen, null)).toBe(60);
    expect(frameGenOutputFps({ ...frameGen, rateBy: "multiplier", multiplier: 2 }, "30000/1001")).toBeCloseTo(59.94, 2);
    expect(frameGenOutputFps({ ...frameGen, rateBy: "multiplier", multiplier: 2 }, null)).toBeNull();
  });
});
