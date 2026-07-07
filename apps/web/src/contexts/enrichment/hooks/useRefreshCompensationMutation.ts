import type {
  ActionRunResponse,
  RefreshCompensationRequest,
} from "@jobctrl/contracts";
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

export type RefreshAllCompensationVariables = RefreshCompensationRequest;

export function useRefreshCompensationMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  RefreshCompensationVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ jobId, ...request }) =>
      api.refreshCompensation(jobId, toRefreshCompensationRequest(request)),
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

export function useRefreshAllCompensationMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  RefreshAllCompensationVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables) => api.refreshAllCompensation(toRefreshCompensationRequest(variables)),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: jobsKeys.all(tenantId) }),
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

function toRefreshCompensationRequest(
  variables: RefreshCompensationRequest,
): RefreshCompensationRequest {
  return {
    ...(variables.observationsJsonPath ? { observationsJsonPath: variables.observationsJsonPath } : {}),
    ...(variables.includeEuroTopTech !== undefined ? { includeEuroTopTech: variables.includeEuroTopTech } : {}),
    ...(variables.euroTopTechMaxPages !== undefined ? { euroTopTechMaxPages: variables.euroTopTechMaxPages } : {}),
  };
}
