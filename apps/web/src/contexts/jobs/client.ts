import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import type { DomainEventEnvelope } from "../../shared/ports/EventStreamPort.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";

const jobSchema = z.object({
  job_id: z.string(), revision: z.number(), source_id: z.string(), source_revision: z.number(), source_hash: z.string(),
  title: z.string(), company: z.string().nullable().optional(), description: z.string(),
  location: z.string().nullable().optional(), url: z.string(), application_url: z.string().nullable().optional(),
  active_state: z.string().optional(), observed_at: z.string().optional(), provenance: z.unknown().optional(),
  hidden: z.boolean(), deleted: z.boolean(), state_revision: z.number(),
}).passthrough();
const listSchema = z.object({ jobs: z.array(jobSchema), total: z.number(), offset: z.number(), limit: z.number() }).passthrough();
export type PostingSnapshot = z.infer<typeof jobSchema>;
export const jobsKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "jobs"] as const,
  lists: (tenantId: string) => [...jobsKeys.all(tenantId), "list"] as const,
  list: (tenantId: string, q: string, offset: number, limit: number, status: string, sort: string, direction: string) => [...jobsKeys.lists(tenantId), { q, offset, limit, status, sort, direction }] as const,
  detail: (tenantId: string, jobId: string) => [...jobsKeys.all(tenantId), "detail", jobId] as const,
};
function parseJob(value: unknown): PostingSnapshot {
  const parsed = jobSchema.safeParse(value);
  if (!parsed.success) throw new Error("The captured posting response is invalid.");
  return parsed.data;
}
function parseList(value: unknown) {
  const parsed = listSchema.safeParse(value);
  if (!parsed.success) throw new Error("The jobs list response is invalid.");
  return parsed.data;
}
export function useJobs(q: string, offset: number, limit: number, status = "active", sort = "created_at", direction = "desc") {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: jobsKeys.list(tenantId, q, offset, limit, status, sort, direction),
    queryFn: async () => parseList(await http.json<unknown>("GET", "/v1/jobs", { query: { q, offset, limit, status, sort, direction, include_hidden: status === "hidden" || status === "deleted" || status === "all" } })),
    meta: { suppressGlobalErrorToast: true },
  });
}
export function useJob(jobId: string) {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: jobsKeys.detail(tenantId, jobId),
    queryFn: async () => parseJob(await http.json<unknown>("GET", `/v1/jobs/${encodeURIComponent(jobId)}`)),
    meta: { suppressGlobalErrorToast: true },
  });
}
export function useJobActions(jobId?: string) {
  const tenantId = useTenantId(); const { http } = usePorts(); const client = useQueryClient();
  const update = (job: PostingSnapshot) => {
    client.setQueryData<PostingSnapshot>(jobsKeys.detail(tenantId, job.job_id), (current) =>
      current && (current.revision > job.revision || current.state_revision > job.state_revision) ? current : job);
    void client.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) });
  };
  const capture = useMutation({ mutationFn: async (body: { url: string; title: string; company: string; description: string; location: string }) =>
    parseJob(await http.json<unknown>("POST", "/v1/jobs/capture", { body })), onSuccess: update });
  const importUrl = useMutation({ mutationFn: async (url: string) =>
    parseJob(await http.json<unknown>("POST", "/v1/jobs/import-url", { body: { url } })), onSuccess: update });
  const refresh = useMutation({ mutationFn: async (revision: number) => {
    if (!jobId) throw new Error("No job selected.");
    return parseJob(await http.json<unknown>("POST", `/v1/jobs/${encodeURIComponent(jobId)}/refresh`, { body: { expectedRevision: revision } }));
  }, onSuccess: update });
  const checkAvailability = useMutation({ mutationFn: async (revision: number) => {
    if (!jobId) throw new Error("No job selected.");
    return parseJob(await http.json<unknown>("POST", `/v1/jobs/${encodeURIComponent(jobId)}/availability`, { body: { expectedRevision: revision } }));
  }, onSuccess: update });
  return { capture, importUrl, refresh, checkAvailability };
}
const deletionSelectionSchema = z.object({ selectionId: z.string(), jobIds: z.array(z.string()), count: z.number(), expiresAt: z.string(),
  retentionNotice: z.string(), retainedIndependentData: z.array(z.string()),
  jobs: z.array(z.object({ job_id: z.string(), title: z.string(), company: z.string().nullable() }).passthrough()),
}).passthrough();
export function useJobBulkActions() {
  const tenantId = useTenantId(); const { http } = usePorts(); const client = useQueryClient();
  const bulk = useMutation({ mutationFn: (input: { action: "hide" | "unhide" | "delete" | "restore"; selected: readonly PostingSnapshot[] }) =>
    http.json<unknown>("POST", `/v1/jobs/bulk-${input.action}`, { body: { jobIds: input.selected.map((job) => job.job_id),
      expectedRevisions: Object.fromEntries(input.selected.map((job) => [job.job_id, job.revision])),
      expectedStateRevisions: Object.fromEntries(input.selected.map((job) => [job.job_id, job.state_revision])) } }),
    onSuccess: () => client.invalidateQueries({ queryKey: jobsKeys.all(tenantId) }),
  });
  const previewDelete = useMutation({ mutationFn: async (ids: readonly string[]) => {
    const result = deletionSelectionSchema.safeParse(await http.json<unknown>("POST", "/v1/jobs/permanent-delete-selection", { body: { jobIds: ids } }));
    if (!result.success) throw new Error("The deletion selection could not be verified.");
    return result.data;
  } });
  const permanentDelete = useMutation({ mutationFn: (input: { selectionId: string; jobIds: string[] }) =>
    http.json<unknown>("POST", "/v1/jobs/bulk-delete-permanent", { body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: jobsKeys.all(tenantId) }),
  });
  return { bulk, previewDelete, permanentDelete };
}
export const jobsInvalidation = {
  eventTypes: ["JobCaptured", "JobSourceObserved", "JobUpdated", "JobCaptureAttempted", "PostingQuarantined", "JobAnalysisUpdated"] as const,
  handle(event: DomainEventEnvelope, client: QueryClient) { void invalidateQueriesWithOptimisticOwnership(client, jobsKeys.all(event.tenantId)); },
};
