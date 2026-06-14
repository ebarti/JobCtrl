import type {
  BulletProvenanceEntry,
  EmployerAnalysis,
  ArtifactTailoringExplanation,
} from "@jobhunter/contracts";

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
