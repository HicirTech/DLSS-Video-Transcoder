/**
 * Which settings of a job take effect, from the steps it runs: the one statement of it for the web forms, which show
 * the reason where a job ignores a setting, the server's request validation and the CLI. It imports no Node module:
 * the web bundles it.
 */
import { FRAME_GEN_GPU_CHOICE, type StepKind } from "./api-types.ts";

/** Which steps a job runs. */
export type JobShape = Record<StepKind, boolean>;

/** For the settings a form shows outside the step cards: null when the job uses them as set, otherwise the reason. */
export interface UnusedSettings {
  /** The resize without Super Resolution. */
  resize: string | null;
  /** The GPU chosen in the Settings tab, which reaches Super Resolution and Neural Rendering only. */
  gpu: string | null;
}

const FRAME_GEN_GPU = `Frame generation picks its GPU itself: ${FRAME_GEN_GPU_CHOICE}.`;

/**
 * Whether a job runs anything on the GPU it is given (JobRequest.adapterUuid): Super Resolution, Neural Rendering,
 * or the copy a job without steps runs. Frame generation picks its own, so a job that runs it alone takes none.
 */
export function takesGpuChoice(job: JobShape): boolean {
  return job.sr || job.nr || !job.fg;
}

export function unusedSettings(job: JobShape): UnusedSettings {
  return {
    resize: job.sr ? "Super Resolution sets the output size." : null,
    gpu: !job.fg ? null : takesGpuChoice(job) ? `Super Resolution and Neural Rendering run on the GPU chosen in Settings. ${FRAME_GEN_GPU}` : FRAME_GEN_GPU,
  };
}
