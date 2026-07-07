import type { ActionRunResponse, RetryStageRequest, Stage } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";
import { patchStageState } from "../lib/jobDetailPatches.js";

export interface RetryStageVariables {
  readonly jobId: JobId;
  readonly stage: Stage;
  readonly resetAttempts?: boolean;
  readonly runAfter?: boolean;
  readonly dryRun?: boolean;
}

function toRequest(variables: RetryStageVariables): RetryStageRequest {
  return {
    stage: variables.stage,
    resetAttempts: variables.resetAttempts ?? false,
    runAfter: variables.runAfter ?? false,
    dryRun: variables.dryRun ?? false,
  };
}

export function useRetryStageMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  RetryStageVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ActionRunResponse, RetryStageVariables>(queryClient, {
      mutationFn: (variables) => api.retryStage(variables.jobId, toRequest(variables)),
      // Retry without runAfter is sync; with runAfter it's async (202). Either
      // way the user expects "this stage is now running" feedback. SSE in
      // Phase 5 will reconcile to the true server state.
      optimisticUpdates: ({ jobId, stage }) => [
        {
          queryKey: jobsKeys.detail(tenantId, jobId),
          patch: (current) => patchStageState(current, stage, "running"),
        },
      ],
      // Stage transitions feed dashboard funnel counts.
      settle: ({ jobId }) => [
        jobsKeys.detail(tenantId, jobId),
        jobsKeys.lists(tenantId),
        dashboardKeys.summary(tenantId),
      ],
    }),
  );
}
