import type { DeleteJobRequest, JobMutationResponse } from "@jobctl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";
import { patchListRemove } from "../lib/jobListPatches.js";

export interface DeleteJobVariables {
  readonly jobId: JobId;
  readonly body?: DeleteJobRequest;
}

export function useDeleteJobMutation(): UseMutationResult<
  JobMutationResponse,
  Error,
  DeleteJobVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<JobMutationResponse, DeleteJobVariables>(queryClient, {
      mutationKey: jobsKeys.all(tenantId),
      mutationFn: ({ jobId, body }) => api.deleteJob(jobId, body ?? {}),
      optimisticUpdates: ({ jobId }) => [
        {
          queryKey: jobsKeys.lists(tenantId),
          exact: false,
          patch: (current) => patchListRemove(current, new Set([jobId])),
        },
      ],
      settle: ({ jobId }) => [
        jobsKeys.lists(tenantId),
        jobsKeys.detail(tenantId, jobId),
        dashboardKeys.summary(tenantId),
      ],
    }),
  );
}
