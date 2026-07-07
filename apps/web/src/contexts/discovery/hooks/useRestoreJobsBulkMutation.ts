import type { BulkJobMutationRequest, JobMutationResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { patchListRemove } from "../lib/jobListPatches.js";

export function useRestoreJobsBulkMutation(): UseMutationResult<
  JobMutationResponse,
  Error,
  BulkJobMutationRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<JobMutationResponse, BulkJobMutationRequest>(queryClient, {
      mutationKey: jobsKeys.all(tenantId),
      mutationFn: (body) => api.restoreJobs(body),
      optimisticUpdates: (body) =>
        body.allMatching
          ? []
          : [
              {
                queryKey: jobsKeys.lists(tenantId),
                exact: false,
                patch: (current) => patchListRemove(current, new Set(body.jobKeys)),
              },
            ],
      settle: () => [jobsKeys.lists(tenantId), dashboardKeys.summary(tenantId)],
    }),
  );
}
