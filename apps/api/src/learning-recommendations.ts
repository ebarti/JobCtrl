import {
  LearningRecommendationEvidenceListResponseSchema,
  LearningRecommendationListResponseSchema,
  type LearningRecommendationEvidenceListQuery,
  type LearningRecommendationEvidenceListResponse,
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

interface RecommendationEvidenceLinkRow extends Record<string, unknown> {
  signal_id: string;
  evidence_role: "supporting" | "contradicting";
  source_kind: "tailoring_feedback_signal";
  source_revision: number;
  job_id: string;
  recorded_at: string;
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
        WHERE tenant_id = ?
          AND NOT EXISTS (
            SELECT 1
              FROM learning_recommendation_reviews AS review
             WHERE review.tenant_id = learning_recommendations.tenant_id
               AND review.recommendation_id = learning_recommendations.recommendation_id
               AND review.decision IN ('accepted', 'rejected')
          )`,
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
        AND NOT EXISTS (
          SELECT 1
            FROM learning_recommendation_reviews AS review
           WHERE review.tenant_id = recommendation.tenant_id
             AND review.recommendation_id = recommendation.recommendation_id
             AND review.decision IN ('accepted', 'rejected')
        )
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

export function listLearningRecommendationEvidence(
  db: SqliteDatabase,
  recommendationId: string,
  query: LearningRecommendationEvidenceListQuery,
): LearningRecommendationEvidenceListResponse | null {
  return db.transaction(() => {
    const recommendation = getRow<{ recommendation_id: string }>(
      db,
      `SELECT recommendation_id
         FROM learning_recommendations
        WHERE tenant_id = ?
          AND recommendation_id = ?`,
      [DEFAULT_TENANT, recommendationId],
    );
    if (!recommendation) {
      return null;
    }

    const total = Number(
      getRow<{ count: number }>(
        db,
        `SELECT COUNT(*) AS count
           FROM learning_recommendation_evidence AS evidence
           JOIN learning_recommendation_evidence_jobs AS evidence_job
             ON evidence_job.tenant_id = evidence.tenant_id
            AND evidence_job.recommendation_id = evidence.recommendation_id
            AND evidence_job.signal_id = evidence.signal_id
          WHERE evidence.tenant_id = ?
            AND evidence.recommendation_id = ?`,
        [DEFAULT_TENANT, recommendationId],
      )?.count ?? 0,
    );
    const offset = (query.page - 1) * query.pageSize;
    const rows = allRows<RecommendationEvidenceLinkRow>(
      db,
      `SELECT evidence.signal_id,
              evidence.evidence_role,
              evidence.source_kind,
              evidence.source_revision,
              evidence_job.job_id,
              evidence.recorded_at
         FROM learning_recommendation_evidence AS evidence
         JOIN learning_recommendation_evidence_jobs AS evidence_job
           ON evidence_job.tenant_id = evidence.tenant_id
          AND evidence_job.recommendation_id = evidence.recommendation_id
          AND evidence_job.signal_id = evidence.signal_id
        WHERE evidence.tenant_id = ?
          AND evidence.recommendation_id = ?
        ORDER BY CASE evidence.evidence_role
                   WHEN 'supporting' THEN 0
                   ELSE 1
                 END,
                 evidence.recorded_at ASC,
                 evidence.signal_id ASC,
                 evidence_job.job_id ASC
        LIMIT ? OFFSET ?`,
      [DEFAULT_TENANT, recommendationId, query.pageSize, offset],
    );
    return LearningRecommendationEvidenceListResponseSchema.parse({
      ok: true,
      recommendationId,
      evidence: rows.map((row) => ({
        signalId: row.signal_id,
        evidenceRole: row.evidence_role,
        sourceKind: row.source_kind,
        sourceRevision: Number(row.source_revision),
        jobId: row.job_id,
        recordedAt: row.recorded_at,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
    });
  })();
}
