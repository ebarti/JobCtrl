import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { jobsKeys } from "../jobsKeys.js";
import { fetchJobsList } from "../jobsListQuery.js";
import type { JobsListInput } from "../types.js";
import type { JobSummary, PaginatedResponse, ReviewableJobsResponse } from "@jobctrl/contracts";

export function useJobsListQuery(
  input: JobsListInput,
): UseQueryResult<PaginatedResponse<JobSummary>> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: jobsKeys.list(tenantId, input),
    queryFn: () => fetchJobsList(api, input),
  });
}

export function useReviewableJobsListQuery(input: JobsListInput): UseQueryResult<ReviewableJobsResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: [...jobsKeys.list(tenantId, input), "reviewable"],
    queryFn: () => fetchJobsList({ jobs: (query) => api.reviewableJobs(query) }, input),
  });
}
