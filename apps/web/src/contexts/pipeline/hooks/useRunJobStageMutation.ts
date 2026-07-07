import {
  DEFAULT_PIPELINE_LLM_MODEL,
  type ActionRunResponse,
  type RunJobStageRequest,
  type Stage,
} from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";
import { applyRunsKeys } from "../../operations/applyRunsKeys.js";
import { workflowRunsKeys } from "../../operations/workflowRunsKeys.js";
import { patchStageState } from "../lib/jobDetailPatches.js";

export interface RunJobStageVariables {
  readonly jobId: JobId;
  readonly stage: Stage;
  readonly dryRun?: boolean;
}

function toRequest(variables: RunJobStageVariables): RunJobStageRequest {
  return {
    stage: variables.stage,
    dryRun: variables.dryRun ?? false,
    limit: 1,
    workers: 1,
    minScore: 7,
    validationMode: "normal",
    llmModel: DEFAULT_PIPELINE_LLM_MODEL,
  };
}

export function useRunJobStageMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  RunJobStageVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ActionRunResponse, RunJobStageVariables>(queryClient, {
      mutationFn: (variables) => api.runJobStage(variables.jobId, toRequest(variables)),
      optimisticUpdates: ({ jobId, stage }) => [
        {
          queryKey: jobsKeys.detail(tenantId, jobId),
          patch: (current) => patchStageState(current, stage, "running"),
        },
      ],
      settle: ({ jobId }) => [
        jobsKeys.detail(tenantId, jobId),
        jobsKeys.lists(tenantId),
        dashboardKeys.summary(tenantId),
        workflowRunsKeys.lists(tenantId),
        applyRunsKeys.lists(tenantId),
      ],
    }),
  );
}
