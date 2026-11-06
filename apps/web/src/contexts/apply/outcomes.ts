import type { ApplicationOutcomeListResponse, JobApplicationOutcomeListResponse, OutcomeAnalyticsSummary, OutcomeSuggestion } from "@jobctrl/contracts";
import type { TenantId } from "@jobctrl/domain-types";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { HttpLoaderReadContext, HttpReadContext } from "../../shared/lib/loaderReadContext.js";
import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";

/** The applications owner supplies the persisted version used for review CAS. */
export type VersionedOutcomeSuggestion = OutcomeSuggestion & { readonly version: number };
export type OutcomeList = Omit<ApplicationOutcomeListResponse, "suggestions"> & {
  readonly suggestions: VersionedOutcomeSuggestion[];
};
export type JobOutcomeList = Omit<JobApplicationOutcomeListResponse, "suggestions"> & {
  readonly suggestions: VersionedOutcomeSuggestion[];
};

export const outcomesKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "outcomes"] as const,
  lists: (tenantId: TenantId) => [...outcomesKeys.all(tenantId), "list"] as const,
  list: (tenantId: TenantId) => [...outcomesKeys.lists(tenantId), "global"] as const,
  details: (tenantId: TenantId) => [...outcomesKeys.all(tenantId), "job"] as const,
  detail: (tenantId: TenantId, jobId: string) => [...outcomesKeys.details(tenantId), jobId] as const,
  suggestionAudit: (tenantId: TenantId, suggestionId: string, receiptId: string) =>
    [...outcomesKeys.all(tenantId), "suggestion-audit", suggestionId, receiptId] as const,
};

export interface OutcomeAnalyticsFilters { readonly dimension?: string }
export const analyticsKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "analytics"] as const,
  outcomes: (tenantId: TenantId, filters: OutcomeAnalyticsFilters = {}) =>
    [...analyticsKeys.all(tenantId), "outcomes", filters] as const,
};

export function applicationOutcomesQuery(context: HttpReadContext) {
  return {
    queryKey: outcomesKeys.list(context.tenantId),
    queryFn: () => context.ports.http.json<OutcomeList>("GET", "/v1/outcomes"),
  };
}
export function prefetchApplicationOutcomes(context: HttpLoaderReadContext) {
  return context.queryClient.prefetchQuery(applicationOutcomesQuery(context));
}
export function outcomeAnalyticsQuery(context: HttpReadContext, filters: OutcomeAnalyticsFilters) {
  return {
    queryKey: analyticsKeys.outcomes(context.tenantId, filters),
    queryFn: () => context.ports.http.json<OutcomeAnalyticsSummary>("GET", "/v1/analytics/outcomes"),
  };
}
export function prefetchOutcomeAnalytics(context: HttpLoaderReadContext, filters: OutcomeAnalyticsFilters) {
  return context.queryClient.prefetchQuery(outcomeAnalyticsQuery(context, filters));
}
export function useApplicationOutcomesQuery(): UseQueryResult<OutcomeList> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery(applicationOutcomesQuery({ tenantId, ports: { http } }));
}
export function useJobApplicationOutcomesQuery(jobId: string): UseQueryResult<JobOutcomeList> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: outcomesKeys.detail(tenantId, jobId),
    queryFn: () => http.json<JobOutcomeList>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/outcomes`),
    enabled: Boolean(jobId),
  });
}
export function useOutcomeAnalyticsQuery(filters: OutcomeAnalyticsFilters = {}): UseQueryResult<OutcomeAnalyticsSummary> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({ ...outcomeAnalyticsQuery({ tenantId, ports: { http } }, filters), staleTime: 0, refetchOnMount: "always" });
}

export const outcomeEvents: FeatureEventHandler = {
  eventTypes: ["ApplicationOutcomeRecorded", "OutcomeSuggestionCreated", "OutcomeSuggestionDecided", "ApplicationSubmitted", "ApplicationsUpdated", "JobCaptured", "JobSourceObserved", "JobUpdated", "FitAssessed", "FitCorrected", "FitRequirementCorrected", "ResumeAccepted", "ResumeTemplateUpdated", "OfferRecordChanged"],
  handle(event, client) {
    const payload = event.payload;
    const jobId = payload && typeof payload === "object" && "jobId" in payload && typeof payload.jobId === "string"
      ? payload.jobId : event.aggregateId;
    void invalidateQueriesWithOptimisticOwnership(client, jobId ? outcomesKeys.detail(event.tenantId, jobId) : outcomesKeys.all(event.tenantId));
    void invalidateQueriesWithOptimisticOwnership(client, outcomesKeys.list(event.tenantId));
    void invalidateQueriesWithOptimisticOwnership(client, analyticsKeys.all(event.tenantId));
  },
};
