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
  const rows = allRows<{ event_id: number; payload_json: string | null }>(db,
    "SELECT event_id,payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' AND event_type='ApplyRunStarted' ORDER BY event_id DESC LIMIT 1",
    [tenantId, jobId]);
  if (!rows[0]) {
    return allRows(db, "SELECT 1 FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' AND event_type='ApplyClaimAcquired' LIMIT 1", [tenantId, jobId]).length > 0;
  }
  let owner: { run_id?: unknown; workflow_id?: unknown };
  try { owner = JSON.parse(rows[0].payload_json ?? "{}"); } catch { return true; }
  if (!owner || typeof owner.run_id !== "string" || !owner.run_id) return true;
  const claimRows = allRows<{ event_id: number; payload_json: string | null }>(db,
    "SELECT event_id,payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' AND event_type='ApplyClaimAcquired' ORDER BY event_id DESC LIMIT 1",
    [tenantId, jobId]);
  if (claimRows[0]) {
    let claim: { run_id?: unknown; launcher_id?: unknown };
    try { claim = JSON.parse(claimRows[0].payload_json ?? "{}"); } catch { return true; }
    if (!claim || claim.run_id !== owner.run_id) return true;
    if (claim.launcher_id !== null && claim.launcher_id !== undefined) {
      if (typeof claim.launcher_id !== "string" || !claim.launcher_id) return true;
      const settled = allRows(db, `SELECT 1 FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply'
        AND event_id > ? AND event_type IN ('ApplyClaimSettled','ApplyCustodyRetired')
        AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.run_id')=?
        AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.launcher_id')=? LIMIT 1`,
      [tenantId, jobId, claimRows[0].event_id, owner.run_id, claim.launcher_id]);
      return !settled.length;
    }
  }
  const terminal = allRows(db, `SELECT 1 FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply'
    AND event_type IN ('ApplicationSubmitted','ApplicationFailed','DryRunCompleted','ApplyManualSkip','ApplyCustodyRetired')
    AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.run_id')=? LIMIT 1`,
    [tenantId, jobId, owner.run_id]);
  if (terminal.length) return false;
  return true;
}

export function hasUnresolvedSkippedOutcome(db: SqliteDatabase, tenantId: string, jobId: string): boolean {
  return allRows(db, `SELECT 1 FROM job_events stopped WHERE stopped.tenant_id=? AND stopped.job_id=?
    AND stopped.stage='apply' AND ((stopped.event_type='StageSkipped'
      AND json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.previousState')='needs_verification')
      OR (stopped.event_type='ApplicationFailed'
      AND json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.result')='needs_verification'))
    AND NOT EXISTS (SELECT 1 FROM job_events resolved WHERE resolved.tenant_id=stopped.tenant_id
      AND resolved.job_id=stopped.job_id AND resolved.stage='apply' AND resolved.event_type='ApplicationManuallyMarked'
      AND resolved.event_id > stopped.event_id)
    AND NOT (stopped.event_type='ApplicationFailed'
      AND COALESCE(json_type(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.run_id'),'')='text'
      AND length(json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.run_id')) > 0
      AND EXISTS (SELECT 1 FROM job_events submitted WHERE submitted.tenant_id=stopped.tenant_id AND submitted.job_id=stopped.job_id
        AND submitted.stage='apply' AND submitted.event_type='ApplicationSubmitted' AND submitted.event_id > stopped.event_id
        AND json_extract(CASE WHEN json_valid(submitted.payload_json) THEN submitted.payload_json ELSE '{}' END,'$.run_id') =
          json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.run_id')))
    LIMIT 1`, [tenantId, jobId]).length > 0;
}

/** A local relabel cannot undo an accepted Applied outcome. */
export function hasRecordedAppliedAuthority(db: SqliteDatabase, tenantId: string, jobId: string): boolean {
  return allRows(db, `SELECT 1 FROM job_events event WHERE event.tenant_id=? AND event.job_id=? AND event.stage='apply'
    AND (event.event_type IN ('ApplicationManuallyMarked','ApplicationSubmitted') OR
      (event.event_type='StageSkipped' AND json_extract(CASE WHEN json_valid(event.payload_json) THEN event.payload_json ELSE '{}' END,'$.previousState')='succeeded')) LIMIT 1`,
  [tenantId, jobId]).length > 0;
}

/** A skipped queued row has no owner settlement with which to prove it stopped. */
export function hasSkippedQueuedAuthority(db: SqliteDatabase, tenantId: string, jobId: string): boolean {
  return allRows(db, `SELECT 1 FROM job_events event WHERE event.tenant_id=? AND event.job_id=? AND event.stage='apply'
    AND event.event_type='StageSkipped'
    AND json_extract(CASE WHEN json_valid(event.payload_json) THEN event.payload_json ELSE '{}' END,'$.manualDisposition')='skip'
    AND json_extract(CASE WHEN json_valid(event.payload_json) THEN event.payload_json ELSE '{}' END,'$.previousState')='queued' LIMIT 1`,
  [tenantId, jobId]).length > 0;
}

