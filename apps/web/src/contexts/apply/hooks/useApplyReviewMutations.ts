import type {
  ApplicationOutcomeWriteResponse,
  ApplyReviewDecisionRequest,
  ApplyReviewDecisionResponse,
  ManualApplicationOutcomeRequest,
  OutcomeSuggestionDecisionRequest,
  OutcomeSuggestionDecisionResponse,
} from "@jobhunter/contracts";
import type { TenantId } from "@jobhunter/domain-types";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { applyReviewKeys } from "../../operations/applyReviewKeys.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { outcomesKeys } from "../../operations/outcomesKeys.js";
import type { JobId } from "../../operations/types.js";

export interface ApplyReviewDecisionVariables {
  readonly jobId: JobId;
  readonly body: ApplyReviewDecisionRequest;
}

export interface ManualApplicationOutcomeVariables {
  readonly jobId: JobId;
  readonly body: ManualApplicationOutcomeRequest;
}

export interface OutcomeSuggestionDecisionVariables {
  readonly suggestionId: string;
  readonly jobId?: JobId;
  readonly body: OutcomeSuggestionDecisionRequest;
}

function invalidateApplyReviewSurfaces(
  queryClient: QueryClient,
  tenantId: TenantId,
  jobId?: JobId,
): void {
  void queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) });
  void queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) });
  void queryClient.invalidateQueries({ queryKey: applyReviewKeys.queue(tenantId) });
  void queryClient.invalidateQueries({ queryKey: outcomesKeys.list(tenantId) });
  if (jobId) {
    void queryClient.invalidateQueries({ queryKey: jobsKeys.detail(tenantId, jobId) });
    void queryClient.invalidateQueries({ queryKey: outcomesKeys.detail(tenantId, jobId) });
  }
}

export function useApplyReviewDecisionMutation(): UseMutationResult<
  ApplyReviewDecisionResponse,
  Error,
  ApplyReviewDecisionVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, body }) => api.decideApplyReview(jobId, body),
    onSettled: (_data, _error, variables) => {
      invalidateApplyReviewSurfaces(queryClient, tenantId, variables.jobId);
    },
  });
}

export function useRecordManualApplicationOutcomeMutation(): UseMutationResult<
  ApplicationOutcomeWriteResponse,
  Error,
  ManualApplicationOutcomeVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, body }) => api.recordManualApplicationOutcome(jobId, body),
    onSettled: (_data, _error, variables) => {
      invalidateApplyReviewSurfaces(queryClient, tenantId, variables.jobId);
    },
  });
}

export function useOutcomeSuggestionDecisionMutation(): UseMutationResult<
  OutcomeSuggestionDecisionResponse,
  Error,
  OutcomeSuggestionDecisionVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ suggestionId, body }) => api.decideOutcomeSuggestion(suggestionId, body),
    onSettled: (_data, _error, variables) => {
      invalidateApplyReviewSurfaces(queryClient, tenantId, variables.jobId);
    },
  });
}
