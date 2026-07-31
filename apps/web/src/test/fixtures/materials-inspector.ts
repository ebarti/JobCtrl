import type {
  BulletProvenanceEntry,
  EmployerAnalysis,
  ArtifactTailoringExplanation,
  RequirementFitReport,
} from "@jobctrl/contracts";

/**
 * Shared fixtures for the Phase 5 inspector surfaces (EmployerAnalysisPanel,
 * BulletProvenanceList, TailoringExplanationSection). Reused by colocated tests,
 * a11y tests, and Storybook stories so the populated / degraded / missing states
 * stay consistent.
 */

export const populatedEmployerAnalysis: EmployerAnalysis = {
  generation: 3,
  snapshot_hash: "snap-abc123",
  prompt_version: "analysis-v2",
  sdk_set_version: "ensemble-2sdk",
  cache_key: "cache-abc",
  created_at: "2026-06-08T12:00:00Z",
  ensemble_completeness: "complete",
  legs_attempted: 2,
  legs_succeeded: 2,
  is_degraded: false,
  agreement: {
    score: 0.82,
    flagged_requirements: [],
    flagged_keywords: [],
  },
  role_framing: "Senior platform engineering leader owning developer experience.",
  inferred_seniority: "director",
  ideal_candidate_narrative:
    "Drives platform reliability and developer productivity across multiple teams.",
  requirements: [
    {
      id: "req-1",
      text: "Lead platform reliability programs across multiple teams",
      tier: "must_have",
      weight: 0.9,
      evidence_span: "Lead our platform reliability initiatives across the engineering org",
    },
    {
      id: "req-2",
      text: "Experience with Kubernetes-based developer platforms",
      tier: "nice_to_have",
      weight: 0.55,
      evidence_span: "Familiarity with Kubernetes and internal developer platforms is a plus",
    },
  ],
  keywords: [
    {
      keyword: "platform reliability",
      evidence_span: "platform reliability initiatives",
      requirement_ref: "req-1",
      rationale: "Central responsibility named twice in the responsibilities section.",
      is_orphan: false,
    },
    {
      keyword: "Kubernetes",
      evidence_span: "Familiarity with Kubernetes",
      requirement_ref: null,
      rationale: "Named technology with no dedicated requirement.",
      is_orphan: true,
    },
  ],
  sub_analyses: [
    {
      model_id: "claude",
      role_framing: "Platform leader",
      inferred_seniority: "director",
      ideal_candidate_narrative: "Leads platform org.",
      requirements: [],
      keywords: [],
    },
    {
      model_id: "codex",
      role_framing: "DevEx leader",
      inferred_seniority: "director",
      ideal_candidate_narrative: "Owns developer experience.",
      requirements: [],
      keywords: [],
    },
  ],
  failures: [],
};

export const degradedEmployerAnalysis: EmployerAnalysis = {
  ...populatedEmployerAnalysis,
  ensemble_completeness: "degraded",
  legs_attempted: 2,
  legs_succeeded: 1,
  is_degraded: true,
  agreement: { score: 0, flagged_requirements: ["req-1"], flagged_keywords: [] },
  sub_analyses: [populatedEmployerAnalysis.sub_analyses[0]!],
  failures: [
    {
      model_id: "codex",
      error: "timeout after 60s",
      raw_output: null,
    },
  ],
};

export const emptyEmployerAnalysis: EmployerAnalysis = {
  ...populatedEmployerAnalysis,
  role_framing: "",
  ideal_candidate_narrative: "",
  requirements: [],
  keywords: [],
  sub_analyses: [],
};

