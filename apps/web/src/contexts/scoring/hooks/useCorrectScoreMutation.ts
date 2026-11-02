import type { CorrectScoreResponse, JobDetail, JobSummary, PaginatedResponse } from "@jobctrl/contracts";
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
      optimisticUpdates: ({ jobId }) => {
        const correctedAt = new Date().toISOString();
        return [
          {
            queryKey: jobsKeys.detail(tenantId, jobId),
            patch: (current, variables) => patchDetailScore(current, variables, correctedAt),
          },
          {
            queryKey: jobsKeys.lists(tenantId),
            exact: false,
            patch: (current, variables) => patchListScore(current, variables, correctedAt),
          },
        ];
      },
      settle: ({ jobId }) => [
        jobsKeys.detail(tenantId, jobId),
        jobsKeys.lists(tenantId),
        dashboardKeys.summary(tenantId),
      ],
    }),
  );
}

function patchDetailScore(current: unknown, variables: CorrectScoreVariables, correctedAt: string): unknown {
  if (!isJobDetail(current)) return current;
  return {
    ...current,
    job: patchJobSummary(current.job, variables, correctedAt),
  };
}

function patchListScore(current: unknown, variables: CorrectScoreVariables, correctedAt: string): unknown {
  if (!isJobsPage(current)) return current;
  return {
    ...current,
    items: current.items.map((job) =>
      job.jobKey === variables.jobId ? patchJobSummary(job, variables, correctedAt) : job,
    ),
  };
}

function patchJobSummary(job: JobSummary, variables: CorrectScoreVariables, correctedAt: string): JobSummary {
  return {
    ...job,
    fitScore: variables.correctedScore,
    scoreCorrection: {
      correctedScore: variables.correctedScore,
      rationale: variables.reason,
      correctedBy: "local",
      correctedAt,
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
