import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outcomesKeys } from "../outcomesKeys.js";
import type { JobApplicationOutcomeListResponse, JobId } from "../types.js";

export function useJobApplicationOutcomesQuery(
  jobId: JobId,
): UseQueryResult<JobApplicationOutcomeListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: outcomesKeys.detail(tenantId, jobId),
    queryFn: () => api.jobApplicationOutcomes(jobId),
  });
}
