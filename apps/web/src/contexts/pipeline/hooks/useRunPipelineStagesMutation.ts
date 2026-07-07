import type { PipelineStageRunResponse, RunPipelineStagesRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { applyRunsKeys } from "../../operations/applyRunsKeys.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { workflowRunsKeys } from "../../operations/workflowRunsKeys.js";

export function useRunPipelineStagesMutation(): UseMutationResult<
  PipelineStageRunResponse,
  Error,
  RunPipelineStagesRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request) => api.runPipelineStages(request),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
        queryClient.invalidateQueries({ queryKey: workflowRunsKeys.lists(tenantId) }),
        queryClient.invalidateQueries({ queryKey: applyRunsKeys.lists(tenantId) }),
      ]);
    },
  });
}
