import { useCallback, useState } from "react";
import type { JobRequest, JobStatus } from "../../../src/server/api-types";
import { api } from "../api";
import { errorMessage } from "../errors";
import { useToast } from "./useToast";

export interface JobRunner {
  /** The job created by the last submit, kept current from the feed. */
  job: JobStatus | null;
  /** True while POST /api/jobs is in flight. */
  submitting: boolean;
  cancelling: boolean;
  submit(request: JobRequest): Promise<void>;
  cancel(): Promise<void>;
  clear(): void;
}

/** Submits one job at a time from a form and tracks it in the live job list. Errors go to the toast. */
export function useJobRunner(jobs: JobStatus[]): JobRunner {
  const toast = useToast();
  const [created, setCreated] = useState<JobStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const job = created ? (jobs.find((candidate) => candidate.id === created.id) ?? created) : null;

  const submit = useCallback(
    async (request: JobRequest): Promise<void> => {
      setSubmitting(true);
      try {
        const status = await api.createJob(request);
        setCreated(status);
        toast.showSuccess(`Job ${status.id} queued`);
      } catch (err) {
        toast.showError(`Could not start the job: ${errorMessage(err)}`);
      } finally {
        setSubmitting(false);
      }
    },
    [toast],
  );

  const cancel = useCallback(async (): Promise<void> => {
    if (!created) return;
    setCancelling(true);
    try {
      const status = await api.cancelJob(created.id);
      setCreated(status);
    } catch (err) {
      toast.showError(`Could not cancel job ${created.id}: ${errorMessage(err)}`);
    } finally {
      setCancelling(false);
    }
  }, [created, toast]);

  const clear = useCallback(() => setCreated(null), []);

  return { job, submitting, cancelling, submit, cancel, clear };
}
