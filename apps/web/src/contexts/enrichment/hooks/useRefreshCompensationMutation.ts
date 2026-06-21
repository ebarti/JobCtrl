import type {
  ActionRunResponse,
  RefreshCompensationRequest,
} from "@jobhunter/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";
import { enrichmentKeys } from "../queryKeys.js";

export interface RefreshCompensationVariables extends RefreshCompensationRequest {
  readonly jobId: JobId;
}

export function useRefreshCompensationMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  RefreshCompensationVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ jobId, observationsJsonPath }) =>
      api.refreshCompensation(jobId, {
        ...(observationsJsonPath ? { observationsJsonPath } : {}),
      }),
    onSettled: async (_data, _error, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: jobsKeys.detail(tenantId, variables.jobId),
        }),
        queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }),
        queryClient.invalidateQueries({
          queryKey: enrichmentKeys.all(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: dashboardKeys.summary(tenantId),
        }),
      ]);
    },
  });
}
