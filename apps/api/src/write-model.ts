import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type {
  BulkJobMutationRequest,
  CorrectScoreRequest,
  DeleteJobRequest,
  JobMutationResponse,
  MarkJobActionRequest,
  ResetStaleScoresForRescoreResponse,
  SettingsResponse,
  SettingsUpdateRequest,
  Stage,
  StageState,
  StageSummary,
} from "./contracts.js";
import { STAGES } from "./contracts.js";
import {
  isValidTransition,
  deserializeStageStateKind,
  type StageStateKind,
} from "@jobctrl/domain-types";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import { matchingJobKeys, readSettingsConfig } from "./read-model.js";
import { updateConfigObject } from "./config-file.js";
import { rebuildTenantDeleteProjections } from "./projections.js";

export class InputError extends Error {}

export interface RetryFailedJobTarget {
  readonly jobUrl: string;
  readonly stage: Stage;
}

export interface RetryFailedJobsResult extends JobMutationResponse {
  readonly targets: RetryFailedJobTarget[];
  readonly stageCounts: Partial<Record<Stage, number>>;
}

const DEFAULT_MAX_ATTEMPTS: Record<Stage, number> = {
  discover: 1,
  enrich: 3,
  score: 3,
  tailor: 5,
  cover: 5,
  apply: 3,
};
const LOCAL_TENANT = "local";

interface ResolvedJobIdentity {
  readonly jobId: string;
  readonly jobUrl: string;
}

const IMMUTABLE_CANCEL_STATES: ReadonlySet<StageState> = new Set([
  "succeeded",
  "failed",
  "skipped",
  "exhausted",
  "needs_verification",
  "canceled",
]);

const DEFAULT_SCORING_RUBRIC_VERSION = "default-scoring-rubric-v1";
const DEFAULT_SCORING_DIMENSIONS = [
  { name: "technical_fit", weight: 0.45 },
  { name: "experience_fit", weight: 0.3 },
  { name: "role_fit", weight: 0.25 },
] as const;
const DEFAULT_FIT_BAND_THRESHOLDS = [
  { band: "excellent", minimum_score: 9 },
  { band: "strong", minimum_score: 7 },
  { band: "plausible", minimum_score: 5 },
  { band: "stretch", minimum_score: 3 },
  { band: "poor", minimum_score: 1 },
] as const;

/**
 * Validate a stage-state transition using the §8.5 state machine
 * (`packages/domain-types/src/pipeline/state_machine.ts`).
 *
 * Reads the current state from the DB. If no row exists yet (INSERT path),
 * the transition is always allowed. If the current state equals the target,
 * the call is idempotent — also allowed.
 *
 * Throws `InputError` when the transition is rejected.
 *
 * Wired into `upsertStageState`, so every write-model command —
 * `resetJobStage`, `markJobApplied`, `markJobSkipped`, `cancelJobAction` —
 * is gated by §8.5 before the SQLite write happens.
 */
export function validateStageTransition(
  db: SqliteDatabase,
  jobLocator: string,
  stage: Stage,
  targetState: StageState,
): void {
  const job = resolveJobIdentity(db, LOCAL_TENANT, jobLocator);
  if (!job) throw new InputError("Job not found.");
  validateStageTransitionById(db, LOCAL_TENANT, job.jobId, stage, targetState);
}

function validateStageTransitionById(
  db: SqliteDatabase,
  tenantId: string,
  jobId: string,
  stage: Stage,
  targetState: StageState,
): void {
  const row = getRow<{ state?: string }>(
    db,
    "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = ?",
    [tenantId, jobId, stage],
  );
  if (!row || !row.state) {
    return; // No existing row — INSERT path, always valid.
  }
  const currentStateStr = row.state;
  if (currentStateStr === targetState) {
    return; // Idempotent write.
  }
  let fromKind: StageStateKind;
  let toKind: StageStateKind;
  try {
    fromKind = deserializeStageStateKind(currentStateStr);
    toKind = deserializeStageStateKind(targetState);
  } catch {
    // Unknown state strings — skip validation rather than crash.
    return;
  }
  if (!isValidTransition(fromKind, toKind)) {
    throw new InputError(
      `Invalid state transition for ${stage}: ${currentStateStr} → ${targetState} (not allowed by the §8.5 stage state machine)`,
    );
  }
}

export function resolveJobUrl(db: SqliteDatabase, jobKey: string): string | null {
  return resolveJobIdentity(db, LOCAL_TENANT, jobKey)?.jobUrl ?? null;
}

export function resolveJobId(db: SqliteDatabase, tenantId: string, jobLocator: string): string | null {
  return resolveJobIdentity(db, tenantId, jobLocator)?.jobId ?? null;
}

function resolveJobIdentity(
  db: SqliteDatabase,
  tenantId: string,
  jobLocator: string,
): ResolvedJobIdentity | null {
  const row = getRow<{ job_id?: string; url?: string }>(
    db,
    `SELECT job_id, url
       FROM jobs
      WHERE tenant_id = ?
        AND (
          job_id = ?
          OR url = ?
          OR application_url = ?
          OR EXISTS (
            SELECT 1
              FROM job_locators
             WHERE job_locators.tenant_id = jobs.tenant_id
               AND job_locators.job_id = jobs.job_id
               AND job_locators.locator_value = ?
          )
        )
      LIMIT 1`,
    [tenantId, jobLocator, jobLocator, jobLocator, jobLocator],
  );
  return row?.job_id && row.url ? { jobId: row.job_id, jobUrl: row.url } : null;
}

export function resetJobStage(
  db: SqliteDatabase,
  jobKey: string,
  stage: Stage,
  options: { resetAttempts: boolean },
): { jobUrl: string; stage: StageSummary } {
  const job = resolveJobIdentity(db, LOCAL_TENANT, jobKey);
  if (!job) throw new InputError("Job not found.");
  return resetResolvedJobStage(db, job, stage, options);
}

function resetResolvedJobStage(
  db: SqliteDatabase,
  job: ResolvedJobIdentity,
  stage: Stage,
  options: { resetAttempts: boolean },
): { jobUrl: string; stage: StageSummary } {
  // Reset is an admin override (parity with Python's `reset_job_stage`),
  // so even though we _call_ isValidTransition (via validateStageTransition)
  // when the gate is opt-in, this entry-point bypasses §8.5 — the user is
  // explicitly forcing the stage back to pending.
  if (stage === "enrich") {
    resetEnrichmentAggregate(db, LOCAL_TENANT, job.jobId);
  }
  const stageOptions: Parameters<typeof upsertStageStateById>[5] = {
    retryable: true,
    clearTiming: true,
    skipValidation: true,
  };
  if (options.resetAttempts) {
    stageOptions.attemptCount = 0;
  }
  upsertStageStateById(db, LOCAL_TENANT, job.jobId, stage, "pending", stageOptions);
  recordActionEventById(db, {
    tenantId: LOCAL_TENANT,
    jobId: job.jobId,
    stage,
    // H1 (round-1 review): align with domain catalog — `StageReset` already
    // exists in `domain/events/orchestration.py`.  Python's
    // `state.py::reset_job_stage` writes the same string.
    eventType: "StageReset",
    level: "info",
    message: `Retry reset requested for ${stage}`,
    payload: { reset_attempts: options.resetAttempts },
  });
  return { jobUrl: job.jobUrl, stage: getStageStateById(db, LOCAL_TENANT, job.jobId, stage) };
}

export function retryFailedJobs(db: SqliteDatabase, request: BulkJobMutationRequest): RetryFailedJobsResult {
  const candidates = mutableResolvedJobs(db, request);
  const targets = candidates
    .map((job) => ({ job, stage: currentFailedStageById(db, LOCAL_TENANT, job.jobId) }))
    .filter((target): target is { job: ResolvedJobIdentity; stage: Stage } => target.stage !== null);
  const transaction = db.transaction((rows: typeof targets) => {
    for (const { job, stage } of rows) {
      resetResolvedJobStage(db, job, stage, { resetAttempts: false });
    }
  });
  transaction(targets);
  const responseTargets = targets.map(({ job, stage }) => ({ jobUrl: job.jobUrl, stage }));
  return {
    ok: true,
    count: responseTargets.length,
    jobKeys: responseTargets.map((target) => target.jobUrl),
    targets: responseTargets,
    stageCounts: stageCountsForRetryTargets(responseTargets),
  };
}

function stageCountsForRetryTargets(targets: readonly RetryFailedJobTarget[]): Partial<Record<Stage, number>> {
  const counts: Partial<Record<Stage, number>> = {};
  for (const target of targets) {
    counts[target.stage] = (counts[target.stage] ?? 0) + 1;
  }
  return counts;
}

