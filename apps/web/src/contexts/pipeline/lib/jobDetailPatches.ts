import type { Stage, StageState } from "@jobctrl/contracts";

import type {
  JobDetail,
  JobSummary,
  PaginatedResponse,
} from "@jobctrl/contracts";

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
  if (applyStatus === "skipped" && (
    current.activeApplyRun ||
    current.stages.some((entry) => entry.stage === "apply" && ["queued", "succeeded", "needs_verification"].includes(entry.state)) ||
    current.applyAudit?.hardBlockers.some((entry) =>
      entry.code === "submission_intent_recorded" || entry.code === "submission_outcome_uncertain")
  )) {
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
      job.jobKey === jobId && !(applyStatus === "skipped" && (job.applyStatus === "applied" || ["queued", "running", "needs_verification"].includes(job.currentState))) ? { ...job, applyStatus } : job,
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

export function patchRetryStageState(
  current: unknown,
  stage: Stage,
  state: StageState,
): unknown {
  const patched = patchStageState(current, stage, state);
  if (!isJobDetail(patched) || patched.job.currentSubstage !== stage ||
      !patched.stages.some((entry) => entry.stage === stage)) {
    return patched;
  }
  return { ...patched, job: { ...patched.job, currentState: state } };
}
