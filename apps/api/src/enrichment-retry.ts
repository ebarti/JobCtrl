import { createHash } from "node:crypto";

import {
  JsonRpcErrorCodes,
  ResetStagesErrorReasons,
  ResetStagesParamsSchema,
  ResetStagesResultSchema,
  RpcMethods,
  type BulkJobMutationRequest,
  type Stage,
} from "./contracts.js";
import type { SqliteDatabase } from "./db.js";
import { resolveJobLocator } from "./job-locators.js";
import type { JsonRpcDispatcher } from "./json-rpc-adapter.js";
import type { ActionDispatchContext } from "./local-actions.js";
import {
  getStageStateById,
  ApplyResetRefusedError,
  InputError,
  resolveJobId,
  retryFailedJobTargets,
  type RetryFailedJobsResult,
} from "./write-model.js";

export class RetrySelectionConflict extends Error {
  constructor() {
    super("A selected job or its retry stage changed or is no longer eligible. Refresh the jobs list and review the selection, then retry.");
  }
}

function captureRetryIdentity(db: SqliteDatabase, jobId: string, stage: Stage): { fingerprint: string; stagePresent: boolean } | null {
  // Keep the selected stage, missing-stage marker and job lifecycle in one
  // read snapshot. Python compares the same fields under the write lock.
  const row = db.prepare(
    "SELECT CASE WHEN s.job_id IS NULL THEN 0 ELSE 1 END,"
    + "s.state,CAST(s.attempt_count AS INTEGER),CAST(s.max_attempts AS INTEGER),"
    + "s.started_at,s.updated_at,s.finished_at,CAST(s.duration_ms AS INTEGER),s.error_code,s.error_message,"
    + "CAST(s.retryable AS INTEGER),s.blocked_by_json,s.next_action,s.metadata_json,CAST(s.version AS INTEGER),"
    + "COALESCE((SELECT MAX(e.event_id) FROM job_events e WHERE e.tenant_id=j.tenant_id AND e.job_id=j.job_id AND e.stage=?),0)"
    + ",(SELECT h.hidden_at FROM jobctrl_hidden_jobs h WHERE h.tenant_id=j.tenant_id AND h.job_id=j.job_id)"
    + ",(SELECT h.unhidden_at FROM jobctrl_hidden_jobs h WHERE h.tenant_id=j.tenant_id AND h.job_id=j.job_id)"
    + ",(SELECT d.deleted_at FROM jobctrl_deleted_jobs d WHERE d.tenant_id=j.tenant_id AND d.job_id=j.job_id)"
    + ",(SELECT d.restored_at FROM jobctrl_deleted_jobs d WHERE d.tenant_id=j.tenant_id AND d.job_id=j.job_id)"
    + ",(SELECT p.latest_active_state FROM posting_snapshot_sets p WHERE p.tenant_id=j.tenant_id AND p.job_id=j.job_id)"
    + ",(SELECT CAST(p.latest_snapshot_version AS INTEGER) FROM posting_snapshot_sets p WHERE p.tenant_id=j.tenant_id AND p.job_id=j.job_id)"
    + ",(SELECT p.updated_at FROM posting_snapshot_sets p WHERE p.tenant_id=j.tenant_id AND p.job_id=j.job_id)"
    + ",COALESCE((SELECT MAX(e.event_id) FROM job_events e WHERE e.tenant_id=j.tenant_id AND e.job_id=j.job_id "
    + "AND e.event_type IN ('JobHidden','JobUnhidden','JobDeleted','JobRestored','JobActiveStateChanged',"
    + "'PostingSnapshotStatePersisted')),0)"
    + ",(SELECT CAST(r.revision AS TEXT) FROM job_lifecycle_revisions r WHERE r.tenant_id=j.tenant_id AND r.job_id=j.job_id) "
    + "FROM jobs j LEFT JOIN job_stage_states s ON s.tenant_id=j.tenant_id AND s.job_id=j.job_id AND s.stage=? "
    + "WHERE j.tenant_id=? AND j.job_id=?",
  ).raw().get(stage, stage, "local", jobId) as unknown[] | undefined;
  if (!row || row[row.length - 1] === null) return null;
  if (row.some((value) => typeof value === "number" && !Number.isSafeInteger(value))) {
    throw new Error("Retry target identity cannot be safely represented.");
  }
  return { fingerprint: createHash("sha256").update(JSON.stringify(row)).digest("hex"), stagePresent: row[0] === 1 };
}

