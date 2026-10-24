import { allRows, getRow, type SqliteDatabase } from "./db.js";

/** Durable external authority is read from every intent, never the latest projection. */
export function applySubmitIntentRunIds(db: SqliteDatabase, tenantId: string, jobId: string): string[] {
  return allRows<{ payload_json: string | null }>(db,
    "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' AND event_type='ApplySubmitIntended' ORDER BY event_id",
    [tenantId, jobId],
  ).map((row) => {
    try {
      const payload: unknown = JSON.parse(row.payload_json ?? "{}");
      return payload && typeof payload === "object" && "run_id" in payload && typeof payload.run_id === "string" && payload.run_id.length > 0
        ? payload.run_id : "unknown";
    } catch { return "unknown"; }
  });
}


/** A later explicit user attestation records Applied without deleting intent. */
export function applyIntentManuallyResolved(db: SqliteDatabase, tenantId: string, jobId: string): boolean {
  return allRows(db, `SELECT 1 FROM job_events marked
    JOIN job_stage_states state ON state.tenant_id=marked.tenant_id AND state.job_id=marked.job_id
      AND state.stage='apply' AND state.state='succeeded'
    WHERE marked.tenant_id=? AND marked.job_id=? AND marked.stage='apply'
      AND marked.event_type='ApplicationManuallyMarked'
      AND NOT EXISTS (SELECT 1 FROM job_events intent WHERE intent.tenant_id=marked.tenant_id
        AND intent.job_id=marked.job_id AND intent.stage='apply' AND intent.event_type='ApplySubmitIntended'
        AND intent.event_id > marked.event_id) LIMIT 1`, [tenantId, jobId]).length > 0;
}

export function hasUnsettledApplyRun(db: SqliteDatabase, tenantId: string, jobId: string): boolean {
  const rows = allRows<{ payload_json: string | null }>(db,
    "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' AND event_type='ApplyRunStarted' ORDER BY event_id DESC LIMIT 1",
    [tenantId, jobId]);
  if (!rows[0]) return false;
  let owner: { run_id?: unknown; workflow_id?: unknown };
  try { owner = JSON.parse(rows[0].payload_json ?? "{}"); } catch { return true; }
  if (!owner || typeof owner.run_id !== "string" || !owner.run_id) return true;
  const terminal = allRows(db, `SELECT 1 FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply'
    AND event_type IN ('ApplicationSubmitted','ApplicationFailed','DryRunCompleted','ApplyManualSkip','LockReleased')
    AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.run_id')=? LIMIT 1`,
    [tenantId, jobId, owner.run_id]);
  if (terminal.length) return false;
  return true;
}

export function hasUnresolvedSkippedOutcome(db: SqliteDatabase, tenantId: string, jobId: string): boolean {
  return allRows(db, `SELECT 1 FROM job_events stopped WHERE stopped.tenant_id=? AND stopped.job_id=?
    AND stopped.stage='apply' AND stopped.event_type='StageSkipped'
    AND json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.previousState')='needs_verification'
    AND NOT EXISTS (SELECT 1 FROM job_events resolved WHERE resolved.tenant_id=stopped.tenant_id
      AND resolved.job_id=stopped.job_id AND resolved.stage='apply' AND resolved.event_type='ApplicationManuallyMarked'
      AND resolved.event_id > stopped.event_id) LIMIT 1`, [tenantId, jobId]).length > 0;
}

/** Only an explicit reset/resolution releases a recorded human stop. */
export function hasManualApplyStop(db: SqliteDatabase, tenantId: string, jobId: string): boolean {
  return allRows(db, `SELECT 1 FROM job_events stopped WHERE stopped.tenant_id=? AND stopped.job_id=?
    AND stopped.stage='apply' AND stopped.event_type='StageSkipped'
    AND json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.manualDisposition')='skip'
    AND NOT EXISTS (SELECT 1 FROM job_events released WHERE released.tenant_id=stopped.tenant_id
      AND released.job_id=stopped.job_id AND released.stage='apply'
      AND released.event_type IN ('StageReset','ApplicationManuallyMarked')
      AND released.event_id > stopped.event_id) LIMIT 1`, [tenantId, jobId]).length > 0;
}

/** Consume existing accepted submission facts; receipt validation belongs to the sender/settlement owner. */
export function applyIntentOutcomeRecorded(db: SqliteDatabase, tenantId: string, jobId: string): boolean {
  if (hasManualApplyStop(db, tenantId, jobId)) return false;
  return allRows(db, `SELECT 1 FROM job_stage_states state WHERE state.tenant_id=? AND state.job_id=?
    AND state.stage='apply' AND state.state='succeeded'
    AND NOT EXISTS (SELECT 1 FROM job_events intent WHERE intent.tenant_id=state.tenant_id
      AND intent.job_id=state.job_id AND intent.stage='apply' AND intent.event_type='ApplySubmitIntended'
      AND NOT EXISTS (SELECT 1 FROM job_events submitted WHERE submitted.tenant_id=intent.tenant_id
        AND submitted.job_id=intent.job_id AND submitted.stage='apply' AND submitted.event_type='ApplicationSubmitted'
        AND submitted.event_id > intent.event_id
        AND json_type(CASE WHEN json_valid(intent.payload_json) THEN intent.payload_json ELSE '{}' END,'$.run_id')='text'
        AND length(json_extract(CASE WHEN json_valid(intent.payload_json) THEN intent.payload_json ELSE '{}' END,'$.run_id')) > 0
        AND json_extract(CASE WHEN json_valid(submitted.payload_json) THEN submitted.payload_json ELSE '{}' END,'$.run_id') =
          json_extract(CASE WHEN json_valid(intent.payload_json) THEN intent.payload_json ELSE '{}' END,'$.run_id')))
    LIMIT 1`, [tenantId, jobId]).length > 0;
}

/** Shared canonical inputs for Job Detail and Apply Review; never infer from latest-run projections. */
export function readApplyAuditControls(db: SqliteDatabase, tenantId: string, jobId: string) {
  const state = getRow<{ state: string; error_code: string | null; retryable: number }>(db,
    "SELECT state,error_code,retryable FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'",
    [tenantId, jobId]);
  return {
    submitIntentRunIds: applySubmitIntentRunIds(db, tenantId, jobId),
    intentManuallyResolved: applyIntentManuallyResolved(db, tenantId, jobId),
    intentOutcomeRecorded: applyIntentOutcomeRecorded(db, tenantId, jobId),
    unresolvedSkippedOutcome: hasUnresolvedSkippedOutcome(db, tenantId, jobId),
    manuallySkipped: hasManualApplyStop(db, tenantId, jobId) ||
      (state?.state === "skipped" && state.error_code === null && state.retryable === 0),
  };
}
