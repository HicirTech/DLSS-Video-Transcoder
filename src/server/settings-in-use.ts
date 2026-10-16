/**
 * Which settings of a job request take effect, from the job's engine and whether it runs frame generation:
 * the one statement of it. The server checks a dllDir against the DLL feature the job loads. It imports no
 * Node module, so the web can bundle it.
 */
import type { EngineKind, JobRequest } from "./api-types.ts";

/** What decides which settings a job uses. */
export interface JobShape {
  engine: EngineKind;
  /** Whether the job runs frame generation, which runs none of the per-frame engines. */
  frameGen: boolean;
}

/** The shape of a request the server received. */
export function jobShapeOf(request: Pick<JobRequest, "engine" | "frameGen">): JobShape {
  return { engine: request.engine, frameGen: request.frameGen !== undefined };
}

/** The DLSS feature a job loads a DLL of, the one its dllDir has to be a version of. */
export type DllFeature = "sr" | "nr" | "fg";

/** The feature of the DLL a job loads, or null for a bypass job without frame generation, which loads none. */
export function dllFeatureOf(job: JobShape): DllFeature | null {
  if (job.frameGen) return "fg";
  return job.engine === "bypass" ? null : job.engine;
}
