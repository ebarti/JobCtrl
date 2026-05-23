import type { BulkJobMutationRequest, JobMutationResponse } from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";

export function useRetryFailedJobsMutation(): UseMutationResult<
  JobMutationResponse,
  Error,
  BulkJobMutationRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.retryFailedJobs(body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }),
        queryClient.invalidateQueries({ queryKey: jobsKeys.details(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}
