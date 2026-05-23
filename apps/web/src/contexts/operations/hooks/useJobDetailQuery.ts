import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { jobsKeys } from "../jobsKeys.js";
import type { JobDetail, JobId } from "../types.js";

export function useJobDetailQuery(jobId: JobId): UseQueryResult<JobDetail> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: jobsKeys.detail(tenantId, jobId),
    queryFn: () => api.job(jobId),
    meta: { suppressGlobalErrorToast: true },
  });
}
