import type { APIRequestContext } from "@playwright/test";
import { expect, json, modelCall, type ApplicationStack, type ExternalCall } from "../harness/fixtures.js";
import { catalogContext, catalogNormalization, catalogMemberMeaning, legacyCatalogMatching, legacyCatalogNormalizationV2, legacyCatalogNormalizationV3, legacyCatalogNormalizationV4, legacyCatalogNormalizationV5, typedExtraction,
  type CapabilityChoice, type CatalogChoice, type CatalogContext, type BoundCorrectionWitness, type DemandChoice, type ReusableDemand } from "./requirements-data.js";
import type { CapturedPosting, RequirementSnapshot } from "./reuse-data.js";

export const CONSOLIDATION_PREDECESSOR = "5b9db7ddfa20fa2d618687da1b311e2287286679";
export const CITATION_V2_PREDECESSOR = "6e4131061fb41aab4743701084a7c74a19fa21f3";
export const CITATION_V3_PREDECESSOR = "943c8b4d0c6f4a15521e10c04a015de726bfcbb9";
export const PARTITION_V4_PREDECESSOR = "5d3fda5352fe4418332b989c05f710e0529f578c";
export const PARTITION_V5_PREDECESSOR = "df06b08ae201f7a73dc2c359944c06daf517c69e";
export const NORMALIZATION_VERSION = "requirements-capability-demand-v2";
export type CitationBindingSummary = { binder_version: string; selection_fingerprint: string; derived_fingerprint: string;
  segment_catalog_fingerprint: string; source_fingerprint: string; source_context_fingerprint: string };
export type CitationBindingReport = CitationBindingSummary & {
  segment_catalog: CatalogContext["citation_segments"]; source_fingerprints: Record<string, string>;
  source_context: { normalization_version: string; catalog_revision: number; inventory_source_id: string;
    snapshot_heads: CatalogContext["source_snapshot_heads"]; incoming: CatalogContext["incoming"];
    members: (CatalogContext["members"][number] & { retained_members?: { requirement_id: string; revision: number }[];
      posting?: { job_id: string; revision: number; source_id: string; source_revision: number; source_hash: string } | null })[];
    occurrences: (CatalogContext["occurrences"][number] & { source_identity: { source_id: string; source_revision: number;
      source_hash: string; evidence_refs: string[]; extraction_determination_id: string } })[];
    posting_sources: (CatalogContext["posting_sources"][number] & { posting_source_id: string; source_revision: number })[];
    accepted_demands: (CatalogContext["accepted_demands"][number] & { occurrence_ids: string[] })[];
  };
};

export type Meaning = { requirement_id: string; revision: number; category: "skill" | "professional_experience"; name: string; definition: string };
export type Catalog = { catalog_revision: number; total: number; requirements: Meaning[];
  aliases: Record<string, string>; normalization: { ready: boolean; normalization_version: string; reconciliation_id: string | null } };
type SourceSnapshot = Omit<RequirementSnapshot, "requirements"> & {
  requirements: (RequirementSnapshot["requirements"][number] & Pick<Meaning, "category" | "name" | "definition"> & { evidence_refs: string[] })[];
};
export type NormalizedSnapshot = Omit<SourceSnapshot, "requirements"> & {
  normalization_version: string;
  requirements: (SourceSnapshot["requirements"][number] & {
    previous_occurrence_id: string;
    name: string; definition: string;
    canonical: { category: string; name: string; definition: string };
    normalized_demand: { definition: string; demand_fingerprint: string; normalization_version: string;
      provenance: { citations: { source_id: string; quote: string }[]; reconciliation_id: string;
        citation_binding?: CitationBindingSummary } };
  })[];
};
export type ReconciliationReport = { input_member_count: number; root_count: number; catalog_revision: number;
  mapping: Record<string, string>; roots: Meaning[]; corrections: BoundCorrectionWitness[];
  partition_binding: { binder_version: string; raw_selection_fingerprint: string; intermediate_fingerprint: string;
    member_groups: Record<string, string>; occurrence_groups: Record<string, string>; demand_capabilities: Record<string, string> };
  reconciliation_id: string; input_fingerprint: string; citation_binding: CitationBindingReport;
  receipt: { receipt_id: string; prompt_version: string; lane: string; accepted_result_fingerprint: string } };

/** A real predecessor accepts these explicitly authored older identity choices.
 * No repository/database state or determination implementation is replaced. */
