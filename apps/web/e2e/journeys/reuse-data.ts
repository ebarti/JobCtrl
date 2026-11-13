import type { APIRequestContext } from "@playwright/test";
import { expect, json, modelCall, type ApplicationStack, type ExternalCall } from "../harness/fixtures.js";
import { catalogMatching, typedExtraction, type CatalogChoice } from "./requirements-data.js";

export type CapturedPosting = { job_id: string; revision: number; source_id: string; source_revision: number; source_hash: string; description: string };
export type RequirementDefinition = { localId: string; text: string; definition?: string };
export type RequirementSnapshot = {
  contract_version: "requirements-v2";
  job_id: string; revision: number; posting_revision: number; posting_hash: string; stale: boolean;
  requirements: {
    occurrence_id: string; requirement_id: string; requirement_revision: number; job_id: string;
    source_id: string; source_revision: number; source_hash: string; model_source_id: string;
    spans: { start: number; end: number; quote: string }[];
    extraction_determination_id: string; equivalence_determination_ids: string[];
    provenance: {
      extraction: Record<string, unknown> & { receipt_id: string; source_binding: Record<string, unknown> };
      resolution: (Record<string, unknown> & { receipt_id: string; source_binding: Record<string, unknown> })[];
    };
  }[];
};

export async function captureReusePosting(api: APIRequestContext, slug: string, description: string) {
  return json<CapturedPosting>(api, "post", "/v1/jobs/capture", {
    url: `https://example.com/jobs/${slug}`, title: `Synthetic ${slug} engineer`, company: `Synthetic ${slug} company`, description,
  });
}

export function reusableModelCatalog(app: ApplicationStack) {
  app.external.setCatalog({ providers: [
    { provider: "codex", configured: true, ready: true, models: ["gpt-6", "gpt-6.1"].map((id) => ({ id, displayName: id, capabilities: ["structured_json"], supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "low" }], defaultReasoningEffort: "high" })) },
    { provider: "claude", configured: true, ready: true, models: [{ id: "claude-opus-4-8", capabilities: ["structured_json"] }] },
    { provider: "google", configured: true, ready: true, models: [{ id: "gemini-3.1-pro-preview", capabilities: ["structured_json"] }] },
  ] });
}

export function extractionFor(call: ExternalCall, definitions: RequirementDefinition[]) {
  return typedExtraction(call, { requirements: definitions });
}

/** Real public refresh with explicitly expected external calls; no inference or response replay. */
export async function acceptReuseRequirements(api: APIRequestContext, app: ApplicationStack, posting: CapturedPosting,
  definitions: RequirementDefinition[], choices: Record<string, CatalogChoice>,
  { extract = true, match = true, expectedRevision = 0, force = false } = {}) {
  const pending = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
    data: { expected_posting_revision: posting.revision, expected_revision: expectedRevision, force },
  });
  let extraction: ExternalCall | undefined;
  let matching: ExternalCall | undefined;
  if (extract) {
    extraction = await modelCall(app, "requirements.extract");
    extraction.reply(extractionFor(extraction, definitions));
  }
  if (match) {
    matching = await modelCall(app, "requirements.match_catalog");
    matching.reply(catalogMatching(matching, choices));
  }
  const response = await pending;
  expect(response.status(), await response.text()).toBe(200);
  return { snapshot: await response.json() as RequirementSnapshot, extraction, matching };
}
