import type { ActionRunResponse, Stage } from "@jobctl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";
import { patchStageState } from "../lib/jobDetailPatches.js";

export interface CancelStageVariables {
  readonly jobId: JobId;
  readonly stage: Stage;
}

export function useCancelStageMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  CancelStageVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ActionRunResponse, CancelStageVariables>(queryClient, {
      mutationFn: ({ jobId }) => api.cancelJobAction(jobId, {}),
      optimisticUpdates: ({ jobId, stage }) => [
        {
          queryKey: jobsKeys.detail(tenantId, jobId),
          patch: (current) => patchStageState(current, stage, "stale"),
        },
      ],
      // Cancellation can flip funnel counts (a running stage stops counting as running).
      settle: ({ jobId }) => [
        jobsKeys.detail(tenantId, jobId),
        jobsKeys.lists(tenantId),
        dashboardKeys.summary(tenantId),
      ],
    }),
  );
}
