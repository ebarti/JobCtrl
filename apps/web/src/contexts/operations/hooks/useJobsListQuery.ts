import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { jobsKeys } from "../jobsKeys.js";
import type { JobsListInput, JobSummary, PaginatedResponse } from "../types.js";

export function useJobsListQuery(
  input: JobsListInput,
): UseQueryResult<PaginatedResponse<JobSummary>> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: jobsKeys.list(tenantId, input),
    queryFn: () => api.jobs(input),
  });
}
