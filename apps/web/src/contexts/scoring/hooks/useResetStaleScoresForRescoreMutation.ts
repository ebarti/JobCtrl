import type {
  JobDetail,
  JobSummary,
  PaginatedResponse,
  ResetStaleScoresForRescoreResponse,
} from "@jobhunter/contracts";
import type { TenantId } from "@jobhunter/domain-types";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";

export interface ResetStaleScoresForRescoreVariables {
  readonly jobKeys?: readonly JobId[];
  readonly limit?: number;
}

const freshScoreStaleness: JobSummary["scoreStaleness"] = {
  isStale: false,
  staleReason: null,
  currentPolicyVersion: null,
  targetPolicyVersion: null,
  markedAt: null,
  pendingExplicitRescore: false,
};

export function useResetStaleScoresForRescoreMutation(): UseMutationResult<
  ResetStaleScoresForRescoreResponse,
  Error,
  ResetStaleScoresForRescoreVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<
      ResetStaleScoresForRescoreResponse,
      ResetStaleScoresForRescoreVariables
    >(queryClient, {
      mutationFn: ({ jobKeys = [], limit = 0 }) =>
        api.resetStaleScoresForRescore({ jobKeys: [...jobKeys], limit }),
      optimisticUpdates: (variables) => [
        {
          queryKey: jobsKeys.lists(tenantId),
          exact: false,
          patch: patchJobsPage,
        },
        ...detailPatchSpecs(tenantId, variables.jobKeys ?? []),
      ],
      settle: (variables, data) => {
        const jobKeys = data?.jobKeys.length
          ? data.jobKeys
          : [...(variables.jobKeys ?? [])];
        return [
          jobsKeys.lists(tenantId),
          dashboardKeys.summary(tenantId),
          ...(jobKeys.length
            ? jobKeys.map((jobKey) => jobsKeys.detail(tenantId, jobKey))
            : [jobsKeys.details(tenantId)]),
        ];
      },
    }),
  );
}

function detailPatchSpecs(tenantId: TenantId, jobKeys: readonly JobId[]) {
  return jobKeys.map((jobKey) => ({
    queryKey: jobsKeys.detail(tenantId, jobKey),
    patch: patchJobDetail,
  }));
}

function patchJobsPage(
  current: unknown,
  variables: ResetStaleScoresForRescoreVariables,
): unknown {
  if (!isJobsPage(current)) return current;
  return {
    ...current,
    items: current.items.map((job) => patchJobSummary(job, variables)),
  };
}

function patchJobDetail(
  current: unknown,
  variables: ResetStaleScoresForRescoreVariables,
): unknown {
  if (!isJobDetail(current)) return current;
  return {
    ...current,
    job: patchJobSummary(current.job, variables),
  };
}

function patchJobSummary(
  job: JobSummary,
  variables: ResetStaleScoresForRescoreVariables,
): JobSummary {
  const selected = variables.jobKeys?.length ? variables.jobKeys.includes(job.jobKey) : true;
  if (!selected || !job.scoreStaleness.isStale) {
    return job;
  }
  return {
    ...job,
    scoreStaleness: freshScoreStaleness,
    currentState: job.currentState === "stale" ? "pending" : job.currentState,
  };
}

function isJobDetail(value: unknown): value is JobDetail {
  return value !== null && typeof value === "object" && "job" in value;
}

function isJobsPage(value: unknown): value is PaginatedResponse<JobSummary> {
  return (
    value !== null &&
    typeof value === "object" &&
    "items" in value &&
    Array.isArray((value as PaginatedResponse<JobSummary>).items)
  );
}
