import { compareOutcomeSuggestionDecision, type ApplicationOutcomeWriteResponse, type ManualApplicationOutcomeRequest, type OutcomeSuggestionDecisionRequest, type OutcomeSuggestionDecisionResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { invalidateQueriesWithOptimisticOwnership } from "../../../shared/lib/createOptimisticMutation.js";
import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { analyticsKeys, outcomesKeys } from "../outcomes.js";

export interface ManualApplicationOutcomeVariables {
  readonly jobId: string;
  readonly body: ManualApplicationOutcomeRequest;
}
export interface OutcomeSuggestionDecisionVariables {
  readonly suggestionId: string;
  readonly jobId?: string;
  readonly expectedVersion: number;
  readonly body: OutcomeSuggestionDecisionRequest;
}

export function useRecordManualApplicationOutcomeMutation(): UseMutationResult<ApplicationOutcomeWriteResponse, Error, ManualApplicationOutcomeVariables> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ jobId, body }) => {
      const path = `/v1/jobs/${encodeURIComponent(jobId)}/outcomes`;
      const response = await http.json<ApplicationOutcomeWriteResponse & { disposition: "applied" | "replayed" }>("POST", path, { body });
      const outcome = response?.outcome;
      if (response?.ok !== true || !["applied", "replayed"].includes(response.disposition) || !outcome?.outcomeId ||
          outcome.jobKey !== jobId || outcome.kind !== body.kind || outcome.source !== "manual" ||
          outcome.note !== (body.note ?? null) || outcome.interviewPrepGeneration !== (body.interviewPrepGeneration ?? null) ||
          (body.occurredAt !== undefined && outcome.occurredAt !== body.occurredAt)) {
        throw createUnconfirmedWriteError("POST", path, new TypeError("The outcome response did not confirm the submitted facts"));
      }
      return response;
    },
    onSettled: (_data, _error, { jobId }) => {
      void invalidateQueriesWithOptimisticOwnership(client, outcomesKeys.detail(tenantId, jobId));
      void invalidateQueriesWithOptimisticOwnership(client, outcomesKeys.list(tenantId));
      void invalidateQueriesWithOptimisticOwnership(client, analyticsKeys.all(tenantId));
    },
  });
}

export function useOutcomeSuggestionDecisionMutation(): UseMutationResult<OutcomeSuggestionDecisionResponse, Error, OutcomeSuggestionDecisionVariables> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ suggestionId, jobId, expectedVersion, body }) => {
      const path = `/v1/outcomes/suggestions/${encodeURIComponent(suggestionId)}/decision`;
      const response = await http.json<OutcomeSuggestionDecisionResponse>("POST", path, { body: { ...body, expectedVersion } });
      let decisionMatches = false;
      try {
        decisionMatches = Boolean(response?.suggestion) &&
          compareOutcomeSuggestionDecision(body, response.suggestion, response.outcome, body.occurredAt !== undefined) === "replayed";
      } catch { /* A malformed acknowledgement cannot prove the write. */ }
      if (response?.ok !== true || !["applied", "replayed"].includes(response.disposition) ||
          !response.suggestion || response.suggestion.suggestionId !== suggestionId ||
          (jobId !== undefined && response.suggestion.jobKey !== jobId) ||
          !decisionMatches) {
        throw createUnconfirmedWriteError("POST", path, new TypeError("The suggestion response did not confirm the submitted decision"));
      }
      return response;
    },
    onSettled: (_data, _error, { jobId }) => {
      if (jobId) void invalidateQueriesWithOptimisticOwnership(client, outcomesKeys.detail(tenantId, jobId));
      void invalidateQueriesWithOptimisticOwnership(client, outcomesKeys.list(tenantId));
      void invalidateQueriesWithOptimisticOwnership(client, analyticsKeys.all(tenantId));
    },
  });
}
