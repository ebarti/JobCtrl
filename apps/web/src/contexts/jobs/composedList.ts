import { useQuery, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type { DomainEventEnvelope } from "../../shared/ports/EventStreamPort.js";
import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";

export interface JobGridTextFilter { operator: "contains" | "does_not_contain"; text: string; selectedValues: string[] }
export interface JobGridQuery {
  q: string; job_state: string; sort: string; direction: "asc" | "desc"; offset: number; limit: number;
  source?: string; company?: string; min_fit_score?: number; max_fit_score?: number; fit_state?: "all" | "current" | "stale" | "unassessed";
  stage?: string; state?: string; discovered_since?: string; scored_since?: string;
  posted_min_eur?: number; posted_max_eur?: number; market_min_eur?: number; market_max_eur?: number;
  posted_known?: "all" | "known" | "unknown"; market_known?: "all" | "known" | "unknown"; compensation_confidence?: string; compensation_warnings?: "all" | "present" | "none";
  query_revision?: string;
  column_filters?: Record<string, JobGridTextFilter | undefined>;
}
const job = z.object({ job_id: z.string(), revision: z.number(), source_id: z.string(), source_revision: z.number(),
  source_hash: z.string(), title: z.string(), company: z.string().nullable().optional(), description: z.string(),
  location: z.string().nullable().optional(), url: z.string(), application_url: z.string().nullable().optional(),
  active_state: z.string().optional(), observed_at: z.string().optional(), provenance: z.unknown().optional(),
  hidden: z.boolean(), deleted: z.boolean(), state_revision: z.number() }).passthrough();
const feature = z.object({ enabled: z.boolean(), available: z.boolean() }).passthrough();
const fit = z.object({ current: z.boolean(), stale_reasons: z.array(z.string()).optional(),
  score: z.object({ score: z.number().nullable(), contract_version: z.string().optional(), formula_version: z.string().optional(),
    eligibility: z.object({ status: z.string() }).passthrough() }).passthrough().nullable() }).passthrough();
const preparation = z.object({ stage: z.string().nullable(), state: z.string().nullable() }).passthrough();
const compensation = z.object({ summary: z.object({
  posted: z.object({ displayRange: z.string().nullable(), recordStatus: z.string() }).passthrough(),
  market: z.object({ displayRange: z.string().nullable(), recordStatus: z.string(), estimateState: z.string() }).passthrough(),
}).passthrough().nullable(), audit: z.object({
  posted: z.object({ sourceCurrent: z.boolean().optional() }).passthrough(),
  market: z.object({ sourceCurrent: z.boolean().optional(), evidenceFresh: z.boolean().optional() }).passthrough(),
}).passthrough().nullable(), refresh: z.unknown().nullable() }).passthrough();
const response = z.object({ rows: z.array(z.object({ job, fit: fit.nullable(), preparation: preparation.nullable(),
  compensation: compensation.nullable(), scalars: z.record(z.string(), z.unknown()), revisions: z.record(z.string(), z.unknown()) }).passthrough()),
  total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive(), query_revision: z.string(),
  modules: z.object({ fit: feature, preparation: feature, compensation: feature, applications: feature.optional(), resumes: feature.optional() }).passthrough(),
  capabilities: z.object({ sortable_fields: z.array(z.string()), filterable_fields: z.array(z.string()) }).passthrough(),
  facets: z.record(z.string(), z.object({ values: z.array(z.string()), complete: z.boolean() }).passthrough()),
}).passthrough();
export type ComposedJobsResponse = z.infer<typeof response>;
export type ComposedJobRow = ComposedJobsResponse["rows"][number];
export const composedJobsKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "jobs", "list"] as const,
  list: (tenantId: string, input: JobGridQuery) => [...composedJobsKeys.all(tenantId), "composed", input] as const,
};
export function useComposedJobs(input: JobGridQuery) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: composedJobsKeys.list(tenantId, input),
    // Preserve only same-tenant metadata for controls while a new query loads.
    // Consumers must not present placeholder rows as the new result.
    placeholderData: (previous, query) => query?.queryKey[1] === tenantId ? previous : undefined,
    queryFn: async () => {
      const { column_filters, ...query } = input;
      const result = response.safeParse(await http.json<unknown>("GET", "/v1/jobs/query", { query: {
        ...query, ...(column_filters && Object.keys(column_filters).length ? { column_filters: JSON.stringify(column_filters) } : {}),
      } }));
      if (!result.success) throw new Error("The composed jobs response could not be verified.");
      return result.data;
    },
    meta: { suppressGlobalErrorToast: true },
  });
}
/** Cross-feature changes can affect ordering, membership, and every result page. */
export const composedJobsEvents = {
  eventTypes: ["FitAssessed", "FitCorrected", "FitRequirementCorrected", "FitCoverageUpdated", "ProfileUpdated", "ProfileWordingUpdated", "ProfileSourceUpdated", "RequirementsUpdated", "RequirementBindingCorrected", "RequirementMeaningRevised", "PreparationUpdated", "CompensationEvidenceChanged", "CompensationRefreshChanged", "CompensationSourcePolicyChanged", "ApplicationSubmitted", "ApplicationsUpdated", "ApplicationOutcomeRecorded", "ResumeComposed", "ResumeEdited", "ResumeReviewed", "ResumeRendered", "ResumeAccepted", "ResumeTemplateUpdated"] as const,
  handle(event: DomainEventEnvelope, client: QueryClient) {
    void invalidateQueriesWithOptimisticOwnership(client, composedJobsKeys.all(event.tenantId));
  },
};
