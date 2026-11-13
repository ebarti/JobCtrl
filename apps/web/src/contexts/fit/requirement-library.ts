import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { createUnconfirmedWriteError } from "../../shared/lib/unconfirmed-write.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";

const sourceSchema = z.object({ source_id: z.string(), revision: z.union([z.number().int().positive(), z.string()]) }).passthrough();
const evidenceSchema = sourceSchema.extend({ quote: z.string() });
const freshness = { current: z.boolean(), stale_reasons: z.array(z.string()) };
const wordingBindingSchema = z.object({ variant_id: z.string(), variant_revision: z.number().int().positive(),
  exact_text: z.string(), source_refs: z.array(z.object({ source_id: z.string(), revision: z.number().int().positive() })) });
const associationSchema = z.object({ association_id: z.string(), revision: z.number().int().positive(), profile_id: z.string(),
  requirement_id: z.string(), requirement_revision: z.number().int().positive(), achievement_id: z.string(), role_id: z.string(),
  achievement_source_refs: z.array(z.object({ source_id: z.string(), revision: z.number().int().positive() })),
  wording: wordingBindingSchema.nullable(), origin: z.literal("user"), assessment_status: z.literal("unassessed"),
  state: z.enum(["active", "removed"]), created_at: z.string(), updated_at: z.string(), ...freshness,
}).passthrough();
const assessmentSchema = z.object({ assessment_id: z.string(), requirement_id: z.string(),
  requirement_revision: z.union([z.number(), z.string()]), definition: z.string(),
  achievement_ids: z.array(z.string()), evidence_refs: z.array(evidenceSchema),
  kind: z.enum(["matched", "transferable", "missing", "blocked", "not_assessed"]),
  origin: z.enum(["model", "manual", "revalidated", "bundled_synthetic_example"]), rationale: z.string(), confidence: z.string(),
  category: z.enum(["skill", "professional_experience", "education", "language"]).optional(), name: z.string().optional(),
  wording_support: z.enum(["section", "achievement", "none"]).optional(),
  determination_id: z.string(), provenance: z.record(z.string(), z.unknown()), ...freshness,
}).passthrough();
const coverageSchema = z.object({ relation_id: z.string(), requirement_id: z.string(),
  requirement_revision: z.union([z.number(), z.string()]), assessment_id: z.string(), achievement_id: z.string(),
  variant_id: z.string(), variant_revision: z.union([z.number(), z.string()]), approval_id: z.string(),
  covered: z.boolean(), status: z.string(), rationale: z.string(), source_refs: z.array(evidenceSchema),
  determination_id: z.string(), provenance: z.record(z.string(), z.unknown()), ...freshness,
}).passthrough();
const currentWordingSchema = z.object({ assignment_id: z.string(), revision: z.number().int().positive(), profile_id: z.string(),
  achievement_id: z.string(), requirement_id: z.string(), requirement_revision: z.number().int().positive(),
  variant_id: z.string(), variant_revision: z.number().int().positive(), approval_id: z.string(), relation_id: z.string(),
  state: z.enum(["active", "removed"]), profile_revision: z.number().int().positive(), fact_semantics_version: z.number().int().positive(),
  achievement_source_refs: z.array(sourceSchema), selection_provenance: z.record(z.string(), z.unknown()),
  created_at: z.string(), updated_at: z.string(), ...freshness,
}).passthrough();
const entrySchema = z.object({ requirement_id: z.string(), revision: z.number().int().positive(), definition: z.string(),
  contract_version: z.literal("requirements-v2"), category: z.enum(["skill", "professional_experience"]), name: z.string(),
  assessment: assessmentSchema.nullable(), coverage: z.array(coverageSchema), associations: z.array(associationSchema),
  current_wordings: z.array(currentWordingSchema), wording_assignments: z.array(currentWordingSchema),
}).passthrough();
const librarySchema = z.object({ profile_id: z.string(), readiness: z.enum(["ready", "profile_required"]),
  contract_version: z.string().optional(), synthetic: z.boolean().optional(),
  profile_revision: z.number().int().positive().nullable(), fact_semantics_version: z.number().int().positive().nullable(),
  wording_revision: z.number().int().positive().nullable(), catalog_revision: z.number().int().nonnegative(), requirements: z.array(entrySchema),
});
const historySchema = z.object({ association_id: z.string(), profile_id: z.string(), current_revision: z.number().int().positive(),
  total: z.number().int().positive(), limit: z.number().int().positive(), offset: z.number().int().nonnegative(), rows: z.array(associationSchema) });
const currentWordingHistorySchema = z.object({ assignment_id: z.string(), profile_id: z.string(), current_revision: z.number().int().positive(),
  total: z.number().int().positive(), limit: z.number().int().positive(), offset: z.number().int().nonnegative(), rows: z.array(currentWordingSchema) });

export type RequirementLibrary = z.infer<typeof librarySchema>;
export type RequirementLibraryEntry = z.infer<typeof entrySchema>;
export type RequirementAssociation = z.infer<typeof associationSchema>;
export type RequirementCoverage = z.infer<typeof coverageSchema>;
export type RequirementAssessment = z.infer<typeof assessmentSchema>;
export type RequirementAssociationHistory = z.infer<typeof historySchema>;
export type CurrentWordingAssignment = z.infer<typeof currentWordingSchema>;
export type CurrentWordingHistory = z.infer<typeof currentWordingHistorySchema>;
export type CreateRequirementAssociation = {
  association_id: string; profile_id: string; expected_profile_revision: number; requirement_id: string;
  requirement_revision: number; achievement_id: string;
  achievement_source_refs: Array<{ source_id: string; revision: number }>;
  wording: z.infer<typeof wordingBindingSchema> | null;
};
export type ReviseRequirementAssociation = CreateRequirementAssociation & { expected_revision: number };
export type SetCurrentWording = {
  profile_id: string; expected_profile_revision: number; expected_revision: number;
  achievement_id: string; requirement_id: string; requirement_revision: number;
  variant_id: string; variant_revision: number; approval_id: string; relation_id: string;
};

