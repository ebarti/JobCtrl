import type { CorrectScoreResponse, JobDetail, JobSummary, PaginatedResponse } from "@jobctl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";

export interface CorrectScoreVariables {
  readonly jobId: JobId;
  readonly correctedScore: number;
  readonly reason: string;
}

export function useCorrectScoreMutation(): UseMutationResult<
  CorrectScoreResponse,
  Error,
  CorrectScoreVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<CorrectScoreResponse, CorrectScoreVariables>(queryClient, {
      mutationFn: ({ jobId, correctedScore, reason }) =>
        api.correctScore(jobId, { correctedScore, reason }),
      optimisticUpdates: ({ jobId }) => [
        {
          queryKey: jobsKeys.detail(tenantId, jobId),
          patch: patchDetailScore,
        },
        {
          queryKey: jobsKeys.lists(tenantId),
          exact: false,
          patch: patchListScore,
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

function patchDetailScore(current: unknown, variables: CorrectScoreVariables): unknown {
  if (!isJobDetail(current)) return current;
  return {
    ...current,
    job: patchJobSummary(current.job, variables),
  };
}

function patchListScore(current: unknown, variables: CorrectScoreVariables): unknown {
  if (!isJobsPage(current)) return current;
  return {
    ...current,
    items: current.items.map((job) =>
      job.jobKey === variables.jobId ? patchJobSummary(job, variables) : job,
    ),
  };
}

function patchJobSummary(job: JobSummary, variables: CorrectScoreVariables): JobSummary {
  return {
    ...job,
    fitScore: variables.correctedScore,
    scoreStaleness: {
      isStale: false,
      staleReason: null,
      currentPolicyVersion: null,
      targetPolicyVersion: null,
      markedAt: null,
      pendingExplicitRescore: false,
    },
    scoreCorrection: {
      correctedScore: variables.correctedScore,
      rationale: variables.reason,
      correctedBy: "local",
      correctedAt: new Date().toISOString(),
    },
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
