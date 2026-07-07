import type { ActionRunResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { workflowRunsKeys } from "../../operations/workflowRunsKeys.js";

export interface CancelWorkflowRunVariables {
  readonly runId: string;
}

export function useCancelWorkflowRunMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  CancelWorkflowRunVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ runId }) => api.cancelWorkflowRun(runId),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workflowRunsKeys.lists(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}
