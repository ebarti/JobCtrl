import type {
  ActionRunResponse,
  BulkRescoreJobsNotOnCurrentScoringPolicyRequest,
} from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";

export interface RescoreJobVariables {
  readonly jobId: JobId;
  readonly dryRun?: boolean;
  readonly reason?: string;
}

export interface RescoreCurrentPolicyVariables {
  readonly jobKeys?: readonly JobId[];
  readonly limit?: number;
  readonly dryRun?: boolean;
  readonly reason?: string;
}

export function useRescoreJobMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  RescoreJobVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ jobId, dryRun = false, reason }) =>
      api.rescoreJob(jobId, { dryRun, ...(reason ? { reason } : {}) }),
    onSettled: async (_data, _error, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: jobsKeys.detail(tenantId, variables.jobId) }),
        queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function useRescoreCurrentPolicyMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  RescoreCurrentPolicyVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables) => api.rescoreJobsNotOnCurrentScoringPolicy(toBulkRequest(variables)),
    onSettled: async (_data, _error, variables) => {
      const jobKeys = variables.jobKeys ?? [];
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }),
        queryClient.invalidateQueries({
          queryKey: jobKeys.length ? jobsKeys.details(tenantId) : jobsKeys.all(tenantId),
        }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

function toBulkRequest(
  variables: RescoreCurrentPolicyVariables,
): BulkRescoreJobsNotOnCurrentScoringPolicyRequest {
  const jobKeys = [...(variables.jobKeys ?? [])];
  const requestedLimit = variables.limit ?? 100;
  return {
    jobKeys,
    limit: jobKeys.length ? Math.max(requestedLimit, jobKeys.length) : requestedLimit,
    dryRun: variables.dryRun ?? false,
    ...(variables.reason ? { reason: variables.reason } : {}),
  };
}
