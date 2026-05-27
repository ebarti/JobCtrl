import type {
  ActionRunResponse,
  BulkRetailorCurrentPolicyRequest,
  RetailorJobRequest,
} from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { artifactsKeys } from "../../operations/artifactsKeys.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";

export interface RetailorJobVariables {
  readonly jobId: JobId;
  readonly dryRun?: boolean;
  readonly suppressExistingArtifacts?: boolean;
  readonly reason?: string;
}

export interface RetailorCurrentPolicyVariables {
  readonly jobKeys?: readonly JobId[];
  readonly limit?: number;
  readonly dryRun?: boolean;
  readonly suppressExistingArtifacts?: boolean;
  readonly reason?: string;
}

export function useRetailorJobMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  RetailorJobVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables) => api.retailorJob(variables.jobId, toJobRequest(variables)),
    onSettled: async (_data, _error, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: jobsKeys.detail(tenantId, variables.jobId) }),
        queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }),
        queryClient.invalidateQueries({ queryKey: artifactsKeys.lists(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function useRetailorCurrentPolicyMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  RetailorCurrentPolicyVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables) => api.retailorCurrentPolicy(toBulkRequest(variables)),
    onSettled: async (_data, _error, variables) => {
      const jobKeys = variables.jobKeys ?? [];
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }),
        queryClient.invalidateQueries({
          queryKey: jobKeys.length ? jobsKeys.details(tenantId) : jobsKeys.all(tenantId),
        }),
        queryClient.invalidateQueries({ queryKey: artifactsKeys.lists(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

function toJobRequest(variables: RetailorJobVariables): Partial<RetailorJobRequest> {
  const request: Partial<RetailorJobRequest> = {
    dryRun: variables.dryRun ?? false,
    suppressExistingArtifacts: variables.suppressExistingArtifacts ?? true,
    tailorModels: [],
  };
  if (variables.reason) {
    request.reason = variables.reason;
  }
  return request;
}

function toBulkRequest(variables: RetailorCurrentPolicyVariables): BulkRetailorCurrentPolicyRequest {
  const jobKeys = [...(variables.jobKeys ?? [])];
  const requestedLimit = variables.limit ?? 100;
  const request: BulkRetailorCurrentPolicyRequest = {
    jobKeys,
    limit: jobKeys.length ? Math.max(requestedLimit, jobKeys.length) : requestedLimit,
    dryRun: variables.dryRun ?? false,
    suppressExistingArtifacts: variables.suppressExistingArtifacts ?? true,
    tailorModels: [],
  };
  if (variables.reason) {
    request.reason = variables.reason;
  }
  return request;
}
