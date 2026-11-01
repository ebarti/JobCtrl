import {
  TailoringPolicyRevisionListResponseSchema,
  type TailoringPolicyRevisionListQuery,
  type TailoringPolicyRevisionListResponse,
} from "./contracts.js";
import { allRows, getRow, type SqliteDatabase } from "./db.js";

const DEFAULT_TENANT = "local";
const WORKER_UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/;

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
      revisions: rows.map((row) => {
        const receipt = restoreReceipt(row);
        return {
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
              : row.rollback_reason === "user_requested" || receipt !== null
                ? "user_requested"
                : "historical_or_unspecified",
          ...(receipt === null ? {} : {
            restoreCommandId: receipt.commandId,
            restoredFromCurrentVersion: receipt.expectedCurrentVersion,
          }),
          createdAt: canonicalizeWorkerUtcTimestamp(row.created_at),
        };
      }),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
    });
  })();
}

function restoreReceipt(row: TailoringPolicyRevisionRow): {
  commandId: string;
  expectedCurrentVersion: number;
} | null {
  const prefix = "jobctrl:policy-restore:v1:";
  if (!row.rollback_reason.startsWith(prefix)) return null;
  const raw = row.rollback_reason.slice(prefix.length);
  const separator = raw.indexOf(":");
  if (separator < 0) return null;
  const commandId = raw.slice(0, separator);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(commandId)) return null;
  try {
    const value: unknown = JSON.parse(raw.slice(separator + 1));
    if (!isRecord(value) || value.commandId !== commandId || value.reason !== "user_requested" ||
        value.targetVersion !== row.rollback_of_version ||
        typeof value.expectedCurrentVersion !== "number" ||
        !Number.isInteger(value.expectedCurrentVersion) || value.expectedCurrentVersion < 1 ||
        value.expectedCurrentVersion + 1 !== row.version) return null;
    return { commandId, expectedCurrentVersion: value.expectedCurrentVersion };
  } catch {
    return null;
  }
}

function canonicalizeWorkerUtcTimestamp(value: string): string {
  const candidate = value.trim();
  const match = WORKER_UTC_TIMESTAMP_PATTERN.exec(candidate);
  if (!match) {
    return candidate;
  }
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) {
    return candidate;
  }
  const milliseconds = (match[7] ?? "").padEnd(3, "0").slice(0, 3);
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds}Z`;
  const canonical = new Date(parsed).toISOString();
  return canonical === normalized ? canonical : candidate;
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