// The older score producer wrote this complete structured event. A legacy
// manual Skip could contain any user-authored reason, so that field alone
// cannot establish score-policy authority.
const LEGACY_SCORE_POLICY_SQL = `COALESCE((
  policy.event_type='StageSkipped'
  AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.reason')='score_below_threshold'
  AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.upstreamStage')='score'
  AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.downstreamStage')='apply'
  AND json_type(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.fitScore')='integer'
  AND json_type(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.minScore')='integer'
  AND policy.message='Fit score ' || CAST(json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.fitScore') AS TEXT)
    || '/10 is below the materials threshold ' || CAST(json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.minScore') AS TEXT) || '/10.'
), 0)`;

/** Recover policy provenance from older Skip writes that cleared the stage's error code. */
export function hasRetainedPolicySkip(db: SqliteDatabase, tenantId: string, jobId: string): boolean {
  return allRows(db, `SELECT 1 FROM job_events policy WHERE policy.tenant_id=? AND policy.job_id=? AND policy.stage='apply'
    AND (
      (policy.event_type='StageSkipped'
        AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.manualDisposition')='skip'
        AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.previousState')='skipped'
        AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.previousErrorCode') IS NOT NULL
        AND json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.previousErrorCode') <> 'DRY_RUN')
      OR ((policy.event_type='ApplyManualSkip' AND policy.message='manual ATS') OR ${LEGACY_SCORE_POLICY_SQL})
        AND EXISTS (SELECT 1 FROM job_events stopped WHERE stopped.tenant_id=policy.tenant_id AND stopped.job_id=policy.job_id
          AND stopped.stage='apply' AND stopped.event_type='StageSkipped' AND stopped.event_id > policy.event_id
          AND ((json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.manualDisposition')='skip'
            AND json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.previousState')='skipped')
            OR stopped.message='Job marked skipped from the local API.'))
    )
    AND NOT ((${LEGACY_SCORE_POLICY_SQL}
          OR COALESCE(json_extract(CASE WHEN json_valid(policy.payload_json) THEN policy.payload_json ELSE '{}' END,'$.previousErrorCode'),'')='MIN_SCORE')
      AND EXISTS (SELECT 1 FROM job_events cleared WHERE cleared.tenant_id=policy.tenant_id AND cleared.job_id=policy.job_id
        AND cleared.stage='apply' AND cleared.event_type='StageReset' AND cleared.event_id > policy.event_id
        AND cleared.message='apply restored after the score threshold allowed materials.'
        AND json_extract(CASE WHEN json_valid(cleared.payload_json) THEN cleared.payload_json ELSE '{}' END,'$.reason')='score_threshold_cleared'
        AND json_extract(CASE WHEN json_valid(cleared.payload_json) THEN cleared.payload_json ELSE '{}' END,'$.upstreamStage')='score'
        AND json_extract(CASE WHEN json_valid(cleared.payload_json) THEN cleared.payload_json ELSE '{}' END,'$.downstreamStage')='apply'))
    LIMIT 1`, [tenantId, jobId]).length > 0;
}

/** Only an explicit reset/resolution releases a recorded human stop. */
export function hasManualApplyStop(db: SqliteDatabase, tenantId: string, jobId: string): boolean {
  return allRows(db, `SELECT 1 FROM job_events stopped WHERE stopped.tenant_id=? AND stopped.job_id=?
    AND stopped.stage='apply' AND stopped.event_type='StageSkipped'
    AND (json_extract(CASE WHEN json_valid(stopped.payload_json) THEN stopped.payload_json ELSE '{}' END,'$.manualDisposition')='skip'
      OR stopped.message='Job marked skipped from the local API.')
    AND NOT EXISTS (SELECT 1 FROM job_events released WHERE released.tenant_id=stopped.tenant_id
      AND released.job_id=stopped.job_id AND released.stage='apply'
      AND (released.event_type='ApplicationManuallyMarked' OR (
        released.event_type='StageReset'
        AND json_extract(CASE WHEN json_valid(released.payload_json) THEN released.payload_json ELSE '{}' END,'$.resetAuthority')='explicit_safe_apply_reset'
        AND json_type(CASE WHEN json_valid(released.payload_json) THEN released.payload_json ELSE '{}' END,'$.manualSkipReleasedThroughEventId')='integer'
        AND json_extract(CASE WHEN json_valid(released.payload_json) THEN released.payload_json ELSE '{}' END,'$.manualSkipReleasedThroughEventId') >= stopped.event_id
        AND json_extract(CASE WHEN json_valid(released.payload_json) THEN released.payload_json ELSE '{}' END,'$.manualSkipReleasedThroughEventId') < released.event_id))
      AND released.event_id > stopped.event_id) LIMIT 1`, [tenantId, jobId]).length > 0;
}

/** Consume existing accepted submission facts; receipt validation belongs to the sender/settlement owner. */
export function applyIntentOutcomeRecorded(db: SqliteDatabase, tenantId: string, jobId: string): boolean {
  return allRows(db, `SELECT 1 FROM jobs job WHERE job.tenant_id=? AND job.job_id=?
    AND EXISTS (SELECT 1 FROM job_events intent WHERE intent.tenant_id=job.tenant_id AND intent.job_id=job.job_id
      AND intent.stage='apply' AND intent.event_type='ApplySubmitIntended')
    AND NOT EXISTS (SELECT 1 FROM job_events intent WHERE intent.tenant_id=job.tenant_id
      AND intent.job_id=job.job_id AND intent.stage='apply' AND intent.event_type='ApplySubmitIntended'
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
