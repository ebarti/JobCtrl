/** Structural UI state; explicit synthetic decisions, not semantic evaluation data. */
import type { CareerLearningResponse } from "@jobctrl/contracts";

export const careerJobId = "90000000-0000-4000-8000-000000000038";
export function careerLearningFixture(): CareerLearningResponse {
  const timestamp = "2026-10-18T10:00:00Z";
  const comparison = {
    demands: [
      {
        demand_id: "operations",
        skill: "Service operations",
        capability: "partial" as const,
        mentions: [
          {
            source_id: `posting:${careerJobId}`,
            quote: "Saved posting requirement.",
            exact_values: [],
          },
        ],
        evidence: [
          {
            source_id: "confirmed-incident",
            quote: "Saved confirmed exercise.",
            exact_values: [],
          },
        ],
        rationale: "Explicit synthetic model comparison.",
        uncertainty: "One selected posting.",
      },
    ],
    proposals: [
      {
        proposal_id: "practice",
        demand_id: "operations",
        kind: "evidence_building" as const,
        title: "Document an incident exercise",
        action: "Retain a reviewed exercise report.",
        completion_criterion: "Report contains observed outcomes.",
        rationale: "Inspectable experience.",
      },
    ],
    uncertainty: "Synthetic selected cohort; no market-wide inference.",
  };
  const origin = {
    cohortId: "80000000-0000-4000-8000-000000000038",
    revision: 1,
    title: "Owned cohort",
    asOf: "2026-10-18",
    aspirations: "Explore a future role",
    comparedAt: timestamp,
    jobIds: [careerJobId],
    snapshotFingerprint: "b".repeat(64),
    determinationId: "a".repeat(64),
    snapshot: {
      profileVersion: 1,
      selectedCount: 1,
      cohortSize: 1,
      analyzedCount: 1,
      confirmedEvidenceCount: 1,
      excludedEvidenceCount: 1,
      missingDescriptions: [],
      duplicateSelections: [],
      duplicateIdentities: [],
      jobs: [
        {
          jobId: careerJobId,
          title: "Owned job",
          company: "Synthetic employer",
          sourceId: `posting:${careerJobId}`,
          text: "Saved posting requirement.",
          applicationUrls: [],
        },
      ],
      sources: [
        {
          source_id: `posting:${careerJobId}`,
          text: "Saved posting requirement.",
        },
        { source_id: "confirmed-incident", text: "Saved confirmed exercise." },
      ],
    },
    comparison,
    determination: {
      determination_id: "a".repeat(64),
      tenant_id: "local",
      entity_id: "80000000-0000-4000-8000-000000000038",
      input_fingerprint: "a".repeat(64),
      kind: "career_demand_comparison",
      schema_version: "1",
      prompt_version: "career-demand-v1",
      provider: "synthetic",
      model: "synthetic",
      lane: "profile" as const,
      created_at: timestamp,
      result: comparison,
    },
  };
  return {
    ok: true,
    preview: null,
    truncated: false,
    cohorts: [{ ...origin, staleReasons: [], lastAttempt: null }],
    milestones: [
      {
        milestoneId: "c".repeat(64),
        revision: 1,
        cohortId: origin.cohortId,
        cohortRevision: 1,
        determinationId: origin.determinationId,
        proposal: comparison.proposals[0]!,
        origin,
        status: "planned",
        completionEvidence: "",
        selectedAt: timestamp,
        updatedAt: timestamp,
        staleReasons: [],
        history: [
          {
            revision: 1,
            status: "planned",
            completionEvidence: "",
            updatedAt: timestamp,
          },
        ],
      },
    ],
  };
}
