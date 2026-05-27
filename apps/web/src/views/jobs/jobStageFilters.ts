import type { BulkJobMutationRequest, Stage } from "@jobhunter/contracts";

import type { JobsListInput } from "../../contexts/operations/types.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";

export const PREPARATION_STAGES = [
  "discover",
  "enrich",
  "score",
  "tailor",
  "cover",
] as const satisfies readonly Stage[];

export function jobsListInput(search: JobsSearch): JobsListInput {
  const input: JobsListInput = {
    page: search.page,
    pageSize: search.pageSize,
    q: search.q,
    sort: search.sort,
    dir: search.dir,
    deleted: search.deleted,
    minFitScore: search.minFitScore,
    maxFitScore: search.maxFitScore,
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
  if (search.stage === "discover") {
    return PREPARATION_STAGES.map((stage) => ({ ...filter, stage }));
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
  if (stage === "discover") {
    return { ...input, stages: PREPARATION_STAGES };
  }
  return { ...input, stage };
}
