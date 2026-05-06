import type { ActionRunResponse, ApplyJobRequest } from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";

export interface ApplyJobVariables {
  readonly jobId: JobId;
  readonly body?: Partial<ApplyJobRequest>;
}

export function useApplyJobMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  ApplyJobVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ActionRunResponse, ApplyJobVariables>(queryClient, {
      mutationFn: ({ jobId, body }) => api.applyJob(jobId, body ?? {}),
      settle: ({ jobId }) => [
        jobsKeys.detail(tenantId, jobId),
        jobsKeys.lists(tenantId),
        dashboardKeys.summary(tenantId),
      ],
    }),
  );
}
