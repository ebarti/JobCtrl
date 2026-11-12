import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { createUnconfirmedWriteError } from "../../shared/lib/unconfirmed-write.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";

const qualifierSchema = z.object({ dimension: z.string(), value: z.string() });
export const canonicalRequirementSchema = z.object({
  requirement_id: z.string(), revision: z.number().int().positive(), definition: z.string(),
  scope: z.enum(["resume", "eligibility", "logistics", "employer_condition"]),
  qualifiers: z.array(qualifierSchema), provenance: z.record(z.string(), z.unknown()).optional(), created_at: z.string().optional(),
}).passthrough();
const occurrenceSchema = z.object({
  occurrence_id: z.string(), requirement_id: z.string(), requirement_revision: z.number().int().positive(),
  job_id: z.string(), posting_revision: z.number().int().positive(), text: z.string(),
  definition: z.string(), scope: z.string(), qualifiers: z.array(qualifierSchema), tier: z.string(), weight: z.number(),
  source_id: z.string(), source_revision: z.number().int().positive(), source_hash: z.string(),
  spans: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string() })),
  extraction_determination_id: z.string(), equivalence_determination_ids: z.array(z.string()),
  provenance: z.record(z.string(), z.unknown()),
}).passthrough();
const catalogSchema = z.object({ catalog_revision: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  requirements: z.array(canonicalRequirementSchema) });
const detailSchema = canonicalRequirementSchema.extend({ current_revision: z.number().int().positive(), occurrences: z.array(occurrenceSchema) });
const freshness = { current: z.boolean(), stale_reasons: z.array(z.string()) };
const historyBase = z.object({ requirement_id: z.string(), current_revision: z.number().int().positive(),
  total: z.number().int().nonnegative(), limit: z.number().int().positive(), offset: z.number().int().nonnegative() });
const historySchema = z.discriminatedUnion("kind", [
  historyBase.extend({ kind: z.literal("revisions"), rows: z.array(canonicalRequirementSchema.extend(freshness)) }),
  historyBase.extend({ kind: z.literal("occurrences"), rows: z.array(occurrenceSchema.extend({ ...freshness,
    accepted: z.boolean(), snapshot_revision: z.number().int().positive() })) }),
]);
export type CanonicalRequirement = z.infer<typeof canonicalRequirementSchema>;
export type RequirementDetail = z.infer<typeof detailSchema>;
export type RequirementHistory = z.infer<typeof historySchema>;
export type RequirementOccurrence = z.infer<typeof occurrenceSchema>;
export type RequirementCatalog = z.infer<typeof catalogSchema>;
export type RequirementHistoryKind = "revisions" | "occurrences";

export const requirementLibraryKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "requirements"] as const,
  catalog: (tenantId: string, q: string, limit: number, offset: number) =>
    [...requirementLibraryKeys.all(tenantId), "library", q, limit, offset] as const,
  detail: (tenantId: string, id: string, revision?: number) =>
    [...requirementLibraryKeys.all(tenantId), "detail", id, revision ?? "current"] as const,
  history: (tenantId: string, id: string, kind: RequirementHistoryKind, limit: number, offset: number) =>
    [...requirementLibraryKeys.all(tenantId), "history", id, kind, limit, offset] as const,
};

export function useRequirementCatalog({ q = "", limit = 50, offset = 0 }: { q?: string; limit?: number; offset?: number } = {}) {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: requirementLibraryKeys.catalog(tenantId, q, limit, offset), queryFn: async () => {
    const result = catalogSchema.safeParse(await http.json<unknown>("GET", "/v1/requirements", { query: { q, limit, offset } }));
    if (!result.success) throw new Error("The requirement catalog could not be verified.");
    return result.data;
  }, meta: { suppressGlobalErrorToast: true } });
}

export function useRequirementDetail(requirementId: string, revision?: number) {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: requirementLibraryKeys.detail(tenantId, requirementId, revision), enabled: Boolean(requirementId), queryFn: async () => {
    const result = detailSchema.safeParse(await http.json<unknown>("GET", `/v1/requirements/${encodeURIComponent(requirementId)}`,
      { query: revision === undefined ? {} : { revision } }));
    if (!result.success) throw new Error("The requirement definition could not be verified.");
    return result.data;
  }, meta: { suppressGlobalErrorToast: true } });
}

export function useRequirementHistory(requirementId: string, { kind = "revisions", limit = 50, offset = 0 }: {
  kind?: RequirementHistoryKind; limit?: number; offset?: number;
} = {}) {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: requirementLibraryKeys.history(tenantId, requirementId, kind, limit, offset), enabled: Boolean(requirementId), queryFn: async () => {
    const result = historySchema.safeParse(await http.json<unknown>("GET", `/v1/requirements/${encodeURIComponent(requirementId)}/history`,
      { query: { kind, limit, offset } }));
    if (!result.success || result.data.kind !== kind) throw new Error("The requirement history could not be verified.");
    return result.data;
  }, meta: { suppressGlobalErrorToast: true } });
}

export type RequirementMeaningCorrection = {
  expected_revision: number; job_id: string; expected_posting_revision: number; reason: string;
  proposed: { local_id: string; definition: string; scope: CanonicalRequirement["scope"]; qualifiers: CanonicalRequirement["qualifiers"];
    text: string; tier: "must_have" | "nice_to_have"; weight: number; support: "supported";
    spans: Array<{ start: number; end: number; quote: string }> };
};

/** This explicit action performs the existing source-bound model correction. */
export function useRequirementMeaningCorrection() {
  const tenantId = useTenantId(); const { http } = usePorts(); const client = useQueryClient();
  return useMutation({ mutationFn: async ({ requirementId, body }: { requirementId: string; body: RequirementMeaningCorrection }) => {
    const path = `/v1/requirements/${encodeURIComponent(requirementId)}/revisions`;
    const value = await http.json<unknown>("POST", path, { body });
    const result = canonicalRequirementSchema.safeParse(value);
    if (!result.success) throw createUnconfirmedWriteError("POST", path, new Error("The saved requirement revision could not be verified."));
    return result.data;
  }, onSuccess: () => client.invalidateQueries({ queryKey: requirementLibraryKeys.all(tenantId) }) });
}
