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
  type Posting,
} from "./core-data.js";
import {
  catalogMatching,
  citeSources,
  modelSources,
} from "./requirements-data.js";

export type FitAssessment = {
  assessment_id: string;
  requirement_id: string;
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
  score: { revision: number; score: number; assessments: FitAssessment[] };
  coverage: { wording_gaps: unknown[] };
};
export type RefreshOperation = {
  operation_id: string;
  status: string;
  phase: string;
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
  achievement_id: string;
  variant_id: string;
  variant_revision: string;
};
export type GroupedCoverageContext = {
  binding: {
    achievement_id: string;
    requirements: { requirement_id: string; requirement_revision: string }[];
    approved_variants: { variant_id: string }[];
  };
  missing_relations: CoverageRelationBinding[];
};

export function groupedCoverageDecision(
  call: ExternalCall,
  {
    evidenceSourceId,
    status,
    action,
    reusableVariantId = null,
    gapRequirementIds = [],
  }: {
    evidenceSourceId: string;
    status: "covered" | "partial" | "not_covered";
    action: "reuse_approved" | "propose_wording" | "no_meaningful_gap";
    reusableVariantId?: string | null;
    gapRequirementIds?: string[];
  },
) {
  const context = call.body["context"] as GroupedCoverageContext;
  return {
    achievement_id: context.binding.achievement_id,
    relations: context.missing_relations.map((binding) => ({
      ...binding,
      status,
      rationale:
        "Explicit expression coverage against the complete grouped requirement set and exact approved wording.",
      citations: citeSources(call, [
        `requirement:${binding.requirement_id}`,
        `approved-variant:${binding.variant_id}`,
        evidenceSourceId,
      ]),
    })),
    action,
    reusable_variant_id: reusableVariantId,
    gap_requirement_ids: gapRequirementIds,
    rationale:
      "One source-bound expression decision for the full achievement requirement set.",
    citations: citeSources(call, [
      ...context.binding.requirements.map(
        (row) => `requirement:${row.requirement_id}`,
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
  const context = call.body["context"] as ImpactContext;
  expect(Object.keys(choices).sort()).toEqual(
    context.requirements.map((row) => row.requirement_id).sort(),
  );
  return {
    requirements: context.requirements.map((requirement) => ({
      requirement_id: requirement.requirement_id,
      requirement_revision: requirement.requirement_revision,
      verdict: choices[requirement.requirement_id],
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
    eligibility: "eligible",
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
  payload: ReturnType<typeof refreshPayload>,
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
  const posting = await json<Posting>(api, "post", "/v1/jobs/capture", {
    url: `https://example.com/jobs/${slug}`,
    title: "Synthetic Reliability Engineer",
    company: "Synthetic Refresh Company",
    description: clauses.join("\n"),
  });
  const extracting = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
    data: { expected_posting_revision: posting.revision, expected_revision: 0 },
  });
  const extraction = await modelCall(app, "requirements.extract");
  const source = modelSources(extraction)[0]!;
  const localIds = ["recovery", "ownership"];
  extraction.reply({
    status: "complete",
    requirements: clauses.map((text, index) => ({
      local_id: localIds[index],
      text,
      definition: text,
      qualifiers: [],
      scope: "resume",
      tier: "must_have",
      weight: 1,
      support: "supported",
      spans: [
        {
          start: source.text.indexOf(text),
          end: source.text.indexOf(text) + text.length,
          quote: text,
        },
      ],
    })),
    reason: "Explicit complete inventory for this authored synthetic posting.",
    citations: citeSources(extraction, [source.source_id]),
  });
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(
    catalogMatching(
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
  for (let index = 0; index < clauses.length; index += 1) {
    const call = await modelCall(app, "fit.qualification");
    const achievement =
      library.roles[0]!.achievements[sameAchievement ? 0 : index]!;
    call.reply(
      qualificationDecision(
        call,
        index === 1 && missingOwnership
          ? { kind: "missing" }
          : {
              achievementIds: [achievement.achievement_id],
              evidenceSourceIds: [
                `evidence:${achievement.source_refs[0]!.source_id}`,
              ],
            },
      ),
    );
  }
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
