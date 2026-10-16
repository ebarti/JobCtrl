import type { BulkJobMutationRequest } from "@jobctrl/contracts";

import {
  JOB_STATES,
  type JobState,
  type JobsListInput,
  type Stage,
} from "../../contexts/operations/types.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";

export function jobsListInput(
  search: JobsSearch,
  stages?: readonly Stage[],
): JobsListInput {
  const input: JobsListInput = {
    page: search.page,
    pageSize: search.pageSize,
    q: search.q,
    sort: search.sort,
    dir: search.dir,
    deleted: search.deleted,
    ...(search.jobStates ? { jobStates: search.jobStates } : {}),
    applyStatus: search.applyStatus,
    minFitScore: search.minFitScore,
    maxFitScore: search.maxFitScore,
    discoveredSince: search.discoveredSince,
    scoredSince: search.scoredSince,
    ...(search.state !== "all" ? { state: search.state } : {}),
  };
  return { ...input, ...stageFilter(search, stages) };
}

export function bulkJobFilters(
  search: JobsSearch,
  overrides: Partial<NonNullable<BulkJobMutationRequest["filter"]>> = {},
  stages?: readonly Stage[],
): NonNullable<BulkJobMutationRequest["filter"]>[] {
  const filter: NonNullable<BulkJobMutationRequest["filter"]> = {
    q: search.q,
    deleted: search.deleted,
    ...(search.jobStates ? { jobStates: search.jobStates } : {}),
    applyStatus: search.applyStatus,
    source: "",
    company: "",
    minFitScore: search.minFitScore,
    maxFitScore: search.maxFitScore,
    discoveredSince: search.discoveredSince,
    scoredSince: search.scoredSince,
    ...(search.state !== "all" ? { state: search.state } : {}),
    ...overrides,
  };
  return [{ ...filter, ...stageFilter(search, stages) }];
}

export function effectiveJobStates(search: JobsSearch): JobState[] {
  if (search.jobStates) return [...search.jobStates];
  if (search.deleted === "deleted") return ["deleted"];
  if (search.deleted === "hidden") return ["hidden"];
  return ["active"];
}

export function allJobStates(): JobState[] {
  return [...JOB_STATES];
}

function stageFilter(search: JobsSearch, stages?: readonly Stage[]) {
  if (search.stage !== "all") return { stage: search.stage };
  return stages !== undefined ? { stages: [...new Set(stages)] } : {};
}