export const requirementRelationshipKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "fit"] as const,
  library: (tenantId: string, profileId: string) => [...requirementRelationshipKeys.all(tenantId), "requirement-library", profileId] as const,
};

export function useRequirementLibrary(profileId = "default") {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: requirementRelationshipKeys.library(tenantId, profileId), queryFn: async () => {
    const result = librarySchema.safeParse(await http.json<unknown>("GET", "/v1/fit/requirement-library", { query: { profile_id: profileId } }));
    if (!result.success) throw new Error("The saved requirement relationships could not be verified.");
    return result.data;
  }, meta: { suppressGlobalErrorToast: true } });
}

export function useRequirementAssociationHistory(associationId: string, { profileId = "default", limit = 50, offset = 0 }: {
  profileId?: string; limit?: number; offset?: number;
} = {}) {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: [...requirementRelationshipKeys.all(tenantId), "association-history", profileId, associationId, limit, offset],
    enabled: Boolean(associationId), queryFn: async () => {
      const result = historySchema.safeParse(await http.json<unknown>("GET", `/v1/fit/associations/${encodeURIComponent(associationId)}/history`,
        { query: { profile_id: profileId, limit, offset } }));
      if (!result.success) throw new Error("The saved association history could not be verified.");
      return result.data;
    }, meta: { suppressGlobalErrorToast: true },
  });
}

export function useRequirementAssociationActions() {
  const tenantId = useTenantId(); const { http, requestIdentity } = usePorts(); const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: requirementRelationshipKeys.all(tenantId) });
  const write = async (path: string, body: unknown) => {
    const value = await http.json<unknown>("POST", path, { body });
    const result = associationSchema.safeParse(value);
    if (!result.success) throw createUnconfirmedWriteError("POST", path, new Error("The saved association could not be verified. Reload before retrying."));
    return result.data;
  };
  const create = useMutation({ mutationFn: (body: CreateRequirementAssociation) => write("/v1/fit/associations", body), onSuccess: refresh });
  const revise = useMutation({ mutationFn: (body: ReviseRequirementAssociation) =>
    write(`/v1/fit/associations/${encodeURIComponent(body.association_id)}/revisions`, body), onSuccess: refresh });
  const state = (next: "active" | "removed", { associationId, expectedRevision, profileId = "default" }: {
    associationId: string; expectedRevision: number; profileId?: string;
  }) => write(`/v1/fit/associations/${encodeURIComponent(associationId)}/state`, { profile_id: profileId, expected_revision: expectedRevision, state: next });
  const remove = useMutation({ mutationFn: (body: { associationId: string; expectedRevision: number; profileId?: string }) => state("removed", body), onSuccess: refresh });
  const restore = useMutation({ mutationFn: (body: { associationId: string; expectedRevision: number; profileId?: string }) => state("active", body), onSuccess: refresh });
  return { create, revise, remove, restore, newAssociationId: () => requestIdentity.create() };
}

export function useCurrentWordingHistory(assignmentId: string, { profileId = "default", limit = 50, offset = 0 }: {
  profileId?: string; limit?: number; offset?: number;
} = {}) {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: [...requirementRelationshipKeys.all(tenantId), "current-wording-history", profileId, assignmentId, limit, offset],
    enabled: Boolean(assignmentId), queryFn: async () => {
      const result = currentWordingHistorySchema.safeParse(await http.json<unknown>("GET", `/v1/fit/current-wordings/${encodeURIComponent(assignmentId)}/history`,
        { query: { profile_id: profileId, limit, offset } }));
      if (!result.success) throw new Error("The maintained wording history could not be verified.");
      return result.data;
    }, meta: { suppressGlobalErrorToast: true },
  });
}

/** Selection consumes recorded exact positive coverage; this action never assesses wording. */
export function useCurrentWordingActions() {
  const tenantId = useTenantId(); const { http } = usePorts(); const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: requirementRelationshipKeys.all(tenantId) });
  const write = async (path: string, body: unknown) => {
    const value = await http.json<unknown>("POST", path, { body });
    const result = currentWordingSchema.safeParse(value);
    if (!result.success) throw createUnconfirmedWriteError("POST", path, new Error("The maintained wording could not be verified. Reload before retrying."));
    return result.data;
  };
  const set = useMutation({ mutationFn: (body: SetCurrentWording) => write("/v1/fit/current-wordings", body), onSuccess: refresh });
  const state = (next: "active" | "removed", { assignmentId, expectedRevision, profileId = "default" }: {
    assignmentId: string; expectedRevision: number; profileId?: string;
  }) => write(`/v1/fit/current-wordings/${encodeURIComponent(assignmentId)}/state`, { profile_id: profileId, expected_revision: expectedRevision, state: next });
  const remove = useMutation({ mutationFn: (body: { assignmentId: string; expectedRevision: number; profileId?: string }) => state("removed", body), onSuccess: refresh });
  const restore = useMutation({ mutationFn: (body: { assignmentId: string; expectedRevision: number; profileId?: string }) => state("active", body), onSuccess: refresh });
  return { set, remove, restore };
}