export function queueRetriedJobsForWorkflow(
  db: SqliteDatabase,
  targets: readonly RetryFailedJobTarget[],
  workflow: {
    readonly workflowId?: string;
    readonly runId?: string;
    readonly actionId?: string;
    readonly requestedWorkers?: number;
    readonly requestedLimit?: number;
    readonly source?: string;
    readonly message?: string;
  },
): void {
  const source = workflow.source ?? "bulk_retry_failed";
  const transaction = db.transaction((rows: readonly RetryFailedJobTarget[]) => {
    for (const target of rows) {
      const job = resolveJobIdentity(db, LOCAL_TENANT, target.jobUrl);
      if (!job) throw new InputError("Job not found.");
      const current = getRow<{ state?: string }>(
        db,
        "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = ?",
        [LOCAL_TENANT, job.jobId, target.stage],
      );
      if (current?.state && current.state !== "pending") {
        continue;
      }
      upsertStageStateById(db, LOCAL_TENANT, job.jobId, target.stage, "queued", {
        retryable: true,
      });
      recordActionEventById(db, {
        tenantId: LOCAL_TENANT,
        jobId: job.jobId,
        stage: target.stage,
        eventType: "StageQueued",
        level: "info",
        message: workflow.message ?? `${target.stage} queued after bulk retry`,
        payload: {
          source,
          workflowId: workflow.workflowId ?? null,
          workflow_id: workflow.workflowId ?? null,
          runId: workflow.runId ?? null,
          run_id: workflow.runId ?? null,
          actionId: workflow.actionId ?? null,
          requestedWorkers: workflow.requestedWorkers ?? null,
          requestedLimit: workflow.requestedLimit ?? null,
        },
      });
    }
  });
  transaction(targets);
}

export function markJobApplied(
  db: SqliteDatabase,
  jobKey: string,
  request: MarkJobActionRequest,
): { jobUrl: string; stage: StageSummary } {
  const job = resolveJobIdentity(db, LOCAL_TENANT, jobKey);
  if (!job) {
    throw new InputError("Job not found.");
  }
  // Manual mark-applied — admin override, bypasses §8.5 (parity with the
  // Python JSON-RPC `mark_applied` handler).  The user is asserting they
  // applied externally; we trust them.
  upsertStageStateById(db, LOCAL_TENANT, job.jobId, "apply", "succeeded", {
    retryable: false,
    finishedAt: new Date().toISOString(),
    skipValidation: true,
  });
  recordActionEventById(db, {
    tenantId: LOCAL_TENANT,
    jobId: job.jobId,
    stage: "apply",
    // H1 (round-1 review): align with the Python JSON-RPC handler
    // (`infrastructure/rpc/handlers.py::mark_applied`) which writes the
    // same string.  Same logical action across both write surfaces.
    eventType: "ApplicationManuallyMarked",
    level: "info",
    message: "Job marked applied from the local API.",
    payload: { reason: request.reason ?? "" },
  });
  return {
    jobUrl: job.jobUrl,
    stage: getStageStateById(db, LOCAL_TENANT, job.jobId, "apply"),
  };
}

export function markJobSkipped(
  db: SqliteDatabase,
  jobKey: string,
  request: MarkJobActionRequest,
): { jobUrl: string; stage: StageSummary } {
  const job = resolveJobIdentity(db, LOCAL_TENANT, jobKey);
  if (!job) {
    throw new InputError("Job not found.");
  }
  // Manual mark-skipped — admin override, bypasses §8.5 (parity with
  // Python's `mark_skipped` JSON-RPC handler).
  upsertStageStateById(db, LOCAL_TENANT, job.jobId, "apply", "skipped", {
    retryable: false,
    finishedAt: new Date().toISOString(),
    skipValidation: true,
  });
  recordActionEventById(db, {
    tenantId: LOCAL_TENANT,
    jobId: job.jobId,
    stage: "apply",
    // H1 (round-1 review): align with domain catalog — `StageSkipped`
    // already exists in `domain/events/orchestration.py`.  The Python RPC
    // `mark_skipped` handler writes the same string.
    eventType: "StageSkipped",
    level: "info",
    message: "Job marked skipped from the local API.",
    payload: { reason: request.reason ?? "" },
  });
  return {
    jobUrl: job.jobUrl,
    stage: getStageStateById(db, LOCAL_TENANT, job.jobId, "apply"),
  };
}

export function cancelJobAction(
  db: SqliteDatabase,
  jobKey: string,
  runId = "",
): { jobUrl: string; stage: StageSummary; cancelRequested: boolean } {
  const job = resolveJobIdentity(db, LOCAL_TENANT, jobKey);
  if (!job) {
    throw new InputError("Job not found.");
  }
  const stage = currentMutableStageById(db, LOCAL_TENANT, job.jobId);
  const current = getStageStateById(db, LOCAL_TENANT, job.jobId, stage);
  if (IMMUTABLE_CANCEL_STATES.has(current.state)) {
    return { jobUrl: job.jobUrl, stage: current, cancelRequested: false };
  }
  // Cancellation is a normal state-machine transition. Only queued/running
  // work may enter Canceled; terminal results remain inspectable and immutable.
  upsertStageStateById(db, LOCAL_TENANT, job.jobId, stage, "canceled", {
    retryable: true,
    finishedAt: new Date().toISOString(),
  });
  recordActionEventById(db, {
    tenantId: LOCAL_TENANT,
    jobId: job.jobId,
    stage,
    // Canonical `StageCanceled` catalog event (see
    // `domain/events/orchestration.py`).
    eventType: "StageCanceled",
    level: "warning",
    message: "Cancel requested from the local API.",
    payload: { run_id: runId },
  });
  return {
    jobUrl: job.jobUrl,
    stage: getStageStateById(db, LOCAL_TENANT, job.jobId, stage),
    cancelRequested: true,
  };
}

export function correctScore(
  db: SqliteDatabase,
  tenantId: string,
  jobId: string,
  request: CorrectScoreRequest,
): { jobId: string; version: number } {
  ensureJobScoresTable(db);
  ensureScoreStalenessTable(db);
  const latest = getRow<Record<string, unknown>>(
    db,
    `SELECT * FROM job_scores
     WHERE tenant_id = ? AND job_id = ?
     ORDER BY version DESC LIMIT 1`,
    [tenantId, jobId],
  );
  if (!latest) {
    throw new InputError("Score correction requires an existing score.");
  }
  const now = new Date().toISOString();
  const nextVersion = Number(latest.version ?? 0) + 1;
  const correction = {
    corrected_fit_score: request.correctedScore,
    rationale: request.reason,
    corrected_by: tenantId,
    corrected_at: now,
  };
  const trace = appendCorrectionHistory(latest.trace_json, {
    original_score: Number(latest.fit_score ?? 0),
    corrected_score: request.correctedScore,
    rationale: request.reason,
    corrected_by: tenantId,
    corrected_at: now,
  });
  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO job_scores (
         tenant_id, job_id, version, fit_score, breakdown_json, keywords_json,
         scored_at, correction_json, criteria_json, trace_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tenantId,
      jobId,
      nextVersion,
      request.correctedScore,
      String(latest.breakdown_json ?? "{}"),
      String(latest.keywords_json ?? "[]"),
      now,
      JSON.stringify(correction),
      String(latest.criteria_json ?? "{}"),
      JSON.stringify(trace),
    );
    const policyChange = persistScoringPolicyCorrection(db, {
      tenantId,
      jobId,
      latest,
      correctedScore: request.correctedScore,
      correctedAt: now,
    });
    markComparableScoresStale(db, {
      tenantId,
      correctedJobId: jobId,
      markedAt: now,
      newPolicyId: `${tenantId}:scoring-policy-v${policyChange.newPolicyVersion}`,
      newPolicyVersion: policyChange.newPolicyVersion,
    });
    recordActionEventById(db, {
      tenantId,
      jobId,
      stage: "score",
      eventType: "ScoreCorrected",
      level: "info",
      message: "Score corrected from the local API.",
      payload: {
        originalScore: Number(latest.fit_score ?? 0),
        correctedScore: request.correctedScore,
        reason: request.reason,
        correctedAt: now,
      },
    });
  });
  transaction();
  return { jobId, version: nextVersion };
}

