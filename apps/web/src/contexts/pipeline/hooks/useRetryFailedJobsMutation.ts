import type { BulkRetryFailedRequest, BulkRetryFailedResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { useToastStore } from "../../../shared/stores/toasts.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { workflowRunsKeys } from "../../operations/workflowRunsKeys.js";

export function useRetryFailedJobsMutation(): UseMutationResult<
  BulkRetryFailedResponse,
  Error,
  BulkRetryFailedRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.retryFailedJobs(body),
    onSuccess: (data) => {
      if (data.retailorRequiredJobKeys?.length && data.message) {
        useToastStore.getState().toast({ variant: "info", message: data.message });
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }),
        queryClient.invalidateQueries({ queryKey: jobsKeys.details(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
        queryClient.invalidateQueries({ queryKey: workflowRunsKeys.lists(tenantId) }),
      ]);
    },
  });
}
