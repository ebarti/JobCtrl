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

export interface MarkAppliedVariables {
  readonly jobId: JobId;
}

export function useMarkAppliedMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  MarkAppliedVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ActionRunResponse, MarkAppliedVariables>(queryClient, {
      mutationFn: ({ jobId }) => api.markApplied(jobId, {}),
      optimisticUpdates: ({ jobId }) => [
        {
          queryKey: jobsKeys.detail(tenantId, jobId),
          patch: (current) => patchDetailApplyStatus(current, "applied"),
        },
        {
          queryKey: jobsKeys.lists(tenantId),
          exact: false,
          patch: (current) => patchListApplyStatus(current, jobId, "applied"),
        },
      ],
      // Stage transitions also affect dashboard funnel counts; settle invalidation
      // covers the broader recompute that §8.2's per-mutation list omits.
      settle: ({ jobId }) => [
        jobsKeys.detail(tenantId, jobId),
        jobsKeys.lists(tenantId),
        dashboardKeys.summary(tenantId),
      ],
    }),
  );
}