export function resetStaleScoresForRescore(
  db: SqliteDatabase,
  request: { limit?: number; jobIds?: readonly string[] } = {},
): ResetStaleScoresForRescoreResponse {
  ensureScoreStalenessTable(db);
  const limit = Math.max(0, Math.floor(request.limit ?? 0));
  const jobIdsFilter = [...new Set((request.jobIds ?? []).map((jobId) => jobId.trim()).filter(Boolean))];
  const selectedWhere = request.jobIds === undefined
    ? ""
    : jobIdsFilter.length
      ? ` AND job_id IN (${jobIdsFilter.map(() => "?").join(", ")})`
      : " AND 0";
  const rows = allRows<Record<string, unknown>>(
    db,
    `SELECT tenant_id, job_id, stale_reason, old_policy_version, new_policy_version
     FROM job_score_staleness
     WHERE tenant_id = ? AND resolved = 0
       ${selectedWhere}
     ORDER BY marked_at ASC${limit > 0 ? " LIMIT ?" : ""}`,
    [LOCAL_TENANT, ...jobIdsFilter, ...(limit > 0 ? [limit] : [])],
  );
  const now = new Date().toISOString();
  const jobKeys = rows.map((row) => String(row.job_id ?? "")).filter(Boolean);
  for (const row of rows) {
    const tenantId = String(row.tenant_id ?? "");
    const jobId = String(row.job_id ?? "");
    if (!tenantId || !jobId) {
      continue;
    }
    upsertStageStateById(db, tenantId, jobId, "score", "pending", {
      attemptCount: 0,
      clearTiming: true,
      skipValidation: true,
    });
    db.prepare(
      `UPDATE job_score_staleness
          SET resolved = 1,
              resolved_at = ?
        WHERE tenant_id = ?
          AND job_id = ?
          AND stale_reason = ?
          AND old_policy_version = ?
          AND new_policy_version = ?`,
    ).run(
      now,
      tenantId,
      jobId,
      String(row.stale_reason ?? ""),
      Number(row.old_policy_version ?? 0),
      Number(row.new_policy_version ?? 0),
    );
    recordActionEventById(db, {
      tenantId,
      jobId,
      stage: "score",
      eventType: "ScoreRescoreRequested",
      level: "info",
      message: "Stale score reset for explicit rescore.",
      payload: {
        staleReason: String(row.stale_reason ?? ""),
        oldPolicyVersion: Number(row.old_policy_version ?? 0),
        newPolicyVersion: Number(row.new_policy_version ?? 0),
        nextAction: "jobctrl run score --rescore",
      },
    });
  }
  return {
    ok: true,
    count: jobKeys.length,
    jobKeys,
    nextAction: "jobctrl run score --rescore",
  };
}

export function softDeleteJob(db: SqliteDatabase, jobKey: string, request: DeleteJobRequest = {}): JobMutationResponse {
  return softDeleteJobs(db, { allMatching: false, jobKeys: [jobKey], reason: request.reason });
}

export function softDeleteJobs(db: SqliteDatabase, request: BulkJobMutationRequest): JobMutationResponse {
  const deletedAt = new Date().toISOString();
  const jobs = mutableResolvedJobs(db, request);
  const statement = db.prepare(`
    INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at, reason, restored_at)
    VALUES ('local', ?, ?, ?, NULL)
    ON CONFLICT(tenant_id, job_id) DO UPDATE SET
      deleted_at = excluded.deleted_at,
      reason = excluded.reason,
      restored_at = NULL
  `);
  const transaction = db.transaction((resolvedJobs: readonly ResolvedJobIdentity[]) => {
    for (const job of resolvedJobs) {
      statement.run(job.jobId, deletedAt, request.reason ?? null);
      recordActionEventById(db, {
        tenantId: LOCAL_TENANT,
        jobId: job.jobId,
        stage: currentMutableStageById(db, LOCAL_TENANT, job.jobId),
        eventType: "JobDeleted",
        level: "info",
        message: "Job soft-deleted from the local API.",
        payload: { reason: request.reason ?? "" },
      });
    }
  });
  transaction(jobs);
  return { ok: true, count: jobs.length, jobKeys: jobs.map((job) => job.jobId) };
}

export function restoreJob(db: SqliteDatabase, jobKey: string): JobMutationResponse {
  return restoreJobs(db, { allMatching: false, jobKeys: [jobKey] });
}

export function restoreJobs(db: SqliteDatabase, request: BulkJobMutationRequest): JobMutationResponse {
  const restoredAt = new Date().toISOString();
  const jobs = mutableResolvedJobs(db, request);
  const statement = db.prepare(
    `UPDATE jobctrl_deleted_jobs
        SET restored_at = ?
      WHERE tenant_id = 'local'
        AND job_id = ?
        AND (restored_at IS NULL OR julianday(restored_at) <= julianday(deleted_at))`,
  );
  const transaction = db.transaction((resolvedJobs: readonly ResolvedJobIdentity[]) => {
    for (const job of resolvedJobs) {
      statement.run(restoredAt, job.jobId);
      recordActionEventById(db, {
        tenantId: LOCAL_TENANT,
        jobId: job.jobId,
        stage: currentMutableStageById(db, LOCAL_TENANT, job.jobId),
        eventType: "JobRestored",
        level: "info",
        message: "Job restored from deleted jobs.",
        payload: {},
      });
    }
  });
  transaction(jobs);
  return { ok: true, count: jobs.length, jobKeys: jobs.map((job) => job.jobId) };
}

export function hideJob(db: SqliteDatabase, jobKey: string, request: DeleteJobRequest = {}): JobMutationResponse {
  return hideJobs(db, { allMatching: false, jobKeys: [jobKey], reason: request.reason });
}

export function hideJobs(db: SqliteDatabase, request: BulkJobMutationRequest): JobMutationResponse {
  const hiddenAt = new Date().toISOString();
  const jobs = mutableResolvedJobs(db, request);
  const statement = db.prepare(`
    INSERT INTO jobctrl_hidden_jobs (tenant_id, job_id, hidden_at, reason, unhidden_at)
    VALUES ('local', ?, ?, ?, NULL)
    ON CONFLICT(tenant_id, job_id) DO UPDATE SET
      hidden_at = excluded.hidden_at,
      reason = excluded.reason,
      unhidden_at = NULL
  `);
  const transaction = db.transaction((resolvedJobs: readonly ResolvedJobIdentity[]) => {
    for (const job of resolvedJobs) {
      statement.run(job.jobId, hiddenAt, request.reason ?? null);
      recordActionEventById(db, {
        tenantId: LOCAL_TENANT,
        jobId: job.jobId,
        stage: currentMutableStageById(db, LOCAL_TENANT, job.jobId),
        eventType: "JobHidden",
        level: "info",
        message: "Job hidden from the local API.",
        payload: { reason: request.reason ?? "" },
      });
    }
  });
  transaction(jobs);
  return { ok: true, count: jobs.length, jobKeys: jobs.map((job) => job.jobId) };
}

export function unhideJob(db: SqliteDatabase, jobKey: string): JobMutationResponse {
  return unhideJobs(db, { allMatching: false, jobKeys: [jobKey] });
}

export function unhideJobs(db: SqliteDatabase, request: BulkJobMutationRequest): JobMutationResponse {
  const unhiddenAt = new Date().toISOString();
  const jobs = mutableResolvedJobs(db, request);
  const statement = db.prepare(
    "UPDATE jobctrl_hidden_jobs SET unhidden_at = ? WHERE tenant_id = 'local' AND job_id = ? AND unhidden_at IS NULL",
  );
  const transaction = db.transaction((resolvedJobs: readonly ResolvedJobIdentity[]) => {
    for (const job of resolvedJobs) {
      statement.run(unhiddenAt, job.jobId);
      recordActionEventById(db, {
        tenantId: LOCAL_TENANT,
        jobId: job.jobId,
        stage: currentMutableStageById(db, LOCAL_TENANT, job.jobId),
        eventType: "JobUnhidden",
        level: "info",
        message: "Job unhidden from hidden jobs.",
        payload: {},
      });
    }
  });
  transaction(jobs);
  return { ok: true, count: jobs.length, jobKeys: jobs.map((job) => job.jobId) };
}

export function permanentlyDeleteJob(db: SqliteDatabase, jobKey: string): JobMutationResponse {
  return permanentlyDeleteJobs(db, { allMatching: false, jobKeys: [jobKey] });
}

export function permanentlyDeleteJobs(db: SqliteDatabase, request: BulkJobMutationRequest): JobMutationResponse {
  const tenantId = LOCAL_TENANT;
  const jobs = mutableResolvedJobs(db, request);
  // The v7 schema deliberately delegates deletion of the job-owned graph to
  // its foreign-key cascades. This command is also callable without the API
  // connection wrapper, so enable the constraint engine at the command
  // boundary before starting the transaction.
  db.pragma("foreign_keys = ON");
  if (db.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new Error("Permanent delete requires SQLite foreign-key enforcement.");
  }
  const transaction = db.transaction((resolvedJobs: readonly ResolvedJobIdentity[]) => {
    for (const job of resolvedJobs) {
      purgeJobRows(db, tenantId, job.jobId);
    }
    invalidateOperationsProjections(db, tenantId);
  });
  transaction(jobs);
  return { ok: true, count: jobs.length, jobKeys: jobs.map((job) => job.jobId) };
}

