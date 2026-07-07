import type { BulkJobMutationRequest } from "@jobctl/contracts";

import type { JobsListInput } from "../../contexts/operations/types.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";

export function jobsListInput(search: JobsSearch): JobsListInput {
  const input: JobsListInput = {
    page: search.page,
    pageSize: search.pageSize,
    q: search.q,
    sort: search.sort,
    dir: search.dir,
    deleted: search.deleted,
    applyStatus: search.applyStatus,
    minFitScore: search.minFitScore,
    maxFitScore: search.maxFitScore,
    discoveredSince: search.discoveredSince,
    scoredSince: search.scoredSince,
    ...(search.state !== "all" ? { state: search.state } : {}),
  };
  return applyStageFilter(input, search.stage);
}

export function bulkJobFilters(
  search: JobsSearch,
  overrides: Partial<NonNullable<BulkJobMutationRequest["filter"]>> = {},
): NonNullable<BulkJobMutationRequest["filter"]>[] {
  const filter: NonNullable<BulkJobMutationRequest["filter"]> = {
    q: search.q,
    deleted: search.deleted,
    applyStatus: search.applyStatus,
    source: "",
    company: "",
    minFitScore: search.minFitScore,
    maxFitScore: search.maxFitScore,
    ...(search.state !== "all" ? { state: search.state } : {}),
    ...overrides,
  };
  if (search.stage === "all") {
    return [filter];
  }
  return [{ ...filter, stage: search.stage }];
}

function applyStageFilter(
  input: JobsListInput,
  stage: JobsSearch["stage"],
): JobsListInput {
  if (stage === "all") {
    return input;
  }
  return { ...input, stage };
}
