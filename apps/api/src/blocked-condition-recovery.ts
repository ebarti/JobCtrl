import { createHash } from "node:crypto";

import {
  MIN_TAILORING_FIT_SCORE,
  PIPELINE_ACTION_JOB_KEY,
  type ActionCommandPayload,
  type Stage,
} from "./contracts.js";
import { openDatabase } from "./db.js";

export const DISCOVERY_BROWSER_EXTENSION_UNAVAILABLE =
  "discovery_browser_extension_unavailable" as const;
const LEGACY_AUTHENTICATED_LINKEDIN_BROWSER_UNAVAILABLE =
  "authenticated_linkedin_browser_unavailable" as const;

export type ResolvedBlockCondition =
  typeof DISCOVERY_BROWSER_EXTENSION_UNAVAILABLE;

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
  version: number;
}

const RECOVERY_RULES: Record<ResolvedBlockCondition, BlockConditionRecoveryRule> = {
  [DISCOVERY_BROWSER_EXTENSION_UNAVAILABLE]: {
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
  const db = openDatabase(dbPath);
  try {
    return db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT stage_state.job_id, jobs.url, jobs.site,
                  stage_state.metadata_json, stage_state.version
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
      const claimed = rows
        .filter((row) => rowMatchesCondition(row, condition, rule))
        .map((row) => claimRecoveryKey(db, row, condition))
        .filter((row): row is { jobId: string; recoveryKey: string } => row !== null);
      if (claimed.length === 0) return null;
      const jobIds = claimed.map((row) => row.jobId);
      const command: ActionCommandPayload = {
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
      return command;
    })();
  } finally {
    db.close();
  }
}

function claimRecoveryKey(
  db: ReturnType<typeof openDatabase>,
  row: BlockedStageRow,
  condition: ResolvedBlockCondition,
): { jobId: string; recoveryKey: string } | null {
  const metadata = parseMetadata(row.metadata_json);
  const existingKey = typeof metadata.conditionRecoveryKey === "string"
    ? metadata.conditionRecoveryKey.trim()
    : "";
  if (existingKey) {
    return { jobId: row.job_id, recoveryKey: existingKey };
  }
  const recoveryKey = createHash("sha256")
    .update(`${condition}\n${row.job_id}\n${row.version}`)
    .digest("hex")
    .slice(0, 24);
  metadata.conditionRecoveryKey = recoveryKey;
  const updated = db.prepare(
    `UPDATE job_stage_states
        SET metadata_json = ?, updated_at = ?, version = version + 1
      WHERE tenant_id = 'local'
        AND job_id = ?
        AND stage = 'enrich'
        AND state = 'blocked'
        AND version = ?`,
  ).run(JSON.stringify(metadata), new Date().toISOString(), row.job_id, row.version);
  return updated.changes === 1 ? { jobId: row.job_id, recoveryKey } : null;
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch {
    return {};
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
    return Array.isArray(conditions) && (
      conditions.includes(condition) ||
      // Preserve recovery for rows written before Enrich moved from the copied
      // LinkedIn profile capability to the selected live-profile extension.
      conditions.includes(LEGACY_AUTHENTICATED_LINKEDIN_BROWSER_UNAVAILABLE)
    );
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