export async function acceptLegacyRequirements(api: APIRequestContext, app: ApplicationStack, posting: CapturedPosting,
  definitions: ReusableDemand[], choices: Record<string, CatalogChoice>, { expectedRevision = 0, force = false } = {}) {
  const pending = api.post(`/v1/jobs/${posting.job_id}/requirements`, { data: { expected_posting_revision: posting.revision, expected_revision: expectedRevision, force } });
  const extracting = await modelCall(app, "requirements.extract");
  extracting.reply(typedExtraction(extracting, { requirements: definitions }));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(legacyCatalogMatching(matching, choices));
  const response = await pending;
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<SourceSnapshot>;
}

export function retainedCapability(call: ExternalCall, id: string, groupId: string): CapabilityChoice {
  const member = catalogContext(call).members.find((row) => row.member_id === id);
  expect(member).toBeTruthy();
  const meaning = catalogMemberMeaning(call, id);
  return { groupId, memberIds: [id], category: meaning.category, name: meaning.name,
    definition: meaning.definition, reuseRequirementId: id };
}

/** Every supplied definition is authored by the journey. Only recorded ID joins
 * select the concrete occurrences and bind the complete live source inventory. */
export function authoredPartition(call: ExternalCall, groups: CapabilityChoice[], demands: {
  groupId: string; definition: string; jobIds: string[]; reuseDemandFingerprint?: string;
}[]) {
  return catalogNormalization(call, groups, authoredDemandBindings(call, groups, demands));
}

/** Explicit old-v2 transport used only while the real predecessor is running. */
export function legacyAuthoredPartitionV2(call: ExternalCall, groups: CapabilityChoice[], demands: {
  groupId: string; definition: string; jobIds: string[]; reuseDemandFingerprint?: string;
}[]) {
  return legacyCatalogNormalizationV2(call, groups, authoredDemandBindings(call, groups, demands));
}

/** Explicit old-v3 transport used only while its real predecessor is running. */
export function legacyAuthoredPartitionV3(call: ExternalCall, groups: CapabilityChoice[], demands: {
  groupId: string; definition: string; jobIds: string[]; reuseDemandFingerprint?: string;
}[]) {
  return legacyCatalogNormalizationV3(call, groups, authoredDemandBindings(call, groups, demands));
}

/** Explicit old-v4 transport used only while its real predecessor is running. */
export function legacyAuthoredPartitionV4(call: ExternalCall, groups: CapabilityChoice[], demands: {
  groupId: string; definition: string; jobIds: string[]; reuseDemandFingerprint?: string;
}[]) {
  return legacyCatalogNormalizationV4(call, groups, authoredDemandBindings(call, groups, demands));
}

/** Exact v5 transport before a real source upgrade. */
export function legacyAuthoredPartitionV5(call: ExternalCall, groups: CapabilityChoice[], demands: {
  groupId: string; definition: string; jobIds: string[]; reuseDemandFingerprint?: string;
}[]) {
  return legacyCatalogNormalizationV5(call, groups, authoredDemandBindings(call, groups, demands));
}

function authoredDemandBindings(call: ExternalCall, groups: CapabilityChoice[], demands: {
  groupId: string; definition: string; jobIds: string[]; reuseDemandFingerprint?: string;
}[]): DemandChoice[] {
  const context = catalogContext(call);
  return demands.map((demand) => {
    const group = groups.find((row) => row.groupId === demand.groupId)!;
    expect(group).toBeTruthy();
    return { groupId: demand.groupId, definition: demand.definition,
      reuseDemandFingerprint: demand.reuseDemandFingerprint ?? null,
      bindings: demand.jobIds.map((jobId) => ({ jobId, occurrenceIds: context.occurrences.filter((row) =>
        row.job_id === jobId && group.memberIds.includes(row.member_id)).map((row) => row.occurrence_id) })) };
  });
}

export async function acceptedPdf(api: APIRequestContext, resumeId: string) {
  const response = await api.get(`/v1/resumes/${resumeId}/export?format=pdf&accepted=true`);
  expect(response.status(), await response.text()).toBe(200);
  return response.body();
}

export const readCatalog = (api: APIRequestContext) => json<Catalog>(api, "get", "/v1/requirements?limit=200");
export const requirementsPath = (jobId: string) => `/v1/jobs/${jobId}/requirements`;
export const fitPath = (jobId: string) => `/v1/jobs/${jobId}/fit`;