async function resetStages(
  rpc: JsonRpcDispatcher,
  context: ActionDispatchContext,
  targets: { jobId: string; jobUrl: string; stage: Stage; expectedFingerprint: string }[],
  resetAttempts: boolean,
  onlyFailed: boolean,
) {
  const params = ResetStagesParamsSchema.parse({
    tenantId: "local", expectedAppDir: context.appDir, expectedDbPath: context.dbPath,
    targets: targets.map(({ jobId, stage, expectedFingerprint }) => ({
      jobId, stage, expectedFingerprint,
    })),
    resetAttempts, onlyFailed,
  });
  const response = await rpc.call(RpcMethods.ResetStages, params);
  if (response.error) {
    const data = response.error.data;
    if (response.error.code === JsonRpcErrorCodes.InvalidParams
      && data !== null && typeof data === "object" && "reason" in data
      && data.reason === ResetStagesErrorReasons.ApplyResetRefused) {
      throw new ApplyResetRefusedError(response.error.message);
    }
    if (response.error.code === JsonRpcErrorCodes.InvalidParams
      && data !== null && typeof data === "object" && "reason" in data
      && data.reason === ResetStagesErrorReasons.RetrySelectionChanged) {
      throw new RetrySelectionConflict();
    }
    throw new Error(response.error.message);
  }
  const result = ResetStagesResultSchema.parse(response.result);
  if (result.resets.length !== targets.length || result.resets.some((reset, index) =>
    reset.jobId !== targets[index]?.jobId || reset.stage !== targets[index]?.stage)) {
    throw new Error("Stage reset returned a different target cohort.");
  }
  // The posting URL can change after the writer commits. It is display data,
  // not acknowledgement or dispatch authority; retain the observed selection.
  return result.resets.map((reset, index) => ({ ...reset, jobUrl: targets[index]!.jobUrl }));
}

export async function resetJobStageWithEnrichmentOwner(
  db: SqliteDatabase, rpc: JsonRpcDispatcher, context: ActionDispatchContext,
  locator: string, stage: Stage, options: { resetAttempts: boolean },
) {
  const target = db.transaction(() => {
    const identity = resolveJobLocator(db, "local", locator);
    if (!identity) throw new InputError("Job not found.");
    const observed = captureRetryIdentity(db, identity.jobId, stage);
    if (!observed) throw new RetrySelectionConflict();
    return { ...identity, stage, expectedFingerprint: observed.fingerprint };
  })();
  const [reset] = await resetStages(rpc, context, [target], options.resetAttempts, false);
  return {
    jobId: target.jobId, jobUrl: reset!.jobUrl, stage: getStageStateById(db, "local", target.jobId, stage),
    retailorRequired: reset!.retailorRequired === true,
  };
}

export async function retryFailedJobsWithEnrichmentOwner(
  db: SqliteDatabase, rpc: JsonRpcDispatcher, context: ActionDispatchContext,
  request: BulkJobMutationRequest & { resetAttempts?: boolean | undefined },
): Promise<RetryFailedJobsResult> {
  // Freeze selection and its stage identities in one SQLite read snapshot.
  // The Python writer compares them before changing any member of the cohort.
  const canonicalTargets = db.transaction(() => {
    const targets = new Map<string, { jobId: string; jobUrl: string; stage: Stage; expectedFingerprint: string }>();
    for (const target of retryFailedJobTargets(db, request)) {
      const jobId = resolveJobId(db, "local", target.jobUrl);
      if (!jobId) throw new InputError("Job not found.");
      const observed = captureRetryIdentity(db, jobId, target.stage);
      if (!observed?.stagePresent) throw new RetrySelectionConflict();
      targets.set(`${jobId}:${target.stage}`, {
        jobId, jobUrl: target.jobUrl, stage: target.stage, expectedFingerprint: observed.fingerprint,
      });
    }
    return [...targets.values()];
  })();
  if (canonicalTargets.length === 0) return { ok: true, count: 0, jobKeys: [], targets: [], stageCounts: {} };
  // One RPC owns the whole cohort so a failed reset cannot partially commit.
  const resets = await resetStages(rpc, context, canonicalTargets, request.resetAttempts ?? false, true);
  const stageCounts: Partial<Record<Stage, number>> = {};
  for (const reset of resets) stageCounts[reset.stage] = (stageCounts[reset.stage] ?? 0) + 1;
  return {
    ok: true, count: resets.length, jobKeys: resets.map((reset) => reset.jobId),
    targets: resets.map(({ jobId, jobUrl, stage, retailorRequired }) => ({ jobId, jobUrl, stage, ...(retailorRequired ? { retailorRequired } : {}) })),
    stageCounts,
    retailorRequiredJobKeys: resets.filter((reset) => reset.retailorRequired).map((reset) => reset.jobId),
  };
}