export const populatedRequirementFitReport: RequirementFitReport = {
  jobId: "job-1",
  scoreVersion: 4,
  employerAnalysisGeneration: populatedEmployerAnalysis.generation,
  profileSnapshotVersion: 7,
  scoringPolicyVersion: 3,
  formulaVersion: "requirement-fit-v1",
  resolvedFitScore: 8,
  fitBand: "strong",
  confidence: "high",
  summary: {
    weightedFit: 0.78,
    mustHaveCoverage: 1,
    blockerCount: 0,
    missingHighWeightCount: 0,
  },
  assessments: [
    {
      requirementId: "req-1",
      requirementText: "Lead platform reliability programs across multiple teams",
      tier: "must_have",
      weight: 0.9,
      jobEvidenceSpan: "Lead our platform reliability initiatives across the engineering org",
      fit: {
        kind: "matched",
        evidenceIds: ["ev-platform", "ev-reliability"],
        strength: "direct",
      },
      contribution: {
        maxPoints: 1.125,
        awardedPoints: 1.125,
        weightedImpact: 1.125,
        rationale: "Direct platform leadership evidence covers req-1.",
      },
      tailoring: {
        action: "double_down",
        priority: 0.9,
        allowedEvidenceIds: ["ev-platform", "ev-reliability"],
        targetKeywords: ["platform reliability"],
        prohibitedClaims: [],
        instruction: "Keep platform reliability leadership prominent.",
      },
      artifactCoverage: {
        state: "covered",
        source: "tailored_resume_bullet_provenance",
        bulletCount: 1,
        examples: ["Led platform reliability programs across 4 engineering teams."],
      },
    },
    {
      requirementId: "req-2",
      requirementText: "Experience with Kubernetes-based developer platforms",
      tier: "nice_to_have",
      weight: 0.55,
      jobEvidenceSpan: "Familiarity with Kubernetes and internal developer platforms is a plus",
      fit: {
        kind: "transferable",
        evidenceIds: ["ev-k8s"],
        gap: "No direct ownership of Kubernetes developer platforms is recorded.",
        bridge: "Kubernetes operations evidence can support adjacent platform experience.",
      },
      contribution: {
        maxPoints: 0.55,
        awardedPoints: 0.33,
        weightedImpact: 0.33,
        rationale: "Transferable Kubernetes operations evidence partially covers req-2.",
      },
      tailoring: {
        action: "bridge_gap",
        priority: 0.55,
        allowedEvidenceIds: ["ev-k8s"],
        targetKeywords: ["Kubernetes", "developer platforms"],
        prohibitedClaims: ["owned Kubernetes developer platforms end to end"],
        instruction: "Bridge from Kubernetes operations without claiming direct platform ownership.",
      },
      artifactCoverage: {
        state: "not_recorded",
        source: "tailored_resume_bullet_provenance",
        bulletCount: 0,
        examples: [],
      },
    },
  ],
};

export const provenanceEntries: BulletProvenanceEntry[] = [
  {
    bulletId: "exp-1-0",
    section: "experience",
    sourceId: "exp-1",
    evidenceIds: ["ev-platform", "ev-reliability"],
    sourceText: ["Responsible for keeping the platform up and running."],
    requirementIds: ["req-1"],
    matchedKeywords: ["platform reliability"],
    transformType: "rephrased",
    control: "rephrase_allowed",
    rationale: "Reworded the source bullet to foreground reliability ownership.",
    generatedText: "Led platform reliability programs across 4 engineering teams.",
  },
  {
    bulletId: "exp-2-0",
    section: "experience",
    sourceId: "exp-2",
    evidenceIds: ["ev-k8s"],
    sourceText: ["Managed Kubernetes clusters for internal developer tooling."],
    requirementIds: [],
    matchedKeywords: [],
    transformType: "drafted_adjacent",
    control: "adjacent_draft_allowed",
    rationale: "Drafted from closely-related Kubernetes evidence; no single source bullet.",
    generatedText: "Operated Kubernetes-based developer platforms for internal teams.",
  },
];

/** annotatedChanges carrying the original-profile-bullet source for the diff. */
export const annotatedChanges: ArtifactTailoringExplanation["annotatedChanges"] = [
  {
    section: "experience",
    label: "Platform role",
    changeType: "rephrase",
    sourceId: "exp-1",
    sourceText: ["Responsible for keeping the platform up and running."],
    tailoredText: ["Led platform reliability programs across 4 engineering teams."],
    rationale: "Foreground reliability ownership.",
    jobSignals: ["platform reliability"],
    controls: ["rephrase_allowed"],
    evidenceIds: ["ev-platform"],
    evidenceNotes: [],
  },
];
