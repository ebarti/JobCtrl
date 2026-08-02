import type {
  LearningRecommendationEvidenceListResponse,
  LearningRecommendationListResponse,
  LearningRecommendationSummary,
} from "@jobctrl/contracts";

export const sampleLearningRecommendation: LearningRecommendationSummary = {
  recommendationId: `learning-recommendation:${"a".repeat(64)}`,
  derivationVersion: 1,
  evaluationFixtureVersion: 1,
  context: "materials",
  policyKind: "tailoring_rule",
  signalKind: "style_preference",
  ruleKey: "style_guidance",
  ruleValue: "preserve_user_edit_pattern",
  allowlistVersion: 1,
  status: "pending",
  active: true,
  observedSignalCount: 3,
  observedJobCount: 2,
  minimumSignalCount: 3,
  minimumJobCount: 2,
  confidenceLimit: "sample_gated_no_population_inference",
  supportingEvidenceCount: 3,
  contradictingEvidenceCount: 1,
  tombstoneCount: 0,
  derivedAt: "2026-08-01T12:00:00.000Z",
};

export const sampleSecondLearningRecommendation: LearningRecommendationSummary = {
  ...sampleLearningRecommendation,
  recommendationId: `learning-recommendation:${"b".repeat(64)}`,
  signalKind: "factual_correction",
  ruleKey: "fact_handling",
  ruleValue: "require_source_match",
  contradictingEvidenceCount: 0,
  derivedAt: "2026-08-01T12:01:00.000Z",
};

export const sampleLearningRecommendationList: LearningRecommendationListResponse = {
  ok: true,
  recommendations: [sampleLearningRecommendation, sampleSecondLearningRecommendation],
  page: 1,
  pageSize: 50,
  total: 2,
  totalPages: 1,
};

export const sampleLearningRecommendationEvidence: LearningRecommendationEvidenceListResponse = {
  ok: true,
  recommendationId: sampleLearningRecommendation.recommendationId,
  evidence: [
    {
      signalId: "tailoring-signal-supporting-1",
      evidenceRole: "supporting",
      sourceKind: "tailoring_feedback_signal",
      sourceRevision: 2,
      jobId: "11111111-1111-4111-8111-111111111111",
      recordedAt: "2026-08-01T10:00:00.000Z",
    },
    {
      signalId: "tailoring-signal-contradicting-1",
      evidenceRole: "contradicting",
      sourceKind: "tailoring_feedback_signal",
      sourceRevision: 1,
      jobId: "22222222-2222-4222-8222-222222222222",
      recordedAt: "2026-08-01T10:05:00.000Z",
    },
  ],
  page: 1,
  pageSize: 100,
  total: 2,
  totalPages: 1,
};