export function writeSettingsConfig(
  paths: { configPath: string },
  request: SettingsUpdateRequest,
): SettingsResponse {
  updateConfigObject(paths.configPath, (next) => {
    let wrote = false;
    const assign = (key: string, value: unknown) => {
      next[key] = value;
      wrote = true;
    };

    if (request.applyConcurrency !== undefined) assign("apply_concurrency", request.applyConcurrency);
    if (request.workerActivitySlots !== undefined) assign("worker_activity_slots", request.workerActivitySlots);
    if (request.dailyBudgetUsd !== undefined) assign("daily_budget_usd", request.dailyBudgetUsd);
    if (request.analysisLegs !== undefined) assign("analysis_legs", request.analysisLegs);
    if (request.tailoringGeneratorModels !== undefined) assign("tailoring_generator_models", request.tailoringGeneratorModels);
    if (request.tailoringJudgeModel !== undefined) assign("tailoring_judge_model", request.tailoringJudgeModel);
    if (request.tailoringJudgeMinScore !== undefined) assign("tailoring_judge_min_score", request.tailoringJudgeMinScore);
    if (request.applyMaxBudgetUsd !== undefined) assign("apply_max_budget_usd", request.applyMaxBudgetUsd);
    if (request.applyTimeoutSeconds !== undefined) assign("apply_timeout_seconds", request.applyTimeoutSeconds);
    if (request.scoreCriteria !== undefined) assign("score_criteria", request.scoreCriteria);
    if (request.targetCriteria !== undefined) assign("target_criteria", request.targetCriteria);
    if (request.preferredModels !== undefined) {
      const rawCurrent = isRecord(next.preferred_models) ? next.preferred_models : {};
      const preferredModels: Record<string, string> = {};
      for (const provider of ["codex", "claude", "google"] as const) {
        const current = rawCurrent[provider];
        if (typeof current === "string" && current.trim() && current.trim().length <= 160) {
          preferredModels[provider] = current.trim();
        }
        const update = request.preferredModels[provider];
        if (update === null) delete preferredModels[provider];
        else if (update !== undefined) preferredModels[provider] = update;
      }
      assign("preferred_models", preferredModels);
    }

    if (!wrote) throw new InputError("At least one settings field is required.");
  });
  return readSettingsConfig(paths);
}

/**
 * Phase 7 (S-26 round-1 review B2): reset the ``job_enrichments`` row
 * for one job back to the ``pending`` lifecycle state.
 *
 * Mirror of Python's ``state.py::_reset_enrichment_aggregate`` — both
 * paths (CLI ``jobctrl retry enrich URL`` and API
 * ``POST /v1/jobs/{key}/retry?stage=enrich``) MUST clear the
 * aggregate's terminal-state fields, otherwise the worker's
 * ``_ENRICHMENT_PENDING`` predicate excludes the row and retry is a
 * silent no-op.
 *
 * The reset preserves the attempt history (audit trail intact) and
 * only clears the success-side fields plus rolls ``current_status``
 * back to ``pending``. Idempotent — safe to call when no row exists.
 */
function resetEnrichmentAggregate(db: SqliteDatabase, tenantId: string, jobId: string): void {
  if (!tableExists(db, "job_enrichments")) {
    return;
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE job_enrichments
       SET current_status = 'pending',
           full_description = NULL,
           application_url = NULL,
           enriched_at = NULL,
           extraction_tier = NULL,
           updated_at = ?
     WHERE tenant_id = ? AND job_id = ?`,
  ).run(now, tenantId, jobId);
}

function mutableJobKeys(db: SqliteDatabase, request: BulkJobMutationRequest): string[] {
  if (request.allMatching) {
    return uniqueJobKeys(matchingJobKeys(db, request.filter ?? {}));
  }
  return uniqueJobKeys(request.jobKeys)
    .map((jobKey) => resolveJobUrl(db, jobKey))
    .filter((jobUrl): jobUrl is string => Boolean(jobUrl));
}

function mutableResolvedJobs(db: SqliteDatabase, request: BulkJobMutationRequest): ResolvedJobIdentity[] {
  const locators = request.allMatching ? matchingJobKeys(db, request.filter ?? {}) : request.jobKeys;
  return uniqueJobKeys(locators)
    .map((locator) => resolveJobIdentity(db, LOCAL_TENANT, locator))
    .filter((job): job is ResolvedJobIdentity => Boolean(job));
}

function uniqueJobKeys(jobKeys: string[]): string[] {
  return Array.from(new Set(jobKeys.map((jobKey) => jobKey.trim()).filter(Boolean)));
}

function purgeJobRows(db: SqliteDatabase, tenantId: string, jobId: string): void {
  const locatorValues = jobLocatorValues(db, tenantId, jobId);
  const repeatOverrideIds = affectedRepeatOverrideIds(db, tenantId, jobId);

  detachIndependentJobEvents(db, tenantId, jobId);
  detachIndependentJobReferences(db, tenantId, jobId);
  purgeRepeatApplicationEdges(db, tenantId, jobId, repeatOverrideIds);

  // These tables deliberately do not have job foreign keys because they are
  // rebuildable projections. Apply/artifact projections are job-scoped and
  // must disappear with the permanent-delete boundary.
  for (const tableName of [
    "apply_run_projections",
    "artifact_list_projections",
    "job_detail_projections",
    "job_list_projections",
  ]) {
    deleteExactV7Rows(db, tableName, "tenant_id = ? AND job_id = ?", [tenantId, jobId]);
  }

  // A link can retain the deleted aggregate as a non-FK superseded target.
  // Remove both forms so a later observation is not suppressed as a duplicate.
  deleteExactV7Rows(
    db,
    "job_duplicate_links",
    "tenant_id = ? AND (surviving_job_id = ? OR superseded_job_or_observation_id = ?)",
    [tenantId, jobId, jobId],
  );
  for (const locatorValue of locatorValues) {
    deleteExactV7Rows(
      db,
      "job_rejected_duplicate_links",
      "tenant_id = ? AND candidate_url = ?",
      [tenantId, locatorValue],
    );
  }

  // The root deletion clears locators, delete/hide tombstones, events, and
  // every job-owned child through the exact-v7 ON DELETE CASCADE graph.
  deleteExactV7Rows(db, "jobs", "tenant_id = ? AND job_id = ?", [tenantId, jobId]);
}

function jobLocatorValues(db: SqliteDatabase, tenantId: string, jobId: string): string[] {
  const values = new Set<string>();
  const job = getRow<{ url: string | null; application_url: string | null }>(
    db,
    "SELECT url, application_url FROM jobs WHERE tenant_id = ? AND job_id = ?",
    [tenantId, jobId],
  );
  for (const value of [job?.url, job?.application_url]) {
    if (value?.trim()) values.add(value);
  }
  for (const row of allRows<{ locator_value: string }>(
    db,
    "SELECT locator_value FROM job_locators WHERE tenant_id = ? AND job_id = ?",
    [tenantId, jobId],
  )) {
    if (row.locator_value.trim()) values.add(row.locator_value);
  }
  for (const row of allRows<{ canonical_url: string }>(
    db,
    "SELECT canonical_url FROM job_canonical_identities WHERE tenant_id = ? AND job_id = ?",
    [tenantId, jobId],
  )) {
    if (row.canonical_url.trim()) values.add(row.canonical_url);
  }
  for (const row of allRows<{ observed_url: string; normalized_observed_url: string }>(
    db,
    `SELECT observed_url, normalized_observed_url
       FROM job_source_observations
      WHERE tenant_id = ? AND job_id = ?`,
    [tenantId, jobId],
  )) {
    if (row.observed_url.trim()) values.add(row.observed_url);
    if (row.normalized_observed_url.trim()) values.add(row.normalized_observed_url);
  }
  return [...values];
}

function affectedRepeatOverrideIds(db: SqliteDatabase, tenantId: string, jobId: string): string[] {
  return allRows<{ override_id: string }>(
    db,
    `SELECT override_id
       FROM application_repeat_overrides
      WHERE tenant_id = ? AND (target_job_id = ? OR prior_job_id = ?)`,
    [tenantId, jobId, jobId],
  ).map((row) => row.override_id);
}

function purgeRepeatApplicationEdges(
  db: SqliteDatabase,
  tenantId: string,
  jobId: string,
  overrideIds: string[],
): void {
  // A repeat override is a cross-job decision. Its consumption table has no
  // foreign key, so capture the affected override ids before the root's
  // cascade removes the overrides themselves.
  for (const overrideId of overrideIds) {
    deleteExactV7Rows(
      db,
      "application_repeat_override_consumptions",
      "tenant_id = ? AND override_id = ?",
      [tenantId, overrideId],
    );
    deleteExactV7Rows(
      db,
      "application_repeat_audit",
      "tenant_id = ? AND override_id = ?",
      [tenantId, overrideId],
    );
  }
  // Audit rows may reference the deleted Job as a prior match only in their
  // evidence payload, while retaining a different target Job aggregate. Parse
  // the JSON and match exact scalar values: substring search could erase an
  // unrelated user note that merely happens to contain the same text.
  for (const auditId of repeatAuditIdsReferencingJob(db, tenantId, jobId)) {
    deleteExactV7Rows(db, "application_repeat_audit", "tenant_id = ? AND audit_id = ?", [tenantId, auditId]);
  }
}

function repeatAuditIdsReferencingJob(db: SqliteDatabase, tenantId: string, jobId: string): string[] {
  return allRows<{ audit_id: string; target_job_id: string; evidence_json: string }>(
    db,
    `SELECT audit_id, target_job_id, evidence_json
       FROM application_repeat_audit
      WHERE tenant_id = ?`,
    [tenantId],
  )
    .filter((row) => row.target_job_id === jobId || repeatAuditEvidenceReferencesPriorJob(row.evidence_json, jobId))
    .map((row) => row.audit_id);
}

function repeatAuditEvidenceReferencesPriorJob(json: string, expectedJobId: string): boolean {
  try {
    const matches = JSON.parse(json) as unknown;
    return Array.isArray(matches) && matches.some((match) => priorApplicationJobId(match) === expectedJobId);
  } catch {
    return false;
  }
}

function priorApplicationJobId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const priorApplication = (value as Record<string, unknown>).priorApplication;
  if (!priorApplication || typeof priorApplication !== "object" || Array.isArray(priorApplication)) return null;
  const jobId = (priorApplication as Record<string, unknown>).jobId;
  return typeof jobId === "string" ? jobId : null;
}

function detachIndependentJobEvents(db: SqliteDatabase, tenantId: string, jobId: string): void {
  const events = allRows<{ event_id: number; payload_json: string | null }>(
    db,
    `SELECT event_id, payload_json
       FROM job_events
      WHERE tenant_id = ?
        AND job_id = ?
        AND entity_kind IN ('contact', 'contact_research', 'outreach')`,
    [tenantId, jobId],
  );
  const update = db.prepare(
    `UPDATE job_events
        SET job_id = NULL, payload_json = ?
      WHERE tenant_id = ?
        AND event_id = ?
        AND entity_kind IN ('contact', 'contact_research', 'outreach')`,
  );
  for (const event of events) {
    update.run(scrubTopLevelEventJobId(event.payload_json, jobId), tenantId, event.event_id);
  }
}

function scrubTopLevelEventJobId(payloadJson: string | null, jobId: string): string | null {
  if (!payloadJson) return payloadJson;
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payloadJson;
    const values = payload as Record<string, unknown>;
    if (values.jobId !== jobId) return payloadJson;
    const { jobId: _jobId, ...withoutJobId } = values;
    return JSON.stringify(withoutJobId);
  } catch {
    return payloadJson;
  }
}

function detachIndependentJobReferences(db: SqliteDatabase, tenantId: string, jobId: string): void {
  // Contact, research, outreach, and operational records own their own
  // lifecycles. Their nullable job reference is deliberately RESTRICT rather
  // than a job-owned cascade: permanent deletion removes the Job aggregate,
  // not user-entered contact history or operational evidence.
  for (const tableName of [
    "contacts",
    "contact_research_tasks",
    "outreach_threads",
    "operational_attempt_metrics",
    "contact_projections",
    "contact_research_task_projections",
    "outreach_thread_projections",
    "due_follow_up_projections",
  ]) {
    updateExactV7Rows(db, tableName, "job_id = NULL", "tenant_id = ? AND job_id = ?", [tenantId, jobId]);
  }
}

function invalidateOperationsProjections(db: SqliteDatabase, tenantId: string): void {
  // Target rows were removed before the root deletion. Rebuild the two
  // tenant-wide projections synchronously instead of resetting the shared
  // event watermark and replaying unrelated tenants' event histories.
  rebuildTenantDeleteProjections(db, tenantId);
}

function deleteExactV7Rows(db: SqliteDatabase, tableName: string, whereSql: string, params: SqliteValue[]): void {
  db.prepare(`DELETE FROM ${tableName} WHERE ${whereSql}`).run(...params);
}

function updateExactV7Rows(
  db: SqliteDatabase,
  tableName: string,
  setSql: string,
  whereSql: string,
  params: SqliteValue[],
): void {
  db.prepare(`UPDATE ${tableName} SET ${setSql} WHERE ${whereSql}`).run(...params);
}

function ensureJobScoresTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_scores (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      fit_score INTEGER NOT NULL CHECK(fit_score BETWEEN 1 AND 10),
      breakdown_json TEXT NOT NULL,
      keywords_json TEXT NOT NULL,
      scored_at TEXT NOT NULL,
      correction_json TEXT,
      criteria_json TEXT NOT NULL DEFAULT '{}',
      trace_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (tenant_id, job_id, version),
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    )
  `);
}

function ensureScoreStalenessTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_score_staleness (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      stale_reason TEXT NOT NULL,
      old_policy_id TEXT NOT NULL DEFAULT '',
      old_policy_version INTEGER NOT NULL,
      new_policy_id TEXT NOT NULL DEFAULT '',
      new_policy_version INTEGER NOT NULL,
      marked_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      resolved_by_score_version INTEGER,
      PRIMARY KEY (
        tenant_id, job_id, stale_reason,
        old_policy_version, new_policy_version
      ),
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_score_staleness_unresolved
    ON job_score_staleness(tenant_id, resolved, marked_at DESC)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_score_staleness_job
    ON job_score_staleness(tenant_id, job_id, resolved)
  `);
}

function ensureScoringPoliciesTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scoring_policies (
      tenant_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      rubric_json TEXT NOT NULL,
      anchors_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      created_from_event_id INTEGER,
      PRIMARY KEY (tenant_id, version)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scoring_policies_current
    ON scoring_policies(tenant_id, version DESC)
  `);
}

function persistScoringPolicyCorrection(
  db: SqliteDatabase,
  input: {
    tenantId: string;
    jobId: string;
    latest: Record<string, unknown>;
    correctedScore: number;
    correctedAt: string;
  },
): { previousPolicyVersion: number; newPolicyVersion: number } {
  ensureScoringPoliciesTable(db);
  const current = getCurrentScoringPolicyRow(db, input.tenantId, input.correctedAt);
  const previousTrace = parseObjectOrDefault(String(input.latest.trace_json ?? "{}"));
  const previousBreakdown = parseObjectOrDefault(String(input.latest.breakdown_json ?? "{}"));
  const originalScore = Number(input.latest.fit_score ?? 0);
  const correctionDelta = input.correctedScore - originalScore;
  const anchor = sanitizePolicyAnchor({
    anchor_id: correctionAnchorId({
      tenant_id: input.tenantId,
      job_id: input.jobId,
      original_score: originalScore,
      corrected_score: input.correctedScore,
      corrected_at: input.correctedAt,
      source_policy_version: Number(previousTrace.scoring_policy_version ?? 0),
    }),
    job_ref_hash: policyAnchorJobRefHash(input.tenantId, input.jobId),
    fit_score: input.correctedScore,
    original_fit_score: originalScore,
    corrected_fit_score: input.correctedScore,
    correction_delta: correctionDelta,
    correction_direction: correctionDirection(correctionDelta),
    dimensions: extractDimensionNames(previousTrace, previousBreakdown),
    dimension_scores: extractDimensionScores(previousTrace, previousBreakdown),
    evidence_summary: extractPolicyEvidence(previousTrace, previousBreakdown),
    source_policy_id: String(previousTrace.scoring_policy_id ?? ""),
    source_policy_version: Number(previousTrace.scoring_policy_version ?? 0),
    created_at: input.correctedAt,
  });
  const anchors = upsertAnchor(parseAnchorList(current.anchors_json), anchor);
  db.prepare(
    `INSERT INTO scoring_policies (
       tenant_id, version, rubric_json, anchors_json, created_at, created_from_event_id
     ) VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(
    input.tenantId,
    Number(current.version) + 1,
    current.rubric_json,
    JSON.stringify(anchors),
    input.correctedAt,
  );
  return {
    previousPolicyVersion: Number(current.version),
    newPolicyVersion: Number(current.version) + 1,
  };
}

function markComparableScoresStale(
  db: SqliteDatabase,
  input: {
    tenantId: string;
    correctedJobId: string;
    markedAt: string;
    newPolicyId: string;
    newPolicyVersion: number;
  },
): void {
  ensureScoreStalenessTable(db);
  const latestRows = allRows<Record<string, unknown>>(
    db,
    `SELECT s.job_id, s.trace_json
     FROM job_scores s
     INNER JOIN (
       SELECT tenant_id, job_id, MAX(version) AS max_version
       FROM job_scores
       WHERE tenant_id = ?
       GROUP BY tenant_id, job_id
     ) latest
       ON latest.tenant_id = s.tenant_id
      AND latest.job_id = s.job_id
      AND latest.max_version = s.version
     WHERE s.tenant_id = ?
       AND (s.correction_json IS NULL OR TRIM(s.correction_json) = '')`,
    [input.tenantId, input.tenantId],
  );
  for (const row of latestRows) {
    const jobId = String(row.job_id ?? "");
    if (!jobId || jobId === input.correctedJobId) {
      continue;
    }
    const trace = parseObjectOrDefault(String(row.trace_json ?? "{}"));
    const oldPolicyVersion = numberOrDefault(trace.scoring_policy_version, 0);
    if (oldPolicyVersion >= input.newPolicyVersion) {
      continue;
    }
    const staleReason = "scoring_policy_changed";
    const oldPolicyId = String(trace.scoring_policy_id ?? "");
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO job_score_staleness (
           tenant_id, job_id, stale_reason,
           old_policy_id, old_policy_version,
           new_policy_id, new_policy_version,
           marked_at, resolved, resolved_at, resolved_by_score_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`,
      )
      .run(
        input.tenantId,
        jobId,
        staleReason,
        oldPolicyId,
        oldPolicyVersion,
        input.newPolicyId,
        input.newPolicyVersion,
        input.markedAt,
      );
    if (result.changes <= 0) {
      continue;
    }
    markScoreStageStale(db, input.tenantId, jobId, {
      staleReason,
      oldPolicyId,
      oldPolicyVersion,
      newPolicyId: input.newPolicyId,
      newPolicyVersion: input.newPolicyVersion,
      markedAt: input.markedAt,
    });
  }
}

