import {
  MIN_TAILORING_FIT_SCORE,
  PIPELINE_ACTION_JOB_KEY,
  type ActionCommandPayload,
  type Stage,
} from "./contracts.js";
import { openReadOnlyDatabase } from "./db.js";

export const AUTHENTICATED_LINKEDIN_BROWSER_UNAVAILABLE =
  "authenticated_linkedin_browser_unavailable" as const;

export type ResolvedBlockCondition =
  typeof AUTHENTICATED_LINKEDIN_BROWSER_UNAVAILABLE;

interface BlockConditionRecoveryRule {
  stage: Stage;
  stages: Stage[];
  errorCode: string;
  matchesLegacyRow: (row: BlockedStageRow) => boolean;
}

interface BlockedStageRow {
  job_id: string;
  url: string;
  site: string | null;
  metadata_json: string | null;
}

const RECOVERY_RULES: Record<ResolvedBlockCondition, BlockConditionRecoveryRule> = {
  [AUTHENTICATED_LINKEDIN_BROWSER_UNAVAILABLE]: {
    stage: "enrich",
    stages: ["enrich", "score", "tailor", "cover"],
    errorCode: "ENRICH_ROBOTS_DISALLOWED",
    // Rows written before blockedConditions was introduced are recoverable
    // only when their canonical source identity proves they are LinkedIn jobs.
    matchesLegacyRow: (row) => isLinkedInJob(row.site, row.url),
  },
};

export function commandForResolvedBlockCondition(
  dbPath: string,
  condition: ResolvedBlockCondition,
): ActionCommandPayload | null {
  const rule = RECOVERY_RULES[condition];
  const db = openReadOnlyDatabase(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT stage_state.job_id, jobs.url, jobs.site, stage_state.metadata_json
           FROM job_stage_states stage_state
           JOIN jobs
             ON jobs.tenant_id = stage_state.tenant_id
            AND jobs.job_id = stage_state.job_id
          WHERE stage_state.tenant_id = 'local'
            AND stage_state.stage = ?
            AND stage_state.state = 'blocked'
            AND stage_state.error_code = ?
            AND COALESCE(stage_state.retryable, 1) = 1
          ORDER BY stage_state.job_id`,
      )
      .all(rule.stage, rule.errorCode) as BlockedStageRow[];
    const jobIds = rows
      .filter((row) => rowMatchesCondition(row, condition, rule))
      .map((row) => row.job_id);
    if (jobIds.length === 0) return null;
    return {
      action: "run_stage",
      jobKey: PIPELINE_ACTION_JOB_KEY,
      jobIds,
      stage: rule.stage,
      stages: rule.stages,
      dryRun: false,
      limit: jobIds.length,
      workers: 1,
      minScore: MIN_TAILORING_FIT_SCORE,
      validationMode: "normal",
      reason: `condition_resolved:${condition}`,
    };
  } finally {
    db.close();
  }
}

function rowMatchesCondition(
  row: BlockedStageRow,
  condition: ResolvedBlockCondition,
  rule: BlockConditionRecoveryRule,
): boolean {
  if (!rule.matchesLegacyRow(row)) return false;
  if (!row.metadata_json) return true;
  try {
    const metadata = JSON.parse(row.metadata_json) as unknown;
    if (!metadata || typeof metadata !== "object" || !("blockedConditions" in metadata)) {
      return true;
    }
    const conditions = (metadata as { blockedConditions?: unknown }).blockedConditions;
    return Array.isArray(conditions) && conditions.includes(condition);
  } catch {
    return true;
  }
}

function isLinkedInJob(site: string | null, rawUrl: string): boolean {
  if (String(site ?? "").trim().toLowerCase() === "linkedin") return true;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, "");
    return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
  } catch {
    return false;
  }
}
