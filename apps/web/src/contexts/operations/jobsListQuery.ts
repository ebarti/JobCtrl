import { JobListQuerySchema, type JobSummary, type PaginatedResponse } from "@jobctrl/contracts";

import type { JobsListInput } from "./types.js";

/** The server owns combined ordering, totals, clamping and the bounded page. */
export function fetchJobsList<T extends PaginatedResponse<JobSummary>>(
  api: { jobs: (query?: Partial<import("@jobctrl/contracts").JobListQuery>) => Promise<T> },
  input: JobsListInput,
): Promise<T> {
  // Parse before deduplication so malformed/oversized arrays retain the API's
  // scalar fallback. Keep the scalar echo alongside an overriding stage array.
  const { stage: rawStage, stages: rawStages, ...query } = input;
  const { stage, stages } = JobListQuerySchema.parse({
    stage: rawStage,
    stages: rawStages,
  });
  return api.jobs({
    ...query,
    ...(stage !== undefined ? { stage } : {}),
    ...(stages !== undefined ? { stages } : {}),
  });
}
