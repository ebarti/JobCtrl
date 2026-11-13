import { expect, type ExternalCall } from "../harness/fixtures.js";
import { citeSources, modelSources } from "./requirements-data.js";

export type QualificationBinding = {
  requirement_id: string;
  requirement_revision: string;
  source_id: string;
  category: "skill" | "professional_experience" | "education" | "language";
  permitted_evidence_ids: string[];
};
export type QualificationChoice = {
  kind?: "matched" | "missing" | "transferable";
  strength?: "direct" | "strong";
  achievementIds?: string[];
  evidenceSourceIds?: string[];
  keywords?: string[];
  evidenceRoute?: "education" | "equivalent_experience" | null;
  wordingSupport?: "section" | "achievement" | "none";
};

/** Current authored choices bind to the request's exact IDs and sources. */
export function qualificationBatchDecision(
  call: ExternalCall,
  choose: (binding: QualificationBinding, index: number) => QualificationChoice,
) {
  expect(call.body["operation"]).toBe("fit.qualification-batch");
  expect(call.body["prompt_version"]).toBe("fit-qualification-batch-v2");
  expect(call.body["lane"]).toBe("scoring");
  const context = call.body["context"] as { requirements: QualificationBinding[] };
  expect(context.requirements.length).toBeGreaterThan(0);
  expect(new Set(context.requirements.map((row) => row.requirement_id)).size).toBe(context.requirements.length);
  const sources = modelSources(call);
  expect(new Set(sources.map((row) => row.source_id)).size).toBe(sources.length);
  return { requirements: context.requirements.map((binding, index) => {
    expect(binding.source_id).toBe(`requirement:${binding.requirement_id}`);
    const { kind = "matched", strength = "direct", achievementIds = [], evidenceSourceIds = [], keywords = [], evidenceRoute = null,
      wordingSupport = kind === "matched" || kind === "transferable" ? (binding.category === "education" || binding.category === "language" || !achievementIds.length ? "section" : "achievement") : "none" } = choose(binding, index);
    return {
      requirement_id: binding.requirement_id,
      requirement_revision: binding.requirement_revision,
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
