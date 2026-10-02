/**
 * The mock backend's checks on a POST /api/jobs body: its shape, and a subset of the refusals the
 * real server (src/server/validate.ts) makes before queueing.
 */
import type { JobRequest } from "../../src/server/api-types";
import { ApiError } from "./errors";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Structural check for a POST /api/jobs body (used by the mock server). */
export function isJobRequest(value: unknown): value is JobRequest {
  if (!isRecord(value)) return false;
  return (
    (value.kind === "image" || value.kind === "video") &&
    typeof value.input === "string" &&
    (value.output === undefined || typeof value.output === "string") &&
    (value.engine === "bypass" || value.engine === "nr" || value.engine === "sr") &&
    (value.motion === "none" || value.motion === "flow") &&
    isRecord(value.settings) &&
    isRecord(value.scale)
  );
}

/** Rejects requests the real server would refuse before queueing. */
export function validateJobRequest(request: JobRequest): void {
  if (request.input.trim() === "") throw new ApiError(400, "input path is required");
  if (request.kind === "video" && !request.encode) throw new ApiError(400, "video jobs need encode settings");
}