function markScoreStageStale(
  db: SqliteDatabase,
  tenantId: string,
  jobId: string,
  marker: {
    staleReason: string;
    oldPolicyId: string;
    oldPolicyVersion: number;
    newPolicyId: string;
    newPolicyVersion: number;
    markedAt: string;
  },
): void {
  const current = getRow<{ state?: string }>(
    db,
    "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'score'",
    [tenantId, jobId],
  );
  if (!current || current.state === "succeeded") {
    upsertStageStateById(db, tenantId, jobId, "score", "stale");
  }
  recordActionEventById(db, {
    tenantId,
    jobId,
    stage: "score",
    eventType: "ScoreMarkedStale",
    level: "info",
    message: "Score marked stale after scoring policy changed.",
    payload: {
      staleReason: marker.staleReason,
      oldPolicyId: marker.oldPolicyId,
      oldPolicyVersion: marker.oldPolicyVersion,
      newPolicyId: marker.newPolicyId,
      newPolicyVersion: marker.newPolicyVersion,
      markedAt: marker.markedAt,
    },
  });
}

function getCurrentScoringPolicyRow(
  db: SqliteDatabase,
  tenantId: string,
  createdAt: string,
): {
  version: number;
  rubric_json: string;
  anchors_json: string;
} {
  const latest = getRow<{
    version: number;
    rubric_json: string;
    anchors_json: string;
  }>(
    db,
    `SELECT version, rubric_json, anchors_json
     FROM scoring_policies
     WHERE tenant_id = ?
     ORDER BY version DESC
     LIMIT 1`,
    [tenantId],
  );
  if (latest) {
    return {
      version: Number(latest.version),
      rubric_json: normalizeRubricJson(latest.rubric_json),
      anchors_json: latest.anchors_json || "[]",
    };
  }
  const rubricJson = JSON.stringify(defaultScoringRubric());
  db.prepare(
    `INSERT INTO scoring_policies (
       tenant_id, version, rubric_json, anchors_json, created_at, created_from_event_id
     ) VALUES (?, 1, ?, '[]', ?, NULL)`,
  ).run(tenantId, rubricJson, createdAt);
  return { version: 1, rubric_json: rubricJson, anchors_json: "[]" };
}

function appendCorrectionHistory(
  rawTrace: unknown,
  correction: Record<string, unknown>,
): Record<string, unknown> {
  const trace = parseObjectOrDefault(String(rawTrace ?? "{}"));
  const history = Array.isArray(trace.correction_history) ? trace.correction_history : [];
  return {
    ...trace,
    correction_history: [...history.filter(isRecord), correction],
  };
}

function parseObjectOrDefault(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function defaultScoringRubric(): Record<string, unknown> {
  return {
    rubric_version: DEFAULT_SCORING_RUBRIC_VERSION,
    dimensions: [...DEFAULT_SCORING_DIMENSIONS],
    fit_band_thresholds: [...DEFAULT_FIT_BAND_THRESHOLDS],
    rounding: "nearest_integer_half_up",
    fit_score_range: [1, 10],
    confidence_handling: "trace_only",
    eligibility_handling: "trace_only",
  };
}

function normalizeRubricJson(raw: unknown): string {
  const text = String(raw ?? "");
  if (!text) {
    return JSON.stringify(defaultScoringRubric());
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? JSON.stringify(parsed) : JSON.stringify(defaultScoringRubric());
  } catch {
    return JSON.stringify(defaultScoringRubric());
  }
}

function parseAnchorList(raw: unknown): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter(isRecord).map(sanitizePolicyAnchor) : [];
  } catch {
    return [];
  }
}

function upsertAnchor(
  anchors: Record<string, unknown>[],
  anchor: Record<string, unknown>,
): Record<string, unknown>[] {
  const anchorId = String(anchor.anchor_id ?? "");
  let replaced = false;
  const next = anchors.map((existing) => {
    if (String(existing.anchor_id ?? "") !== anchorId) {
      return existing;
    }
    replaced = true;
    return anchor;
  });
  return replaced ? next : [...next, anchor];
}

function correctionAnchorId(payload: Record<string, unknown>): string {
  const digest = stablePolicyHash(payload).slice(0, 12);
  return `correction-anchor-${digest}`;
}

function policyAnchorJobRefHash(tenantId: string, jobId: string): string {
  return `sha256:${stablePolicyHash({ tenant_id: tenantId, job_id: jobId })}`;
}

function stablePolicyHash(payload: Record<string, unknown>): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest("hex");
}

function correctionDirection(delta: number): "increased" | "decreased" | "unchanged" {
  if (delta > 0) {
    return "increased";
  }
  if (delta < 0) {
    return "decreased";
  }
  return "unchanged";
}

function sanitizePolicyAnchor(anchor: Record<string, unknown>): Record<string, unknown> {
  const originalScore = numberOrNull(anchor.original_fit_score ?? anchor.originalFitScore ?? anchor.original_score);
  const correctedScore = numberOrNull(
    anchor.corrected_fit_score ?? anchor.correctedFitScore ?? anchor.corrected_score ?? anchor.fit_score ?? anchor.fitScore,
  );
  const delta = numberOrNull(anchor.correction_delta ?? anchor.correctionDelta) ?? (
    originalScore === null || correctedScore === null ? 0 : correctedScore - originalScore
  );
  const jobRefHash = String(anchor.job_ref_hash ?? anchor.jobRefHash ?? "").trim()
    || legacyPolicyAnchorJobRefHash(String(anchor.job_id ?? anchor.jobId ?? "").trim());
  return {
    anchor_id: String(anchor.anchor_id ?? anchor.anchorId ?? ""),
    ...(jobRefHash ? { job_ref_hash: jobRefHash } : {}),
    fit_score: numberOrNull(anchor.fit_score ?? anchor.fitScore),
    original_fit_score: originalScore,
    corrected_fit_score: correctedScore,
    correction_delta: delta,
    correction_direction: correctionDirection(delta),
    dimensions: anchorDimensions(anchor),
    dimension_scores: sanitizeAnchorDimensionScores(anchor.dimension_scores ?? anchor.dimensionScores),
    evidence_summary: sanitizeAnchorEvidence(anchor.evidence_summary ?? anchor.evidenceSummary),
    source_policy_id: String(anchor.source_policy_id ?? anchor.sourcePolicyId ?? ""),
    source_policy_version: numberOrNull(anchor.source_policy_version ?? anchor.sourcePolicyVersion) ?? 0,
    created_at: String(anchor.created_at ?? anchor.createdAt ?? ""),
  };
}

function legacyPolicyAnchorJobRefHash(jobUrl: string): string {
  return jobUrl ? `sha256:${stablePolicyHash({ tenant_id: "", job_id: jobUrl })}` : "";
}

function extractDimensionScores(
  trace: Record<string, unknown>,
  breakdown: Record<string, unknown>,
): Record<string, unknown>[] {
  if (Array.isArray(trace.resolved_dimensions)) {
    const dimensions = trace.resolved_dimensions.filter(isRecord).map(cleanJsonRecord);
    if (dimensions.length) {
      return dimensions;
    }
  }
  return ["technical_fit", "experience_fit", "role_fit"].map((name) => ({
    name,
    value: Number(breakdown[name] ?? 0),
  }));
}

function extractDimensionNames(
  trace: Record<string, unknown>,
  breakdown: Record<string, unknown>,
): string[] {
  return extractDimensionScores(trace, breakdown)
    .map((dimension) => String(dimension.name ?? "").trim())
    .filter((name) => name.length > 0);
}

