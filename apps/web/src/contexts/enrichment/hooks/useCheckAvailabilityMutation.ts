import type { CheckAvailabilityResponse } from "../../operations/types.js";
import type { JobDetail } from "@jobctrl/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createOptimisticMutation, invalidateQueriesWithOptimisticOwnership, type OptimisticContext } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { jobsKeys } from "../../operations/jobsKeys.js";

export function useCheckAvailabilityMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const options = createOptimisticMutation<CheckAvailabilityResponse, string>(queryClient, {
    mutationFn: (jobId) => api.checkPostingAvailability(jobId, {}),
    optimisticUpdates: (jobId) => [{
      queryKey: jobsKeys.detail(tenantId, jobId),
      cancelExact: false,
      patch: (current) => {
        const detail = current as JobDetail | undefined;
        return detail?.job.availability ? {
          ...detail, job: { ...detail.job, availability: { ...detail.job.availability, checkInProgress: true } },
        } : current;
      },
    }],
  });
  return useMutation<CheckAvailabilityResponse, Error, string, OptimisticContext>({
    ...options,
    onSettled: async (data, error, jobId, mutationResult, context) => {
      const settled = options.onSettled?.(data, error, jobId, mutationResult, context);
      await Promise.all([
        settled,
        invalidateQueriesWithOptimisticOwnership(queryClient, jobsKeys.detail(tenantId, jobId)),
        invalidateQueriesWithOptimisticOwnership(queryClient, jobsKeys.lists(tenantId)),
      ]);
    },
  });
}
