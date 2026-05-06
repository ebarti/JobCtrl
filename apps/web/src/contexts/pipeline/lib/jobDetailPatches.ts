import type { Stage, StageState } from "@jobhunter/contracts";

import type { JobDetail, JobSummary, PaginatedResponse } from "../../operations/types.js";

function isJobDetail(value: unknown): value is JobDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    "job" in value &&
    "stages" in value &&
    Array.isArray((value as JobDetail).stages)
  );
}

function isJobsPage(value: unknown): value is PaginatedResponse<JobSummary> {
  return (
    typeof value === "object" &&
    value !== null &&
    "items" in value &&
    Array.isArray((value as PaginatedResponse<JobSummary>).items)
  );
}

export function patchDetailApplyStatus(current: unknown, applyStatus: string): unknown {
  if (!isJobDetail(current)) {
    return current;
  }
  return {
    ...current,
    job: { ...current.job, applyStatus },
  };
}

export function patchListApplyStatus(
  current: unknown,
  jobId: string,
  applyStatus: string,
): unknown {
  if (!isJobsPage(current)) {
    return current;
  }
  return {
    ...current,
    items: current.items.map((job) =>
      job.jobKey === jobId ? { ...job, applyStatus } : job,
    ),
  };
}

export function patchStageState(
  current: unknown,
  stage: Stage,
  state: StageState,
): unknown {
  if (!isJobDetail(current)) {
    return current;
  }
  return {
    ...current,
    stages: current.stages.map((entry) =>
      entry.stage === stage ? { ...entry, state } : entry,
    ),
  };
}
