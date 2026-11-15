import type { APIRequestContext } from "@playwright/test";
import { expect, json, modelCall, type ApplicationStack, type ExternalCall } from "../harness/fixtures.js";
import { catalogNormalization, catalogMemberMeaning, legacyCatalogMatching, typedExtraction,
  type CapabilityChoice, type CatalogChoice, type CatalogContext, type CorrectionWitness, type ReusableDemand } from "./requirements-data.js";
import type { CapturedPosting, RequirementSnapshot } from "./reuse-data.js";

export const CONSOLIDATION_PREDECESSOR = "5b9db7ddfa20fa2d618687da1b311e2287286679";
export const NORMALIZATION_VERSION = "requirements-capability-demand-v2";

export type Meaning = { requirement_id: string; revision: number; category: "skill" | "professional_experience"; name: string; definition: string };
export type Catalog = { catalog_revision: number; total: number; requirements: Meaning[];
  aliases: Record<string, string>; normalization: { ready: boolean; normalization_version: string; reconciliation_id: string | null } };
type SourceSnapshot = Omit<RequirementSnapshot, "requirements"> & {
  requirements: (RequirementSnapshot["requirements"][number] & Pick<Meaning, "category" | "name" | "definition">)[];
};
export type NormalizedSnapshot = Omit<SourceSnapshot, "requirements"> & {
  normalization_version: string;
  requirements: (SourceSnapshot["requirements"][number] & {
    previous_occurrence_id: string;
    name: string; definition: string;
    canonical: { category: string; name: string; definition: string };
    normalized_demand: { definition: string; demand_fingerprint: string; normalization_version: string;
      provenance: { citations: { source_id: string; quote: string }[] } };
  })[];
};
export type ReconciliationReport = { input_member_count: number; root_count: number; catalog_revision: number;
  mapping: Record<string, string>; roots: Meaning[]; corrections: CorrectionWitness[];
  receipt: { receipt_id: string; prompt_version: string; lane: string } };

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
  const member = (call.body["context"] as CatalogContext).members.find((row) => row.member_id === id);
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
  const context = call.body["context"] as CatalogContext;
  return catalogNormalization(call, groups, demands.map((demand) => {
    const group = groups.find((row) => row.groupId === demand.groupId)!;
    expect(group).toBeTruthy();
    return { groupId: demand.groupId, definition: demand.definition,
      reuseDemandFingerprint: demand.reuseDemandFingerprint ?? null,
      bindings: demand.jobIds.map((jobId) => ({ jobId, occurrenceIds: context.occurrences.filter((row) =>
        row.job_id === jobId && group.memberIds.includes(row.member_id)).map((row) => row.occurrence_id) })) };
  }));
}

export async function acceptedPdf(api: APIRequestContext, resumeId: string) {
  const response = await api.get(`/v1/resumes/${resumeId}/export?format=pdf&accepted=true`);
  expect(response.status(), await response.text()).toBe(200);
  return response.body();
}

export const readCatalog = (api: APIRequestContext) => json<Catalog>(api, "get", "/v1/requirements?limit=200");
export const requirementsPath = (jobId: string) => `/v1/jobs/${jobId}/requirements`;
export const fitPath = (jobId: string) => `/v1/jobs/${jobId}/fit`;
