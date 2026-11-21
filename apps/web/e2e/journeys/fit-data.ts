import type { APIRequestContext } from "@playwright/test";
import {
  expect,
  json,
  modelCall,
  type ApplicationStack,
  type ExternalCall,
} from "../harness/fixtures.js";
import {
  baseline,
  createBaseline,
  type Library,
} from "./core-data.js";
import type { CapturedPosting } from "./reuse-data.js";
import {
  catalogMatching,
  legacyCatalogMatchingV5,
  citeSources,
  modelSources,
  typedExtraction,
} from "./requirements-data.js";
import { qualificationBatchDecision, qualificationKey } from "./qualification-data.js";
export { qualificationBatchDecision } from "./qualification-data.js";

export type FitAssessment = {
  assessment_id: string;
  requirement_id: string;
  demand_fingerprint: string | null;
  capability_definition: string;
  normalization_version: string | null;
  qualification_semantics_version: string;
  kind: string;
  determination_id: string;
  provenance: {
    receipt_id: string;
    provider: string;
    model: string;
    lane: string;
  };
  revalidated_from?: string;
};
export type FitState = {
  current: boolean;
  requirements_current: boolean;
  stale_reasons: string[];
  score: { revision: number; score: number; assessments: FitAssessment[] };
  coverage: { wording_gaps: unknown[] };
};
export type RefreshOperation = {
  operation_id: string;
  status: string;
  phase: string;
  prepare_coverage: boolean;
  prepare_wording: boolean;
  job_ids: string[];
  selected_requirement_ids: string[] | null;
  counters: {
    model_calls: number;
    requirements_assessed: number;
    qualifications_reused: number;
    wording_proposals: number;
  };
  failure_code: string | null;
  factual_published: boolean;
  partial: boolean;
  wording_failures: WordingFailure[];
  retry_wording_proposal_ids: string[];
};
export type WordingFailure = {
  proposal_id: string;
  achievement_id: string;
  status: string;
  failure_code: string | null;
  requirement_ids?: string[];
};
export type PendingRefresh = {
  pending: boolean;
  expected_input_fingerprint: string;
  requirement_count: number;
  available_job_ids: string[];
  stale_job_ids: string[];
  latest_operation: RefreshOperation | null;
  pending_wording_failures: WordingFailure[];
};
export type ImpactContext = {
  catalog_revision: number;
  requirements: {
    requirement_id: string;
    requirement_revision: string;
    demand_fingerprint: string | null;
    canonical_source_id: string;
    saved_assessment_source_id: string;
    prior_assessment_id: string | null;
    before_inventory_id: string;
    changed_source_ids: string[];
    mandatory_reassessment: boolean;
  }[];
};
type CoverageRelationBinding = {
  requirement_id: string;
  requirement_revision: string;
  demand_fingerprint: string;
  assessment_id: string;
  achievement_id: string;
  variant_id: string;
  variant_revision: string;
};
export type GroupedCoverageContext = {
  binding: {
    achievement_id: string;
    requirements: { requirement_id: string; requirement_revision: string | number; demand_fingerprint: string; assessment_id: string }[];
    approved_variants: { variant_id: string }[];
  };
  missing_relations: CoverageRelationBinding[];
};

type CoverageChoice = {
  evidenceSourceId: string;
  status: "covered" | "partial" | "not_covered";
  action: "reuse_approved" | "propose_wording" | "no_meaningful_gap";
  reusableVariantId?: string | null;
  gapRequirementIds?: string[];
  gapDemandBindings?: { requirement_id: string; requirement_revision: string; demand_fingerprint: string }[];
};

export function groupedCoverageDecision(call: ExternalCall, options: CoverageChoice) {
  expect(call.body["prompt_version"]).toBe("fit-wording-coverage-demand-v1");
  return coverageResponse(call, options, true);
}

/** Explicit pre-normalization predecessor response, never a current fallback. */
export function legacyGroupedCoverageDecision(call: ExternalCall, options: CoverageChoice) {
  return coverageResponse(call, options, false);
}

