import { expect, type ExternalCall } from "../harness/fixtures.js";
import { createHash } from "node:crypto";
import { citeSources, modelSources } from "./requirements-data.js";

export type QualificationBinding = {
  requirement_id: string;
  requirement_revision: string;
  demand_fingerprint: string | null;
  source_id: string;
  category: "skill" | "professional_experience" | "education" | "language";
  permitted_evidence_ids: string[];
};
export type QualificationChoice = {
  kind?: "matched" | "missing" | "transferable" | "blocked" | "not_assessed";
  strength?: "direct" | "strong";
  achievementIds?: string[];
  evidenceSourceIds?: string[];
  keywords?: string[];
  evidenceRoute?: "education" | "equivalent_experience" | null;
  wordingSupport?: "section" | "achievement" | "none";
};

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => [key, canonical(entry)])) : value;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

/** Decode the actual wire; exact hashes prove mechanical scope expansion. */
export function qualificationBindings(call: ExternalCall): QualificationBinding[] {
  const context = structuredClone(call.body["context"]) as Record<string, unknown>;
  if (context["cohort_citation_version"] !== undefined) {
    expect(context["cohort_citation_version"]).toBe("fit-qualification-citation-refs-v1");
    const inventory = context["cohort_citation_sources"] as Record<string, string>;
    expect(inventory).toEqual(Object.fromEntries(modelSources(call).map((source, index) => [`s${index + 1}`, source.source_id])));
  }
  if (context["context_transport_version"] === undefined) return context["requirements"] as QualificationBinding[];
  expect(context["context_transport_version"]).toBe("fit-permission-scopes-v1");
  const binding = context["context_transport_binding"] as Record<string, unknown>;
  delete context["context_transport_binding"];
  expect(fingerprint(context)).toBe(binding["encoded_context_fingerprint"]);
  const scopes = context["permission_scopes"] as { scope_id: string; permitted_evidence_ids: string[] }[];
  expect(fingerprint(scopes)).toBe(binding["permission_scopes_fingerprint"]);
  expect(new Set(scopes.map((scope) => JSON.stringify(scope.permitted_evidence_ids))).size).toBe(scopes.length);
  const byId = new Map(scopes.map((scope) => [scope.scope_id, scope.permitted_evidence_ids]));
  const used = new Set<string>();
  const rows = context["requirements"] as (Omit<QualificationBinding, "permitted_evidence_ids"> & { permission_scope_id: string; permitted_evidence_ids?: never })[];
  context["requirements"] = rows.map((row) => {
    expect(row.permitted_evidence_ids).toBeUndefined();
    const { permission_scope_id, ...rest } = row;
    expect(byId.has(permission_scope_id)).toBe(true);
    used.add(permission_scope_id);
    return { ...rest, permitted_evidence_ids: byId.get(permission_scope_id)! };
  });
  expect(used.size).toBe(scopes.length);
  delete context["permission_scopes"];
  delete context["context_transport_version"];
  expect(fingerprint(context)).toBe(binding["expanded_context_fingerprint"]);
  return context["requirements"] as QualificationBinding[];
}

/** Select an exact supplied cohort source, without matching or rewriting it. */
export function cohortCitationSelection(call: ExternalCall, sourceId: string, line: number | null) {
  const context = call.body["context"] as { cohort_citation_version?: string; cohort_citation_sources?: Record<string, string> };
  expect(context.cohort_citation_version).toBe("fit-qualification-citation-refs-v1");
  const matches = Object.entries(context.cohort_citation_sources ?? {}).filter(([, id]) => id === sourceId);
  expect(matches).toHaveLength(1);
  const source = modelSources(call).find((row) => row.source_id === sourceId);
  expect(source).toBeTruthy();
  if (line !== null) expect(source!.text.split(/\r?\n/)[line - 1]).toBeTruthy();
  return { source_ref: matches[0]![0], line };
}

/** Current authored choices bind to the request's exact IDs and sources. */
export function qualificationBatchDecision(
  call: ExternalCall,
  choose: (binding: QualificationBinding, index: number) => QualificationChoice,
) {
  expect(call.body["operation"]).toBe("fit.qualification-batch");
  expect(call.body["prompt_version"]).toBe("fit-qualification-batch-v4-demand");
  return qualificationResponse(call, choose, true);
}

/** Only for a public predecessor running before capability/demand authority. */
export function legacyQualificationBatchDecision(
  call: ExternalCall,
  choose: (binding: Omit<QualificationBinding, "demand_fingerprint">, index: number) => QualificationChoice,
) {
  expect(call.body["operation"]).toBe("fit.qualification-batch");
  expect(call.body["prompt_version"]).toBe("fit-qualification-batch-v3");
  return qualificationResponse(call, choose, false);
}

export const qualificationKey = (binding: { requirement_id: string; requirement_revision: string | number; demand_fingerprint: string | null }) =>
  JSON.stringify([binding.requirement_id, String(binding.requirement_revision), binding.demand_fingerprint]);

function qualificationResponse(call: ExternalCall, choose: (binding: QualificationBinding, index: number) => QualificationChoice, withDemand: boolean) {
  expect(call.body["lane"]).toBe("scoring");
  const context = { requirements: qualificationBindings(call) };
  expect(context.requirements.length).toBeGreaterThan(0);
  expect(new Set(context.requirements.map((row) => withDemand ? qualificationKey(row) : row.requirement_id)).size).toBe(context.requirements.length);
  const sources = modelSources(call);
  expect(new Set(sources.map((row) => row.source_id)).size).toBe(sources.length);
  return { requirements: context.requirements.map((binding, index) => {
    expect(sources.some((row) => row.source_id === binding.source_id)).toBe(true);
    if (withDemand) {
      if (binding.category === "education" || binding.category === "language") expect(binding.demand_fingerprint).toBeNull();
      else expect(binding.demand_fingerprint).toEqual(expect.any(String));
    }
    const { kind = "matched", strength = "direct", achievementIds = [], evidenceSourceIds = [], keywords = [], evidenceRoute = null,
      wordingSupport = kind === "matched" || kind === "transferable" ? (binding.category === "education" || binding.category === "language" || !achievementIds.length ? "section" : "achievement") : "none" } = choose(binding, index);
    return {
      requirement_id: binding.requirement_id,
      requirement_revision: binding.requirement_revision,
      ...(withDemand ? { demand_fingerprint: binding.demand_fingerprint } : {}),
      kind,
      strength: kind === "matched" ? strength : null,
      confidence: "high",
      rationale: kind === "matched" || kind === "transferable"
        ? "The explicitly cited current authored facts support this qualification."
        : "The supplied current factual inventory does not establish this qualification.",
      evidence: citeSources(call, evidenceSourceIds),
      requirement_citations: citeSources(call, [binding.source_id]),
      achievement_ids: achievementIds,
      keywords,
      evidence_route: evidenceRoute,
      wording_support: wordingSupport,
      eligibility: "unknown",
      blocker_category: null,
      warning_category: null,
    };
  }) };
}
