import type { JobSummary, PaginatedResponse } from "@jobctrl/contracts";

import type { ApiClientPort } from "../../shared/ports/ApiClientPort.js";
import type { JobsListInput } from "./types.js";

/** The server owns combined ordering, totals, clamping and the bounded page. */
export function fetchJobsList(
  api: Pick<ApiClientPort, "jobs">,
  input: JobsListInput,
): Promise<PaginatedResponse<JobSummary>> {
  const { stage, stages, ...query } = input;
  return api.jobs(
    stages !== undefined
      ? { ...query, stages: [...new Set(stages)] }
      : { ...query, ...(stage ? { stage } : {}) },
  );
}
