import {
  TailoringPolicyRevisionListResponseSchema,
  type TailoringPolicyRevisionListQuery,
  type TailoringPolicyRevisionListResponse,
} from "./contracts.js";
import { allRows, getRow, type SqliteDatabase } from "./db.js";

const DEFAULT_TENANT = "local";

interface TailoringPolicyRevisionRow extends Record<string, unknown> {
  version: number;
  runtime_settings_json: string;
  rollback_of_version: number | null;
  rollback_reason: string;
  created_at: string;
  source_review_id: string | null;
  source_recommendation_id: string | null;
  current_version: number;
}

export function listTailoringPolicyRevisions(
  db: SqliteDatabase,
  query: TailoringPolicyRevisionListQuery,
): TailoringPolicyRevisionListResponse {
  return db.transaction(() => {
    const total = Number(
      getRow<{ count: number }>(
        db,
        `SELECT COUNT(*) AS count
           FROM tailoring_policies
          WHERE tenant_id = ?`,
        [DEFAULT_TENANT],
      )?.count ?? 0,
    );
    const offset = (query.page - 1) * query.pageSize;
    const rows = allRows<TailoringPolicyRevisionRow>(
      db,
      `SELECT policy.version,
              policy.runtime_settings_json,
              policy.rollback_of_version,
              policy.rollback_reason,
              policy.created_at,
              review.review_id AS source_review_id,
              review.recommendation_id AS source_recommendation_id,
              (
                SELECT MAX(current_policy.version)
                FROM tailoring_policies AS current_policy
                WHERE current_policy.tenant_id = policy.tenant_id
              ) AS current_version
         FROM tailoring_policies AS policy
         LEFT JOIN learning_recommendation_reviews AS review
           ON review.tenant_id = policy.tenant_id
          AND review.context = 'materials'
          AND review.policy_kind = 'tailoring_rule'
          AND review.policy_version = policy.version
          AND review.decision = 'accepted'
        WHERE policy.tenant_id = ?
        ORDER BY policy.version DESC
        LIMIT ? OFFSET ?`,
      [DEFAULT_TENANT, query.pageSize, offset],
    );

    return TailoringPolicyRevisionListResponseSchema.parse({
      ok: true,
      revisions: rows.map((row) => ({
        context: "materials",
        policyKind: "tailoring_rule",
        version: Number(row.version),
        status: Number(row.version) === Number(row.current_version) ? "current" : "superseded",
        learnedRules: learnedRules(row.runtime_settings_json),
        sourceReviewId: row.source_review_id,
        sourceRecommendationId: row.source_recommendation_id,
        rollbackOfVersion:
          row.rollback_of_version === null ? null : Number(row.rollback_of_version),
        rollbackReasonCode:
          row.rollback_of_version === null
            ? null
            : row.rollback_reason === "user_requested"
              ? "user_requested"
              : "historical_or_unspecified",
        createdAt: row.created_at,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
    });
  })();
}

function learnedRules(rawRuntimeSettings: string): Array<{
  ruleKey: string;
  ruleValue: unknown;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawRuntimeSettings || "{}");
  } catch {
    throw new Error("Tailoring policy runtime settings are not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("Tailoring policy runtime settings must be an object.");
  }
  const rawRules = parsed.learned_tailoring_rules ?? {};
  if (!isRecord(rawRules)) {
    throw new Error("Learned tailoring policy rules must be an object.");
  }
  return Object.entries(rawRules)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ruleKey, ruleValue]) => ({ ruleKey, ruleValue }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