function extractPolicyEvidence(
  trace: Record<string, unknown>,
  breakdown: Record<string, unknown>,
): Record<string, unknown> {
  if (isRecord(trace.policy_evidence)) {
    return sanitizeAnchorEvidence(trace.policy_evidence);
  }
  const eligibility = isRecord(breakdown.eligibility) ? breakdown.eligibility : {};
  return sanitizeAnchorEvidence({
    confidence: String(breakdown.confidence ?? "medium"),
    eligibility_status: String(eligibility.status ?? "unknown"),
    hard_blocker_count: Array.isArray(eligibility.hard_blockers) ? eligibility.hard_blockers.length : 0,
    warning_count: Array.isArray(eligibility.warnings) ? eligibility.warnings.length : 0,
    matched_signal_count: Array.isArray(breakdown.matched_signals) ? breakdown.matched_signals.length : 0,
    missing_signal_count: Array.isArray(breakdown.missing_signals) ? breakdown.missing_signals.length : 0,
    transferable_signal_count: Array.isArray(breakdown.transferable_signals)
      ? breakdown.transferable_signals.length
      : 0,
  });
}

function anchorDimensions(anchor: Record<string, unknown>): string[] {
  if (Array.isArray(anchor.dimensions)) {
    return anchor.dimensions.map((value) => String(value).trim()).filter((value) => value.length > 0);
  }
  return sanitizeAnchorDimensionScores(anchor.dimension_scores ?? anchor.dimensionScores)
    .map((dimension) => String(dimension.name ?? "").trim())
    .filter((name) => name.length > 0);
}

function sanitizeAnchorDimensionScores(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((dimension) => {
    const cleaned: Record<string, unknown> = {};
    const name = String(dimension.name ?? "").trim();
    if (name) {
      cleaned.name = name;
    }
    for (const key of ["value", "weight", "weighted_value"] as const) {
      const number = numberOrNull(dimension[key]);
      if (number !== null) {
        cleaned[key] = number;
      }
    }
    return cleaned;
  }).filter((dimension) => Object.keys(dimension).length > 0);
}

function sanitizeAnchorEvidence(value: unknown): Record<string, unknown> {
  const raw = isRecord(value) ? value : {};
  const cleaned: Record<string, unknown> = {};
  const confidence = String(raw.confidence ?? "").trim().toLowerCase();
  if (["low", "medium", "high"].includes(confidence)) {
    cleaned.confidence = confidence;
  }
  const eligibilityStatus = String(raw.eligibility_status ?? raw.eligibilityStatus ?? "").trim().toLowerCase();
  if (["eligible", "warning", "blocked", "unknown"].includes(eligibilityStatus)) {
    cleaned.eligibility_status = eligibilityStatus;
  }
  for (const key of [
    "hard_blocker_count",
    "warning_count",
    "matched_signal_count",
    "missing_signal_count",
    "transferable_signal_count",
  ] as const) {
    const number = numberOrNull(raw[key]);
    if (number !== null) {
      cleaned[key] = Math.max(Math.trunc(number), 0);
    }
  }
  return cleaned;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean" || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return number;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return numberOrNull(value) ?? fallback;
}

function cleanJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * Upsert one row into `job_stage_states`, gated by the §8.5 state machine.
 *
 * §8.5 enforcement is **default-on** via `validateStageTransition`.  The
 * only callers that legitimately bypass the gate are the four admin-override
 * commands in this file:
 *
 *   - `resetJobStage`        — user retry, mirrors Python `reset_job_stage`
 *   - `markJobApplied`       — user assertion "I applied externally"
 *   - `markJobSkipped`       — user assertion "skip this one"
 *   - `resetStaleScoresForRescore` — explicit stale-score rescore request
 *
 * **Automated pipeline writes (Phase 9 / S-34 onward) MUST NOT pass
 * `skipValidation`.**  If you're adding a new TS write path and you can't
 * justify it as one of the four admin overrides above, leave the option
 * unset and let the gate enforce §8.5.
 */
function upsertStageState(
  db: SqliteDatabase,
  jobUrl: string,
  stage: Stage,
  state: StageState,
  options: {
    attemptCount?: number;
    clearTiming?: boolean;
    finishedAt?: string;
    retryable?: boolean;
    /**
     * S-12: skip the §8.5 validation gate. Admin overrides (manual
     * mark-applied, mark-skipped, reset) set this to mirror
     * Python's `set_stage_state(... validate_transition=False)` —
     * see `state.py::reset_job_stage`. Automated/normal writes leave
     * this `false` (default) and pay the cost of the gate.
     */
    skipValidation?: boolean;
  } = {},
): void {
  if (!tableExists(db, "job_stage_states")) {
    return;
  }
  if (!options.skipValidation) {
    validateStageTransition(db, jobUrl, stage, state);
  }
  const columns = columnNames(db, "job_stage_states");
  const now = new Date().toISOString();
  const updates: Record<string, SqliteValue> = {
    state,
    updated_at: now,
    error_code: null,
    error_message: null,
    retryable: options.retryable === false ? 0 : 1,
    blocked_by_json: "[]",
    next_action: null,
  };
  if (options.attemptCount !== undefined) {
    updates.attempt_count = options.attemptCount;
  }
  if (options.clearTiming) {
    updates.started_at = null;
    updates.finished_at = null;
    updates.duration_ms = null;
  }
  if (options.finishedAt) {
    updates.finished_at = options.finishedAt;
  }

  const updateEntries = Object.entries(updates).filter(([name]) => columns.has(name));
  const assignments = updateEntries.map(([name]) => `${name} = ?`).join(", ");
  const result = db.prepare(`UPDATE job_stage_states SET ${assignments} WHERE job_url = ? AND stage = ?`).run(
    ...updateEntries.map(([, value]) => value),
    jobUrl,
    stage,
  );
  if (result.changes > 0) {
    return;
  }

  const insert: Record<string, SqliteValue> = {
    job_url: jobUrl,
    stage,
    state,
    attempt_count: options.attemptCount ?? 0,
    max_attempts: DEFAULT_MAX_ATTEMPTS[stage],
    updated_at: now,
    retryable: options.retryable === false ? 0 : 1,
    blocked_by_json: "[]",
  };
  if (options.finishedAt) {
    insert.finished_at = options.finishedAt;
  }
  const insertEntries = Object.entries(insert).filter(([name]) => columns.has(name));
  db.prepare(
    `INSERT INTO job_stage_states (${insertEntries.map(([name]) => name).join(", ")}) VALUES (${insertEntries
      .map(() => "?")
      .join(", ")})`,
  ).run(...insertEntries.map(([, value]) => value));
}

function getStageState(db: SqliteDatabase, jobUrl: string, stage: Stage): StageSummary {
  if (!tableExists(db, "job_stage_states")) {
    return defaultStage(stage, "pending");
  }
  const row = getRow<Record<string, unknown>>(
    db,
    "SELECT * FROM job_stage_states WHERE job_url = ? AND stage = ? LIMIT 1",
    [jobUrl, stage],
  );
  if (!row) {
    return defaultStage(stage, "pending");
  }
  return {
    stage,
    state: isStageState(row.state) ? row.state : "pending",
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: nullableNumber(row.max_attempts) ?? DEFAULT_MAX_ATTEMPTS[stage],
    startedAt: nullableString(row.started_at),
    updatedAt: nullableString(row.updated_at),
    finishedAt: nullableString(row.finished_at),
    durationMs: nullableNumber(row.duration_ms),
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    retryable: row.retryable === null || row.retryable === undefined ? true : Boolean(row.retryable),
    blockedBy: parseStringArray(nullableString(row.blocked_by_json)),
    nextAction: nullableString(row.next_action),
  };
}

function currentMutableStage(db: SqliteDatabase, jobUrl: string): Stage {
  if (!tableExists(db, "job_stage_states")) {
    return "apply";
  }
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT stage, state FROM job_stage_states WHERE job_url = ? ORDER BY rowid",
    [jobUrl],
  );
  const active = rows.find((row) => ["queued", "running"].includes(String(row.state ?? "")));
  if (active && STAGES.includes(active.stage as Stage)) {
    return active.stage as Stage;
  }
  return "apply";
}

function currentFailedStage(db: SqliteDatabase, jobUrl: string): Stage | null {
  if (!tableExists(db, "job_stage_states")) {
    return null;
  }
  const rows = allRows<{ stage: Stage; state: string; retryable: number | null }>(
    db,
    "SELECT stage, state, retryable FROM job_stage_states WHERE job_url = ?",
    [jobUrl],
  );
  const failedStages = new Set(
    rows
      .filter(
        (row) =>
          STAGES.includes(row.stage) &&
          ["failed", "exhausted"].includes(row.state) &&
          (row.stage === "enrich" ||
            (row.retryable !== 0 &&
              latestStageRetryableOverride(db, jobUrl, row.stage) !== false)),
      )
      .map((row) => row.stage),
  );
  return STAGES.find((stage) => failedStages.has(stage)) ?? null;
}