function coverageResponse(
  call: ExternalCall,
  {
    evidenceSourceId,
    status,
    action,
    reusableVariantId = null,
    gapRequirementIds = [],
    gapDemandBindings,
  }: CoverageChoice,
  withDemand: boolean,
) {
  const context = call.body["context"] as GroupedCoverageContext;
  const requirementSourceId = (binding: GroupedCoverageContext["binding"]["requirements"][number]) =>
    "requirement:" + (withDemand ? qualificationKey(binding) : binding.requirement_id);
  const gaps = withDemand ? gapDemandBindings ?? gapRequirementIds.map((id) => {
    const matches = context.binding.requirements.filter((row) => row.requirement_id === id);
    expect(matches, "Author exact gapDemandBindings when a capability has several source demands").toHaveLength(1);
    const { requirement_id, requirement_revision, demand_fingerprint } = matches[0]!;
    return { requirement_id, requirement_revision: String(requirement_revision), demand_fingerprint };
  }) : [];
  return {
    achievement_id: context.binding.achievement_id,
    relations: context.missing_relations.map((binding) => ({
      ...binding,
      status,
      rationale:
        "Explicit expression coverage against the complete grouped requirement set and exact approved wording.",
      citations: citeSources(call, [
        requirementSourceId(binding),
        `approved-variant:${binding.variant_id}`,
        evidenceSourceId,
      ]),
    })),
    action,
    reusable_variant_id: reusableVariantId,
    gap_requirement_ids: withDemand ? [...new Set(gaps.map((row) => row.requirement_id))] : gapRequirementIds,
    ...(withDemand ? { gap_demand_bindings: gaps } : {}),
    rationale:
      "One source-bound expression decision for the full achievement requirement set.",
    citations: citeSources(call, [
      ...context.binding.requirements.map(
        requirementSourceId,
      ),
      evidenceSourceId,
      ...(reusableVariantId ? [`approved-variant:${reusableVariantId}`] : []),
    ]),
  };
}

export function impactPartition(
  call: ExternalCall,
  choices: Record<string, "affected" | "unchanged">,
) {
  return impactResponse(call, choices, true);
}

/** Only for the fixed public predecessor's earlier impact wire contract. */
export function legacyImpactPartition(call: ExternalCall, choices: Record<string, "affected" | "unchanged">) {
  return impactResponse(call, choices, false);
}

function impactResponse(call: ExternalCall, choices: Record<string, "affected" | "unchanged">, withDemand: boolean) {
  const context = call.body["context"] as ImpactContext;
  if (withDemand) expect(context.requirements.every((row) => Object.hasOwn(row, "demand_fingerprint"))).toBe(true);
  const keyFor = (row: ImpactContext["requirements"][number]) => context.requirements.filter((other) => other.requirement_id === row.requirement_id).length > 1
    ? qualificationKey(row) : row.requirement_id;
  expect(Object.keys(choices).sort()).toEqual(
    context.requirements.map(keyFor).sort(),
  );
  return {
    requirements: context.requirements.map((requirement) => ({
      requirement_id: requirement.requirement_id,
      requirement_revision: requirement.requirement_revision,
      ...(withDemand ? { demand_fingerprint: requirement.demand_fingerprint } : {}),
      verdict: choices[keyFor(requirement)],
      rationale:
        "Explicit impact choice against this requirement's own frozen before/current source inventory.",
      citations: citeSources(call, [
        requirement.canonical_source_id,
        requirement.saved_assessment_source_id,
        ...requirement.changed_source_ids.slice(0, 1),
      ]),
    })),
  };
}

export function qualificationDecision(
  call: ExternalCall,
  {
    kind = "matched",
    achievementIds = [],
    evidenceSourceIds = [],
  }: {
    kind?: "matched" | "missing";
    achievementIds?: string[];
    evidenceSourceIds?: string[];
  },
) {
  return {
    ...(call.body["context"] as { binding: Record<string, string> }).binding,
    kind,
    strength: kind === "matched" ? "direct" : null,
    confidence: "high",
    rationale:
      kind === "matched"
        ? "The explicitly cited current authored facts support this qualification."
        : "The supplied current factual inventory does not establish this qualification.",
    evidence: citeSources(call, evidenceSourceIds),
    requirement_citations: citeSources(call, ["requirement"]),
    achievement_ids: achievementIds,
    keywords: [],
    eligibility: "unknown",
    blocker_category: null,
    warning_category: null,
  };
}

