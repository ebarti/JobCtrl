import type { ActionRunResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";
import {
  patchDetailApplyStatus,
  patchListApplyStatus,
} from "../lib/jobDetailPatches.js";

export interface MarkSkippedVariables {
  readonly jobId: JobId;
}

export function useMarkSkippedMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  MarkSkippedVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ActionRunResponse, MarkSkippedVariables>(queryClient, {
      mutationFn: ({ jobId }) => api.markSkipped(jobId, {}),
      optimisticUpdates: ({ jobId }) => [
        {
          queryKey: jobsKeys.detail(tenantId, jobId),
          patch: (current) => patchDetailApplyStatus(current, "skipped"),
        },
        {
          queryKey: jobsKeys.lists(tenantId),
          exact: false,
          patch: (current) => patchListApplyStatus(current, jobId, "skipped"),
        },
      ],
      settle: ({ jobId }) => [
        jobsKeys.detail(tenantId, jobId),
        jobsKeys.lists(tenantId),
        dashboardKeys.summary(tenantId),
      ],
    }),
  );
}