function latestStageRetryableOverride(
  db: SqliteDatabase,
  jobUrl: string,
  stage: Stage,
): boolean | null {
  if (!tableExists(db, "job_events")) return null;
  const rows = allRows<{ payload_json: string | null }>(
    db,
    `SELECT payload_json
     FROM job_events
     WHERE job_url = ?
       AND stage = ?
       AND payload_json IS NOT NULL
     ORDER BY event_id ASC`,
    [jobUrl, stage],
  );
  let latest: boolean | null = null;
  for (const row of rows) {
    const payload = parseJsonRecord(row.payload_json);
    const retryable = payload?.["retryable"];
    if (typeof retryable === "boolean") {
      latest = retryable;
    }
  }
  return latest;
}

function recordActionEvent(
  db: SqliteDatabase,
  event: {
    jobUrl: string;
    stage: Stage;
    eventType: string;
    level: string;
    message: string;
    payload: Record<string, unknown>;
  },
): void {
  if (!tableExists(db, "job_events")) {
    return;
  }
  const columns = columnNames(db, "job_events");
  const values: Record<string, SqliteValue> = {
    job_url: event.jobUrl,
    stage: event.stage,
    event_type: event.eventType,
    level: event.level,
    message: event.message,
    occurred_at: new Date().toISOString(),
    payload_json: JSON.stringify(event.payload),
  };
  const entries = Object.entries(values).filter(([name]) => columns.has(name));
  db.prepare(
    `INSERT INTO job_events (${entries.map(([name]) => name).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`,
  ).run(...entries.map(([, value]) => value));
}

function upsertStageStateById(
  db: SqliteDatabase,
  tenantId: string,
  jobId: string,
  stage: Stage,
  state: StageState,
  options: {
    attemptCount?: number;
    clearTiming?: boolean;
    finishedAt?: string;
    retryable?: boolean;
    skipValidation?: boolean;
  } = {},
): void {
  if (!options.skipValidation) {
    validateStageTransitionById(db, tenantId, jobId, stage, state);
  }
  const now = new Date().toISOString();
  const updates: Record<string, SqliteValue> = {
    state,
    updated_at: now,
    error_code: null,
    error_message: null,
    retryable: options.retryable === false ? 0 : 1,
    blocked_by_json: "[]",
    next_action: null,
  };
  if (options.attemptCount !== undefined) {
    updates.attempt_count = options.attemptCount;
  }
  if (options.clearTiming) {
    updates.started_at = null;
    updates.finished_at = null;
    updates.duration_ms = null;
  }
  if (options.finishedAt) {
    updates.finished_at = options.finishedAt;
  }

  const updateEntries = Object.entries(updates);
  const assignments = updateEntries.map(([name]) => `${name} = ?`).join(", ");
  const result = db
    .prepare(`UPDATE job_stage_states SET ${assignments} WHERE tenant_id = ? AND job_id = ? AND stage = ?`)
    .run(...updateEntries.map(([, value]) => value), tenantId, jobId, stage);
  if (result.changes > 0) {
    return;
  }

  const insert: Record<string, SqliteValue> = {
    tenant_id: tenantId,
    job_id: jobId,
    stage,
    state,
    attempt_count: options.attemptCount ?? 0,
    max_attempts: DEFAULT_MAX_ATTEMPTS[stage],
    updated_at: now,
    retryable: options.retryable === false ? 0 : 1,
    blocked_by_json: "[]",
  };
  if (options.finishedAt) {
    insert.finished_at = options.finishedAt;
  }
  const insertEntries = Object.entries(insert);
  db.prepare(
    `INSERT INTO job_stage_states (${insertEntries.map(([name]) => name).join(", ")}) VALUES (${insertEntries
      .map(() => "?")
      .join(", ")})`,
  ).run(...insertEntries.map(([, value]) => value));
}

function getStageStateById(db: SqliteDatabase, tenantId: string, jobId: string, stage: Stage): StageSummary {
  const row = getRow<Record<string, unknown>>(
    db,
    "SELECT * FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = ? LIMIT 1",
    [tenantId, jobId, stage],
  );
  if (!row) {
    return defaultStage(stage, "pending");
  }
  return {
    stage,
    state: isStageState(row.state) ? row.state : "pending",
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: nullableNumber(row.max_attempts) ?? DEFAULT_MAX_ATTEMPTS[stage],
    startedAt: nullableString(row.started_at),
    updatedAt: nullableString(row.updated_at),
    finishedAt: nullableString(row.finished_at),
    durationMs: nullableNumber(row.duration_ms),
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    retryable: row.retryable === null || row.retryable === undefined ? true : Boolean(row.retryable),
    blockedBy: parseStringArray(nullableString(row.blocked_by_json)),
    nextAction: nullableString(row.next_action),
  };
}

function currentMutableStageById(db: SqliteDatabase, tenantId: string, jobId: string): Stage {
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT stage, state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? ORDER BY rowid",
    [tenantId, jobId],
  );
  const active = rows.find((row) => ["queued", "running"].includes(String(row.state ?? "")));
  if (active && STAGES.includes(active.stage as Stage)) {
    return active.stage as Stage;
  }
  return "apply";
}

function currentFailedStageById(db: SqliteDatabase, tenantId: string, jobId: string): Stage | null {
  const rows = allRows<{ stage: Stage; state: string; retryable: number | null }>(
    db,
    "SELECT stage, state, retryable FROM job_stage_states WHERE tenant_id = ? AND job_id = ?",
    [tenantId, jobId],
  );
  const failedStages = new Set(
    rows
      .filter(
        (row) =>
          STAGES.includes(row.stage) &&
          ["failed", "exhausted"].includes(row.state) &&
          (row.stage === "enrich" ||
            (row.retryable !== 0 &&
              latestStageRetryableOverrideById(db, tenantId, jobId, row.stage) !== false)),
      )
      .map((row) => row.stage),
  );
  return STAGES.find((stage) => failedStages.has(stage)) ?? null;
}

function latestStageRetryableOverrideById(
  db: SqliteDatabase,
  tenantId: string,
  jobId: string,
  stage: Stage,
): boolean | null {
  const rows = allRows<{ payload_json: string | null }>(
    db,
    `SELECT payload_json
     FROM job_events
     WHERE tenant_id = ?
       AND job_id = ?
       AND stage = ?
       AND payload_json IS NOT NULL
     ORDER BY event_id ASC`,
    [tenantId, jobId, stage],
  );
  let latest: boolean | null = null;
  for (const row of rows) {
    const payload = parseJsonRecord(row.payload_json);
    const retryable = payload?.["retryable"];
    if (typeof retryable === "boolean") {
      latest = retryable;
    }
  }
  return latest;
}

function recordActionEventById(
  db: SqliteDatabase,
  event: {
    tenantId: string;
    jobId: string;
    stage: Stage;
    eventType: string;
    level: string;
    message: string;
    payload: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level,
       message, occurred_at, payload_json
     ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.tenantId,
    event.jobId,
    event.stage,
    event.eventType,
    event.level,
    event.message,
    new Date().toISOString(),
    JSON.stringify({ tenantId: event.tenantId, jobId: event.jobId, ...event.payload }),
  );
}

function parseJsonObjectInput(raw: unknown, rawText: string | undefined, label: string): Record<string, unknown> {
  const parsed = rawText !== undefined ? parseJson(rawText, label) : raw;
  if (!isRecord(parsed)) {
    throw new InputError(`${label} must be a JSON object.`);
  }
  return parsed;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON.";
    throw new InputError(`${label} contains invalid JSON: ${message}`);
  }
}

function writeJson(filePath: string, value: Record<string, unknown>): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const parsed = parseJson(fs.readFileSync(filePath, "utf8"), path.basename(filePath));
  if (!isRecord(parsed)) {
    throw new InputError(`${path.basename(filePath)} must be a JSON object.`);
  }
  return parsed;
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function columnNames(db: SqliteDatabase, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) {
    return new Set();
  }
  return new Set(allRows<{ name: string }>(db, `PRAGMA table_info(${tableName})`).map((row) => row.name));
}

function defaultStage(stage: Stage, state: StageState): StageSummary {
  return {
    stage,
    state,
    attemptCount: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS[stage],
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    retryable: true,
    blockedBy: [],
    nextAction: null,
  };
}

function parseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  try {
    const parsed: unknown = value ? JSON.parse(value) : null;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function isStageState(value: unknown): value is StageState {
  return (
    value === "pending" ||
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "blocked" ||
    value === "skipped" ||
    value === "exhausted" ||
    value === "needs_verification" ||
    value === "canceled" ||
    value === "stale"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
