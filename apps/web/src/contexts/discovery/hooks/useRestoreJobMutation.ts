import type { JobMutationResponse } from "@jobctl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";
import { patchListRemove } from "../lib/jobListPatches.js";

export interface RestoreJobVariables {
  readonly jobId: JobId;
}

export function useRestoreJobMutation(): UseMutationResult<
  JobMutationResponse,
  Error,
  RestoreJobVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<JobMutationResponse, RestoreJobVariables>(queryClient, {
      mutationKey: jobsKeys.all(tenantId),
      mutationFn: ({ jobId }) => api.restoreJob(jobId),
      // Restoring a job moves it from the "deleted" tab to the "active" tab —
      // from the currently-viewed list it disappears, same as delete.
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
