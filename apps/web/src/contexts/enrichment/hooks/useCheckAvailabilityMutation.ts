import type { CheckAvailabilityResponse, JobDetail } from "../../operations/types.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { jobsKeys } from "../../operations/jobsKeys.js";

export function useCheckAvailabilityMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation<CheckAvailabilityResponse, Error, string, { previous: JobDetail | undefined }>({
    mutationFn: (jobId) => api.checkPostingAvailability(jobId, {}),
    onMutate: async (jobId) => {
      const key = jobsKeys.detail(tenantId, jobId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<JobDetail>(key);
      queryClient.setQueryData<JobDetail>(key, (current) => current?.job.availability ? {
        ...current, job: { ...current.job, availability: { ...current.job.availability, checkInProgress: true } },
      } : current);
      return { previous };
    },
    onError: (_error, jobId, context) => {
      if (context?.previous) queryClient.setQueryData(jobsKeys.detail(tenantId, jobId), context.previous);
    },
    onSettled: async (_data, _error, jobId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: jobsKeys.detail(tenantId, jobId) }),
        queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }),
      ]);
    },
  });
}
