import {
  LearningRecommendationListResponseSchema,
  type LearningRecommendationListQuery,
  type LearningRecommendationListResponse,
} from "./contracts.js";
import { getRow, allRows, type SqliteDatabase } from "./db.js";

const DEFAULT_TENANT = "local";

interface RecommendationSummaryRow extends Record<string, unknown> {
  recommendation_id: string;
  derivation_version: number;
  evaluation_fixture_version: number;
  context: "materials";
  policy_kind: "tailoring_rule";
  signal_kind:
    | "style_preference"
    | "factual_correction"
    | "claim_policy_correction"
    | "keyword_strategy"
    | "provenance_dispute";
  rule_key: string;
  rule_value: string;
  allowlist_version: number;
  status: "pending";
  observed_signal_count: number;
  observed_job_count: number;
  minimum_signal_count: number;
  minimum_job_count: number;
  confidence_limit: "sample_gated_no_population_inference";
  derived_at: string;
  supporting_evidence_count: number;
  contradicting_evidence_count: number;
  tombstone_count: number;
}

export function listLearningRecommendations(
  db: SqliteDatabase,
  query: LearningRecommendationListQuery,
): LearningRecommendationListResponse {
  return db.transaction(() =>
    listLearningRecommendationsInSnapshot(db, query),
  )();
}

function listLearningRecommendationsInSnapshot(
  db: SqliteDatabase,
  query: LearningRecommendationListQuery,
): LearningRecommendationListResponse {
  const total = Number(
    getRow<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count
         FROM learning_recommendations
        WHERE tenant_id = ?`,
      [DEFAULT_TENANT],
    )?.count ?? 0,
  );
  const offset = (query.page - 1) * query.pageSize;
  const rows = allRows<RecommendationSummaryRow>(
    db,
    `SELECT recommendation.recommendation_id,
            recommendation.derivation_version,
            recommendation.evaluation_fixture_version,
            recommendation.context,
            recommendation.policy_kind,
            recommendation.signal_kind,
            recommendation.rule_key,
            recommendation.rule_value,
            recommendation.allowlist_version,
            recommendation.status,
            recommendation.observed_signal_count,
            recommendation.observed_job_count,
            recommendation.minimum_signal_count,
            recommendation.minimum_job_count,
            recommendation.confidence_limit,
            recommendation.derived_at,
            (
              SELECT COUNT(*)
              FROM learning_recommendation_evidence AS evidence
              WHERE evidence.tenant_id = recommendation.tenant_id
                AND evidence.recommendation_id = recommendation.recommendation_id
                AND evidence.evidence_role = 'supporting'
            ) AS supporting_evidence_count,
            (
              SELECT COUNT(*)
              FROM learning_recommendation_evidence AS evidence
              WHERE evidence.tenant_id = recommendation.tenant_id
                AND evidence.recommendation_id = recommendation.recommendation_id
                AND evidence.evidence_role = 'contradicting'
            ) AS contradicting_evidence_count,
            (
              SELECT COUNT(*)
              FROM learning_recommendation_tombstones AS tombstone
              WHERE tombstone.tenant_id = recommendation.tenant_id
                AND tombstone.recommendation_id = recommendation.recommendation_id
            ) AS tombstone_count
       FROM learning_recommendations AS recommendation
      WHERE recommendation.tenant_id = ?
      ORDER BY recommendation.derived_at DESC,
               recommendation.recommendation_id ASC
      LIMIT ? OFFSET ?`,
    [DEFAULT_TENANT, query.pageSize, offset],
  );
  return LearningRecommendationListResponseSchema.parse({
    ok: true,
    recommendations: rows.map((row) => ({
      recommendationId: row.recommendation_id,
      derivationVersion: Number(row.derivation_version),
      evaluationFixtureVersion: Number(row.evaluation_fixture_version),
      context: row.context,
      policyKind: row.policy_kind,
      signalKind: row.signal_kind,
      ruleKey: row.rule_key,
      ruleValue: row.rule_value,
      allowlistVersion: Number(row.allowlist_version),
      status: row.status,
      active: Number(row.tombstone_count) === 0,
      observedSignalCount: Number(row.observed_signal_count),
      observedJobCount: Number(row.observed_job_count),
      minimumSignalCount: Number(row.minimum_signal_count),
      minimumJobCount: Number(row.minimum_job_count),
      confidenceLimit: row.confidence_limit,
      supportingEvidenceCount: Number(row.supporting_evidence_count),
      contradictingEvidenceCount: Number(row.contradicting_evidence_count),
      tombstoneCount: Number(row.tombstone_count),
      derivedAt: row.derived_at,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
  });
}