export const defaultRefreshLimits = {
  max_model_calls: 40,
  max_requirements: 100,
  max_wording_proposals: 20,
  max_duration_seconds: 600,
};

export function refreshPayload(
  pending: PendingRefresh,
  jobIds = pending.available_job_ids,
  limits: Partial<typeof defaultRefreshLimits> = {},
) {
  return {
    profile_id: "default",
    job_ids: jobIds,
    expected_input_fingerprint: pending.expected_input_fingerprint,
    prepare_wording: true,
    retry_wording_proposal_ids: [] as string[],
    limits: { ...defaultRefreshLimits, ...limits },
  };
}

export async function startRefresh(
  api: APIRequestContext,
  payload: ReturnType<typeof refreshPayload> & { prepare_coverage?: boolean },
  key: string,
) {
  const response = await api.post("/v1/actions/fit.refresh", {
    headers: { "idempotency-key": key },
    data: payload,
  });
  expect(response.status(), await response.text()).toBe(202);
  return response.json() as Promise<{ runId: string; status: string }>;
}

/** Submit authored sources and explicit determinations through the real public
 * application. These are current journey choices, never internal seeded rows. */
export async function createScoredFit(
  api: APIRequestContext,
  app: ApplicationStack,
  slug: string,
  {
    missingOwnership = false,
    twoRequirements = false,
    sameAchievement = false,
    legacyPartitionV5 = false,
    postingUrl = `https://example.com/jobs/${slug}`,
  } = {},
) {
  const authored = structuredClone(baseline);
  if (missingOwnership) {
    authored.resume.experience_entries[0]!.bullets[1] =
      "Tracked operational changes.";
  }
  if (sameAchievement) {
    authored.resume.experience_entries[0]!.bullets[0] =
      "Implemented durable workflow recovery and established explicit review ownership for operational changes.";
  }
  const { profile, library } = await createBaseline(api, authored);
  const clauses = [
    "Implement and maintain durable workflow recovery.",
    ...(twoRequirements
      ? ["Establish explicit review ownership for operational changes."]
      : []),
  ];
  const posting = await json<CapturedPosting & { title: string; company: string; url: string }>(api, "post", "/v1/jobs/capture", {
    url: postingUrl,
    title: "Synthetic Reliability Engineer",
    company: "Synthetic Refresh Company",
    description: clauses.join("\n"),
  });
  const extracting = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
    data: { expected_posting_revision: posting.revision, expected_revision: 0 },
  });
  const extraction = await modelCall(app, "requirements.extract");
  const localIds = ["recovery", "ownership"];
  extraction.reply(typedExtraction(extraction, { requirements: clauses.map((text, index) => ({
    localId: localIds[index]!, text,
  })) }));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(
    (legacyPartitionV5 ? legacyCatalogMatchingV5 : catalogMatching)(
      matching,
      Object.fromEntries(
        clauses.map((_, index) => [
          localIds[index]!,
          { verdict: "new" as const },
        ]),
      ),
    ),
  );
  const extracted = await extracting;
  expect(extracted.status(), await extracted.text()).toBe(200);
  const requirements = (await extracted.json()) as {
    revision: number;
    requirements: { requirement_id: string; requirement_revision: number }[];
  };
  const assessing = api.post(`/v1/jobs/${posting.job_id}/fit/assess`, {
    data: {
      expected_revision: 0,
      prepare_wording: false,
      prepare_coverage: false,
    },
  });
  const call = await modelCall(app, "fit.qualification-batch");
  call.reply(qualificationBatchDecision(call, (binding) => {
    const index = requirements.requirements.findIndex((row) => row.requirement_id === binding.requirement_id);
    expect(index).toBeGreaterThanOrEqual(0);
    const achievement =
      library.roles[0]!.achievements[sameAchievement ? 0 : index]!;
    return index === 1 && missingOwnership
          ? { kind: "missing" }
          : {
              achievementIds: [achievement.achievement_id],
              evidenceSourceIds: [
                `evidence:${achievement.source_refs[0]!.source_id}`,
              ],
            };
  }));
  const assessed = await assessing;
  expect(assessed.status(), await assessed.text()).toBe(200);
  return {
    posting,
    requirements,
    library: library as Library,
    profile,
    fit: (await assessed.json()) as FitState,
  };
}
