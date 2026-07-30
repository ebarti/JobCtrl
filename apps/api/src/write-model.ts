import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type {
  BulkJobMutationRequest,
  CorrectScoreRequest,
  DeleteJobRequest,
  JobMutationResponse,
  MarkJobActionRequest,
  ResetStaleScoresForRescoreRequest,
  ResetStaleScoresForRescoreResponse,
  SettingsResponse,
  SettingsUpdateRequest,
  Stage,
  StageState,
  StageSummary,
} from "./contracts.js";
import { PROJECTION_WATERMARK_NAME, STAGES } from "./contracts.js";
import {
  isValidTransition,
  deserializeStageStateKind,
  type StageStateKind,
} from "@jobctrl/domain-types";
import {
  allRows,
  getRow,
  hasCompositeJobIdForeignKey,
  jobKeyReferenceColumn,
  jobReferenceColumn,
  jobReferenceForUrl,
  jobReferencePredicateForUrl,
  tableColumnSet,
  tableExists,
  type SqliteDatabase,
  type SqliteValue,
} from "./db.js";
import { matchingJobKeys, readSettingsConfig } from "./read-model.js";
import { updateConfigObject } from "./config-file.js";

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
  jobUrl: string,
  stage: Stage,
  targetState: StageState,
): void {
  if (!tableExists(db, "job_stage_states")) {
    return;
  }
  const reference = jobReferencePredicateForUrl(
    db,
    "job_stage_states",
    jobUrl,
  );
  const row = getRow<{ state?: string }>(
    db,
    `SELECT state FROM job_stage_states WHERE ${reference.sql} AND stage = ?`,
    [...reference.params, stage],
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
  if (!tableExists(db, "jobs")) {
    return null;
  }
  const row = getRow<{ url?: string }>(db, "SELECT url FROM jobs WHERE url = ? OR application_url = ? LIMIT 1", [
    jobKey,
    jobKey,
  ]);
  return row?.url ?? null;
}

export function resetJobStage(
  db: SqliteDatabase,
  jobKey: string,
  stage: Stage,
  options: { resetAttempts: boolean },
): { jobUrl: string; stage: StageSummary } {
  const jobUrl = resolveJobUrl(db, jobKey);
  if (!jobUrl) {
    throw new InputError("Job not found.");
  }

  // Reset is an admin override (parity with Python's `reset_job_stage`),
  // so even though we _call_ isValidTransition (via validateStageTransition)
  // when the gate is opt-in, this entry-point bypasses §8.5 — the user is
  // explicitly forcing the stage back to pending.
  updateLegacyJobColumnsForReset(db, jobUrl, stage, options.resetAttempts);
  const stageOptions: Parameters<typeof upsertStageState>[4] = {
    retryable: true,
    clearTiming: true,
    skipValidation: true,
  };
  if (options.resetAttempts) {
    stageOptions.attemptCount = 0;
  }
  upsertStageState(db, jobUrl, stage, "pending", stageOptions);
  recordActionEvent(db, {
    jobUrl,
    stage,
    // H1 (round-1 review): align with domain catalog — `StageReset` already
    // exists in `domain/events/orchestration.py`.  Python's
    // `state.py::reset_job_stage` writes the same string.
    eventType: "StageReset",
    level: "info",
    message: `Retry reset requested for ${stage}`,
    payload: { reset_attempts: options.resetAttempts },
  });
  return { jobUrl, stage: getStageState(db, jobUrl, stage) };
}

export function retryFailedJobs(db: SqliteDatabase, request: BulkJobMutationRequest): RetryFailedJobsResult {
  const candidates = mutableJobKeys(db, request);
  const targets = candidates
    .map((jobUrl) => ({ jobUrl, stage: currentFailedStage(db, jobUrl) }))
    .filter((target): target is { jobUrl: string; stage: Stage } => target.stage !== null);
  const transaction = db.transaction((rows: typeof targets) => {
    for (const { jobUrl, stage } of rows) {
      resetJobStage(db, jobUrl, stage, { resetAttempts: false });
    }
  });
  transaction(targets);
  return {
    ok: true,
    count: targets.length,
    jobKeys: targets.map((target) => target.jobUrl),
    targets,
    stageCounts: stageCountsForRetryTargets(targets),
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
      const reference = jobReferencePredicateForUrl(
        db,
        "job_stage_states",
        target.jobUrl,
      );
      const current = getRow<{ state?: string }>(
        db,
        `SELECT state FROM job_stage_states WHERE ${reference.sql} AND stage = ?`,
        [...reference.params, target.stage],
      );
      if (current?.state && current.state !== "pending") {
        continue;
      }
      upsertStageState(db, target.jobUrl, target.stage, "queued", {
        retryable: true,
      });
      recordActionEvent(db, {
        jobUrl: target.jobUrl,
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
  const jobUrl = resolveJobUrl(db, jobKey);
  if (!jobUrl) {
    throw new InputError("Job not found.");
  }
  // Manual mark-applied — admin override, bypasses §8.5 (parity with the
  // Python JSON-RPC `mark_applied` handler).  The user is asserting they
  // applied externally; we trust them.
  updateExistingJobColumns(db, jobUrl, {
    apply_status: "applied",
    apply_error: null,
    applied_at: new Date().toISOString(),
  });
  upsertStageState(db, jobUrl, "apply", "succeeded", {
    retryable: false,
    finishedAt: new Date().toISOString(),
    skipValidation: true,
  });
  recordActionEvent(db, {
    jobUrl,
    stage: "apply",
    // H1 (round-1 review): align with the Python JSON-RPC handler
    // (`infrastructure/rpc/handlers.py::mark_applied`) which writes the
    // same string.  Same logical action across both write surfaces.
    eventType: "ApplicationManuallyMarked",
    level: "info",
    message: "Job marked applied from the local API.",
    payload: { reason: request.reason ?? "" },
  });
  return { jobUrl, stage: getStageState(db, jobUrl, "apply") };
}

export function markJobSkipped(
  db: SqliteDatabase,
  jobKey: string,
  request: MarkJobActionRequest,
): { jobUrl: string; stage: StageSummary } {
  const jobUrl = resolveJobUrl(db, jobKey);
  if (!jobUrl) {
    throw new InputError("Job not found.");
  }
  // Manual mark-skipped — admin override, bypasses §8.5 (parity with
  // Python's `mark_skipped` JSON-RPC handler).
  updateExistingJobColumns(db, jobUrl, {
    apply_status: "skipped",
    apply_error: null,
  });
  upsertStageState(db, jobUrl, "apply", "skipped", {
    retryable: false,
    finishedAt: new Date().toISOString(),
    skipValidation: true,
  });
  recordActionEvent(db, {
    jobUrl,
    stage: "apply",
    // H1 (round-1 review): align with domain catalog — `StageSkipped`
    // already exists in `domain/events/orchestration.py`.  The Python RPC
    // `mark_skipped` handler writes the same string.
    eventType: "StageSkipped",
    level: "info",
    message: "Job marked skipped from the local API.",
    payload: { reason: request.reason ?? "" },
  });
  return { jobUrl, stage: getStageState(db, jobUrl, "apply") };
}

export function cancelJobAction(db: SqliteDatabase, jobKey: string, runId = ""): { jobUrl: string; stage: StageSummary } {
  const jobUrl = resolveJobUrl(db, jobKey);
  if (!jobUrl) {
    throw new InputError("Job not found.");
  }
  const stage = currentMutableStage(db, jobUrl);
  // Manual cancel — admin override, bypasses §8.5.  Cancel from any state is
  // permitted when the user explicitly requests it from the UI.
  upsertStageState(db, jobUrl, stage, "canceled", {
    retryable: true,
    finishedAt: new Date().toISOString(),
    skipValidation: true,
  });
  recordActionEvent(db, {
    jobUrl,
    stage,
    // Canonical `StageCanceled` catalog event (see
    // `domain/events/orchestration.py`).
    eventType: "StageCanceled",
    level: "warning",
    message: "Cancel requested from the local API.",
    payload: { run_id: runId },
  });
  return { jobUrl, stage: getStageState(db, jobUrl, stage) };
}

export function correctScore(
  db: SqliteDatabase,
  jobKey: string,
  request: CorrectScoreRequest,
): { jobUrl: string; version: number } {
  const jobUrl = resolveJobUrl(db, jobKey);
  if (!jobUrl) {
    throw new InputError("Job not found.");
  }
  ensureJobScoresTable(db);
  ensureScoreStalenessTable(db);
  const scoreReferenceColumn = jobReferenceColumn(db, "job_scores");
  const scoreReference = jobReferenceForUrl(db, "job_scores", jobUrl);
  const latest = getRow<Record<string, unknown>>(
    db,
    `SELECT * FROM job_scores
     WHERE tenant_id = 'local' AND ${scoreReferenceColumn} = ?
     ORDER BY version DESC LIMIT 1`,
    [scoreReference],
  );
  if (!latest) {
    throw new InputError("Score correction requires an existing score.");
  }
  const now = new Date().toISOString();
  const nextVersion = Number(latest.version ?? 0) + 1;
  const correction = {
    corrected_fit_score: request.correctedScore,
    rationale: request.reason,
    corrected_by: "local",
    corrected_at: now,
  };
  const trace = appendCorrectionHistory(latest.trace_json, {
    original_score: Number(latest.fit_score ?? 0),
    corrected_score: request.correctedScore,
    rationale: request.reason,
    corrected_by: "local",
    corrected_at: now,
  });
  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO job_scores (
         ${scoreReferenceColumn}, version, tenant_id,
         fit_score, breakdown_json, keywords_json,
         scored_at, correction_json, criteria_json, trace_json
       ) VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scoreReference,
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
      jobUrl,
      latest,
      correctedScore: request.correctedScore,
      correctedAt: now,
    });
    markComparableScoresStale(db, {
      correctedJobUrl: jobUrl,
      markedAt: now,
      newPolicyId: `local:scoring-policy-v${policyChange.newPolicyVersion}`,
      newPolicyVersion: policyChange.newPolicyVersion,
    });
    recordActionEvent(db, {
      jobUrl,
      stage: "score",
      eventType: "ScoreCorrected",
      level: "info",
      message: "Score corrected from the local API.",
      payload: {
        tenantId: "local",
        jobId: jobUrl,
        originalScore: Number(latest.fit_score ?? 0),
        correctedScore: request.correctedScore,
        reason: request.reason,
        correctedAt: now,
      },
    });
  });
  transaction();
  return { jobUrl, version: nextVersion };
}

export function resetStaleScoresForRescore(
  db: SqliteDatabase,
  request: ResetStaleScoresForRescoreRequest = { limit: 0, jobKeys: [] },
): ResetStaleScoresForRescoreResponse {
  ensureScoreStalenessTable(db);
  const limit = Math.max(0, Math.floor(request.limit ?? 0));
  const jobKeysFilter = [...new Set((request.jobKeys ?? []).map((key) => key.trim()).filter(Boolean))];
  const staleReferenceColumn = jobReferenceColumn(db, "job_score_staleness");
  const selectedReferences = jobKeysFilter
    .map((key) => resolveJobUrl(db, key))
    .filter((jobUrl): jobUrl is string => Boolean(jobUrl))
    .map((jobUrl) => jobReferenceForUrl(db, "job_score_staleness", jobUrl));
  const selectedWhere = jobKeysFilter.length
    ? (
      selectedReferences.length
        ? ` AND stale.${staleReferenceColumn} IN (${selectedReferences.map(() => "?").join(", ")})`
        : " AND 0 = 1"
    )
    : "";
  const identityJoin = staleReferenceColumn === "job_id"
    ? "JOIN jobs ON jobs.tenant_id = stale.tenant_id AND jobs.job_id = stale.job_id"
    : "";
  const jobUrlSelect = staleReferenceColumn === "job_id"
    ? "jobs.url"
    : "stale.job_url";
  const rows = allRows<Record<string, unknown>>(
    db,
    `SELECT ${jobUrlSelect} AS job_url, stale.${staleReferenceColumn} AS job_reference,
            stale.stale_reason, stale.old_policy_version, stale.new_policy_version
     FROM job_score_staleness stale
     ${identityJoin}
     WHERE stale.tenant_id = 'local' AND stale.resolved = 0
       ${selectedWhere}
     ORDER BY stale.marked_at ASC${limit > 0 ? " LIMIT ?" : ""}`,
    [...selectedReferences, ...(limit > 0 ? [limit] : [])],
  );
  const now = new Date().toISOString();
  const jobKeys = rows.map((row) => String(row.job_url ?? "")).filter(Boolean);
  for (const row of rows) {
    const jobUrl = String(row.job_url ?? "");
    if (!jobUrl) {
      continue;
    }
    upsertStageState(db, jobUrl, "score", "pending", {
      attemptCount: 0,
      clearTiming: true,
      skipValidation: true,
    });
    db.prepare(
      `UPDATE job_score_staleness
          SET resolved = 1,
              resolved_at = ?
        WHERE tenant_id = 'local'
          AND ${staleReferenceColumn} = ?
          AND stale_reason = ?
          AND old_policy_version = ?
          AND new_policy_version = ?`,
    ).run(
      now,
      String(row.job_reference ?? ""),
      String(row.stale_reason ?? ""),
      Number(row.old_policy_version ?? 0),
      Number(row.new_policy_version ?? 0),
    );
    recordActionEvent(db, {
      jobUrl,
      stage: "score",
      eventType: "ScoreRescoreRequested",
      level: "info",
      message: "Stale score reset for explicit rescore.",
      payload: {
        tenantId: "local",
        jobId: jobUrl,
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
  ensureDeletedJobsTable(db);
  const deletedAt = new Date().toISOString();
  const jobKeys = mutableJobKeys(db, request);
  const statement = db.prepare(`
    INSERT INTO jobctrl_deleted_jobs (job_url, deleted_at, reason, restored_at)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(job_url) DO UPDATE SET
      deleted_at = excluded.deleted_at,
      reason = excluded.reason,
      restored_at = NULL
  `);
  const transaction = db.transaction((keys: string[]) => {
    for (const jobUrl of keys) {
      statement.run(jobUrl, deletedAt, request.reason ?? null);
      recordActionEvent(db, {
        jobUrl,
        stage: currentMutableStage(db, jobUrl),
        eventType: "JobDeleted",
        level: "info",
        message: "Job soft-deleted from the local API.",
        payload: { reason: request.reason ?? "" },
      });
    }
  });
  transaction(jobKeys);
  return { ok: true, count: jobKeys.length, jobKeys };
}

export function restoreJob(db: SqliteDatabase, jobKey: string): JobMutationResponse {
  return restoreJobs(db, { allMatching: false, jobKeys: [jobKey] });
}

export function restoreJobs(db: SqliteDatabase, request: BulkJobMutationRequest): JobMutationResponse {
  ensureDeletedJobsTable(db);
  const restoredAt = new Date().toISOString();
  const jobKeys = mutableJobKeys(db, request);
  const statement = db.prepare(
    "UPDATE jobctrl_deleted_jobs SET restored_at = ? WHERE job_url = ? AND (restored_at IS NULL OR julianday(restored_at) <= julianday(deleted_at))",
  );
  const transaction = db.transaction((keys: string[]) => {
    for (const jobUrl of keys) {
      statement.run(restoredAt, jobUrl);
      recordActionEvent(db, {
        jobUrl,
        stage: currentMutableStage(db, jobUrl),
        eventType: "JobRestored",
        level: "info",
        message: "Job restored from deleted jobs.",
        payload: {},
      });
    }
  });
  transaction(jobKeys);
  return { ok: true, count: jobKeys.length, jobKeys };
}

export function hideJob(db: SqliteDatabase, jobKey: string, request: DeleteJobRequest = {}): JobMutationResponse {
  return hideJobs(db, { allMatching: false, jobKeys: [jobKey], reason: request.reason });
}

export function hideJobs(db: SqliteDatabase, request: BulkJobMutationRequest): JobMutationResponse {
  ensureHiddenJobsTable(db);
  const hiddenAt = new Date().toISOString();
  const jobKeys = mutableJobKeys(db, request);
  const statement = db.prepare(`
    INSERT INTO jobctrl_hidden_jobs (job_url, hidden_at, reason, unhidden_at)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(job_url) DO UPDATE SET
      hidden_at = excluded.hidden_at,
      reason = excluded.reason,
      unhidden_at = NULL
  `);
  const transaction = db.transaction((keys: string[]) => {
    for (const jobUrl of keys) {
      statement.run(jobUrl, hiddenAt, request.reason ?? null);
      recordActionEvent(db, {
        jobUrl,
        stage: currentMutableStage(db, jobUrl),
        eventType: "JobHidden",
        level: "info",
        message: "Job hidden from the local API.",
        payload: { reason: request.reason ?? "" },
      });
    }
  });
  transaction(jobKeys);
  return { ok: true, count: jobKeys.length, jobKeys };
}

export function unhideJob(db: SqliteDatabase, jobKey: string): JobMutationResponse {
  return unhideJobs(db, { allMatching: false, jobKeys: [jobKey] });
}

export function unhideJobs(db: SqliteDatabase, request: BulkJobMutationRequest): JobMutationResponse {
  ensureHiddenJobsTable(db);
  const unhiddenAt = new Date().toISOString();
  const jobKeys = mutableJobKeys(db, request);
  const statement = db.prepare("UPDATE jobctrl_hidden_jobs SET unhidden_at = ? WHERE job_url = ? AND unhidden_at IS NULL");
  const transaction = db.transaction((keys: string[]) => {
    for (const jobUrl of keys) {
      statement.run(unhiddenAt, jobUrl);
      recordActionEvent(db, {
        jobUrl,
        stage: currentMutableStage(db, jobUrl),
        eventType: "JobUnhidden",
        level: "info",
        message: "Job unhidden from hidden jobs.",
        payload: {},
      });
    }
  });
  transaction(jobKeys);
  return { ok: true, count: jobKeys.length, jobKeys };
}

export function permanentlyDeleteJob(db: SqliteDatabase, jobKey: string): JobMutationResponse {
  return permanentlyDeleteJobs(db, { allMatching: false, jobKeys: [jobKey] });
}

export function permanentlyDeleteJobs(db: SqliteDatabase, request: BulkJobMutationRequest): JobMutationResponse {
  const jobKeys = mutableJobKeys(db, request);
  const transaction = db.transaction((keys: string[]) => {
    for (const jobUrl of keys) {
      purgeJobRows(db, jobUrl);
    }
    invalidateOperationsProjections(db);
  });
  transaction(jobKeys);
  return { ok: true, count: jobKeys.length, jobKeys };
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

function updateLegacyJobColumnsForReset(
  db: SqliteDatabase,
  jobUrl: string,
  stage: Stage,
  resetAttempts: boolean,
): void {
  const updates: Record<string, SqliteValue> = {};
  if (stage === "enrich") {
    updates.detail_error = null;
    updates.detail_scraped_at = null;
    // Phase 7 (S-26 round-1 review B2): the new ``job_enrichments``
    // table is the canonical source of "is this job enriched". Without
    // resetting its row the worker's ``_ENRICHMENT_PENDING`` predicate
    // permanently excludes the job and the API-driven retry-enrich
    // silently no-ops. Mirror of Python's ``_reset_enrichment_aggregate``.
    resetEnrichmentAggregate(db, jobUrl);
  } else if (stage === "score") {
    updates.fit_score = null;
    updates.score_reasoning = null;
    updates.scored_at = null;
  } else if (stage === "tailor") {
    updates.tailored_resume_path = null;
    updates.tailored_at = null;
    if (resetAttempts) {
      updates.tailor_attempts = 0;
    }
  } else if (stage === "cover") {
    updates.cover_letter_path = null;
    updates.cover_letter_at = null;
    if (resetAttempts) {
      updates.cover_attempts = 0;
    }
  } else if (stage === "apply") {
    updates.apply_status = null;
    updates.apply_error = null;
    updates.agent_id = null;
    updates.apply_task_id = null;
    if (resetAttempts) {
      updates.apply_attempts = 0;
    }
  }
  updateExistingJobColumns(db, jobUrl, updates);
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
function resetEnrichmentAggregate(db: SqliteDatabase, jobUrl: string): void {
  if (!tableExists(db, "job_enrichments")) {
    return;
  }
  const now = new Date().toISOString();
  const stableReference = hasCompositeJobIdForeignKey(db, "job_enrichments");
  db.prepare(
    `UPDATE job_enrichments
       SET current_status = 'pending',
           full_description = NULL,
           application_url = NULL,
           enriched_at = NULL,
           extraction_tier = NULL,
           updated_at = ?
     WHERE ${stableReference
       ? "tenant_id = 'local' AND job_id = (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ? LIMIT 1)"
       : "job_url = ?"}`,
  ).run(now, jobUrl);
}

function ensureDeletedJobsTable(db: SqliteDatabase): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS jobctrl_deleted_jobs (
      job_url TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      reason TEXT,
      restored_at TEXT,
      FOREIGN KEY(job_url) REFERENCES jobs(url)
    )`,
  ).run();
}

function ensureHiddenJobsTable(db: SqliteDatabase): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS jobctrl_hidden_jobs (
      job_url TEXT PRIMARY KEY,
      hidden_at TEXT NOT NULL,
      reason TEXT,
      unhidden_at TEXT,
      FOREIGN KEY(job_url) REFERENCES jobs(url)
    )`,
  ).run();
}

function mutableJobKeys(db: SqliteDatabase, request: BulkJobMutationRequest): string[] {
  if (request.allMatching) {
    return uniqueJobKeys(matchingJobKeys(db, request.filter ?? {}));
  }
  return uniqueJobKeys(request.jobKeys)
    .map((jobKey) => resolveJobUrl(db, jobKey))
    .filter((jobUrl): jobUrl is string => Boolean(jobUrl));
}

function uniqueJobKeys(jobKeys: string[]): string[] {
  return Array.from(new Set(jobKeys.map((jobKey) => jobKey.trim()).filter(Boolean)));
}

function purgeJobRows(db: SqliteDatabase, jobUrl: string): void {
  const identity = getRow<{ job_id: string }>(
    db,
    `SELECT job_id
       FROM jobs
      WHERE tenant_id = 'local' AND url = ?`,
    [jobUrl],
  );
  const jobId = identity?.job_id;
  deleteWhere(db, "jobctrl_deleted_jobs", "job_url = ?", [jobUrl]);
  deleteWhere(db, "jobctrl_hidden_jobs", "job_url = ?", [jobUrl]);
  if (tableExists(db, "job_stage_states")) {
    const stageReference = jobReferenceColumn(db, "job_stage_states");
    if (stageReference === "job_id" && jobId) {
      deleteWhere(
        db,
        "job_stage_states",
        "tenant_id = ? AND job_id = ?",
        ["local", jobId],
      );
    } else {
      deleteWhere(db, "job_stage_states", "job_url = ?", [jobUrl]);
    }
  }
  deleteWhere(db, "job_events", "job_url = ?", [jobUrl]);
  deleteRepeatApplicationReferences(
    db,
    jobId,
    jobUrl,
  );
  deleteApplicationFeedbackReferences(
    db,
    jobId,
    jobUrl,
  );
  deleteJobReferences(db, "job_artifacts", jobId, jobUrl);
  deleteScoringJobReferences(db, jobId, jobUrl);
  for (const tableName of [
    "job_interview_prep_items",
    "job_interview_prep",
    "job_bullet_provenance",
    "job_material_layout_boxes",
    "job_materials_artifacts",
    "job_materials",
    "job_employer_analysis_sub_analyses",
    "job_employer_analysis_failures",
    "job_employer_analysis",
    "resume_template_refresh_attempts",
    "job_resume_template_assignments",
    "job_posted_compensation_facts",
    "job_market_compensation_estimates",
  ]) {
    deleteJobReferences(db, tableName, jobId, jobUrl);
  }
  deleteEnrichmentJobReferences(db, jobId, jobUrl);
  deletePreparationJobReferences(db, jobId, jobUrl);
  if (jobId) {
    deleteWhere(db, "job_source_observations", "job_id = ?", [jobId]);
    deleteWhere(db, "job_canonical_identities", "job_id = ?", [jobId]);
    deleteDiscoveryJobReferences(
      db,
      "discovery_execution_jobs",
      jobId,
      jobUrl,
    );
    deleteDiscoveryJobReferences(
      db,
      "discovery_search_unit_jobs",
      jobId,
      jobUrl,
    );
    deleteWhere(db, "job_rejected_duplicate_links", "owner_job_id = ?", [jobId]);
    deleteWhere(
      db,
      "job_duplicate_links",
      "surviving_job_id = ? OR superseded_job_or_observation_id IN (?, ?)",
      [jobId, jobId, jobUrl],
    );
  }
  deleteWhere(db, "apply_run_projections", "job_id = ?", [jobUrl]);
  deleteWhere(db, "artifact_list_projections", "job_id = ?", [jobUrl]);
  deleteWhere(db, "job_detail_projections", "job_id = ?", [jobUrl]);
  deleteWhere(db, "job_list_projections", "job_id = ?", [jobUrl]);
  deleteWhere(db, "discovery_quarantine_entries", "job_id = ? OR job_key = ? OR posting_url = ?", [
    jobUrl,
    jobUrl,
    jobUrl,
  ]);
  deleteWhere(db, "discovery_feedback", "job_key = ?", [jobUrl]);
  deleteWhere(db, "jobs", "url = ?", [jobUrl]);
}

function deleteEnrichmentJobReferences(
  db: SqliteDatabase,
  jobId: string | undefined,
  jobUrl: string,
): void {
  for (const tableName of ["job_enrichments", "posting_snapshot_sets"] as const) {
    if (!tableExists(db, tableName)) continue;
    if (jobId && hasCompositeJobIdForeignKey(db, tableName)) {
      deleteWhere(
        db,
        tableName,
        "tenant_id = 'local' AND job_id = ?",
        [jobId],
      );
      continue;
    }
    deleteWhere(
      db,
      tableName,
      `tenant_id = 'local' AND job_url = ?`,
      [jobUrl],
    );
  }
}

function deletePreparationJobReferences(
  db: SqliteDatabase,
  jobId: string | undefined,
  jobUrl: string,
): void {
  if (!tableExists(db, "preparation_work_items")) return;
  if (
    jobId
    && hasCompositeJobIdForeignKey(db, "preparation_work_items")
  ) {
    deleteWhere(
      db,
      "preparation_work_items",
      "tenant_id = 'local' AND job_id = ?",
      [jobId],
    );
    return;
  }
  deleteWhere(
    db,
    "preparation_work_items",
    "tenant_id = 'local' AND job_id = ?",
    [jobUrl],
  );
}

function deleteDiscoveryJobReferences(
  db: SqliteDatabase,
  tableName: "discovery_execution_jobs" | "discovery_search_unit_jobs",
  jobId: string,
  jobUrl: string,
): void {
  const columns = columnNames(db, tableName);
  const tenantScoped = columns.has("tenant_id");
  if (columns.has("job_id")) {
    deleteWhere(
      db,
      tableName,
      tenantScoped ? "tenant_id = 'local' AND job_id = ?" : "job_id = ?",
      [jobId],
    );
  } else if (columns.has("job_url")) {
    deleteWhere(
      db,
      tableName,
      tenantScoped ? "tenant_id = 'local' AND job_url = ?" : "job_url = ?",
      [jobUrl],
    );
  }
}

function invalidateOperationsProjections(db: SqliteDatabase): void {
  deleteWhere(db, "job_list_projections", "1 = 1", []);
  deleteWhere(db, "job_detail_projections", "1 = 1", []);
  deleteWhere(db, "artifact_list_projections", "1 = 1", []);
  deleteWhere(db, "dashboard_projections", "1 = 1", []);
  deleteWhere(db, "event_watermarks", "projection_name = ?", [PROJECTION_WATERMARK_NAME]);
}

function deleteWhere(db: SqliteDatabase, tableName: string, whereSql: string, params: SqliteValue[]): void {
  if (!tableExists(db, tableName)) {
    return;
  }
  db.prepare(`DELETE FROM ${tableName} WHERE ${whereSql}`).run(...params);
}

function deleteScoringJobReferences(
  db: SqliteDatabase,
  jobId: string | undefined,
  jobUrl: string,
): void {
  for (const tableName of [
    "job_requirement_fit_items",
    "job_requirement_fit_reports",
    "job_score_staleness",
    "job_scores",
  ]) {
    if (!tableExists(db, tableName)) continue;
    const referenceColumn = jobReferenceColumn(db, tableName);
    const reference = referenceColumn === "job_id" ? jobId : jobUrl;
    if (!reference) continue;
    deleteWhere(db, tableName, `${referenceColumn} = ?`, [reference]);
  }
}

function deleteApplicationFeedbackReferences(
  db: SqliteDatabase,
  jobId: string | undefined,
  jobUrl: string,
): void {
  for (const tableName of [
    "application_review_decisions",
    "application_outcomes",
    "application_outcome_suggestions",
    "application_email_evidence",
  ]) {
    if (!tableExists(db, tableName)) continue;
    const referenceColumn = jobKeyReferenceColumn(db, tableName);
    const reference = referenceColumn === "job_id" ? jobId : jobUrl;
    if (!reference) continue;
    deleteWhere(
      db,
      tableName,
      `tenant_id = ? AND ${referenceColumn} = ?`,
      ["local", reference],
    );
  }
}

function deleteRepeatApplicationReferences(
  db: SqliteDatabase,
  jobId: string | undefined,
  jobUrl: string,
): void {
  const aliases = repeatApplicationJobAliases(
    db,
    jobId,
    jobUrl,
  );
  const overrideIds = new Set<string>();
  if (tableExists(db, "application_repeat_overrides")) {
    const columns = tableColumnSet(
      db,
      "application_repeat_overrides",
    );
    let ownershipPredicate: string;
    let ownershipParams: SqliteValue[];
    if (
      jobId
      && columns.has("target_job_id")
      && columns.has("prior_job_id")
    ) {
      ownershipPredicate =
        "target_job_id = ? OR prior_job_id = ?";
      ownershipParams = [jobId, jobId];
    } else if (
      columns.has("target_job_key")
      && columns.has("prior_job_key")
    ) {
      const placeholders = aliases.map(() => "?").join(", ");
      ownershipPredicate =
        `target_job_key IN (${placeholders}) `
        + `OR prior_job_key IN (${placeholders})`;
      ownershipParams = [...aliases, ...aliases];
    } else {
      throw new Error(
        "application_repeat_overrides has no supported Job identity columns.",
      );
    }
    const aliasPlaceholders = aliases.map(() => "?").join(", ");
    const predicate =
      `tenant_id = ? AND ((${ownershipPredicate}) OR `
      + `${repeatEvidenceReferencePredicate(
        "application_repeat_overrides",
        aliasPlaceholders,
      )})`;
    const params: SqliteValue[] = [
      "local",
      ...ownershipParams,
      ...aliases,
    ];
    for (const row of allRows<{ override_id: string }>(
      db,
      `SELECT override_id
         FROM application_repeat_overrides
        WHERE ${predicate}`,
      params,
    )) {
      overrideIds.add(row.override_id);
    }
  }

  if (tableExists(db, "application_repeat_audit")) {
    const columns = tableColumnSet(
      db,
      "application_repeat_audit",
    );
    let targetPredicate: string;
    let targetParams: SqliteValue[];
    if (jobId && columns.has("target_job_id")) {
      targetPredicate = "target_job_id = ?";
      targetParams = [jobId];
    } else if (columns.has("target_job_key")) {
      const placeholders = aliases.map(() => "?").join(", ");
      targetPredicate = `target_job_key IN (${placeholders})`;
      targetParams = aliases;
    } else {
      throw new Error(
        "application_repeat_audit has no supported Job identity column.",
      );
    }
    const overrideIdList = [...overrideIds];
    const overridePredicate = overrideIdList.length
      ? `OR override_id IN (${overrideIdList.map(() => "?").join(", ")})`
      : "";
    const aliasPlaceholders = aliases.map(() => "?").join(", ");
    db.prepare(
      `DELETE FROM application_repeat_audit
        WHERE tenant_id = ?
          AND (
            ${targetPredicate}
            ${overridePredicate}
            OR ${repeatEvidenceReferencePredicate(
              "application_repeat_audit",
              aliasPlaceholders,
            )}
          )`,
    ).run(
      "local",
      ...targetParams,
      ...overrideIdList,
      ...aliases,
    );
  }

  const overrideIdList = [...overrideIds];
  if (overrideIdList.length) {
    const placeholders = overrideIdList.map(() => "?").join(", ");
    deleteWhere(
      db,
      "application_repeat_override_consumptions",
      `tenant_id = ? AND override_id IN (${placeholders})`,
      ["local", ...overrideIdList],
    );
    deleteWhere(
      db,
      "application_repeat_overrides",
      `tenant_id = ? AND override_id IN (${placeholders})`,
      ["local", ...overrideIdList],
    );
  }
}

function repeatEvidenceReferencePredicate(
  tableName:
    | "application_repeat_overrides"
    | "application_repeat_audit",
  aliasPlaceholders: string,
): string {
  return `EXISTS (
    SELECT 1
      FROM json_each(
        CASE
          WHEN json_valid(${tableName}.evidence_json)
          THEN ${tableName}.evidence_json
          ELSE '[]'
        END
      ) AS evidence
     WHERE json_extract(
       CASE
         WHEN evidence.type = 'object'
         THEN evidence.value
         ELSE '{}'
       END,
       '$.priorApplication.jobKey'
     ) IN (${aliasPlaceholders})
  )`;
}

function repeatApplicationJobAliases(
  db: SqliteDatabase,
  jobId: string | undefined,
  jobUrl: string,
): string[] {
  const aliases = new Set([jobUrl]);
  if (!jobId || !tableExists(db, "job_identity_aliases")) {
    return [...aliases];
  }
  for (const row of allRows<{ alias_value: string }>(
    db,
    `SELECT alias_value
       FROM job_identity_aliases
      WHERE tenant_id = ?
        AND job_id = ?
        AND alias_kind = 'posting_url'`,
    ["local", jobId],
  )) {
    if (row.alias_value) aliases.add(row.alias_value);
  }
  return [...aliases];
}

function deleteJobReferences(
  db: SqliteDatabase,
  tableName: string,
  jobId: string | undefined,
  jobUrl: string,
): void {
  if (!tableExists(db, tableName)) return;
  const referenceColumn = jobReferenceColumn(db, tableName);
  const reference = referenceColumn === "job_id" ? jobId : jobUrl;
  if (!reference) return;
  const predicate = referenceColumn === "job_id"
    ? "tenant_id = ? AND job_id = ?"
    : "job_url = ?";
  const params: SqliteValue[] = referenceColumn === "job_id"
    ? ["local", reference]
    : [reference];
  deleteWhere(db, tableName, predicate, params);
}

function ensureJobScoresTable(db: SqliteDatabase): void {
  const schemaVersion = db.pragma("user_version", { simple: true }) as number;
  db.exec(schemaVersion >= 12
    ? `
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
    `
    : `
      CREATE TABLE IF NOT EXISTS job_scores (
        job_url TEXT NOT NULL,
        version INTEGER NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'local',
        fit_score INTEGER NOT NULL,
        breakdown_json TEXT NOT NULL,
        keywords_json TEXT NOT NULL,
        scored_at TEXT NOT NULL,
        correction_json TEXT,
        criteria_json TEXT NOT NULL DEFAULT '{}',
        trace_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (job_url, version)
      )
    `);
  const columns = columnNames(db, "job_scores");
  if (!columns.has("criteria_json")) {
    db.exec("ALTER TABLE job_scores ADD COLUMN criteria_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columns.has("trace_json")) {
    db.exec("ALTER TABLE job_scores ADD COLUMN trace_json TEXT NOT NULL DEFAULT '{}'");
  }
}

function ensureScoreStalenessTable(db: SqliteDatabase): void {
  const schemaVersion = db.pragma("user_version", { simple: true }) as number;
  db.exec(schemaVersion >= 12
    ? `
      CREATE TABLE IF NOT EXISTS job_score_staleness (
        tenant_id TEXT NOT NULL DEFAULT 'local',
        job_id TEXT NOT NULL,
        stale_reason TEXT NOT NULL,
        old_policy_id TEXT NOT NULL DEFAULT '',
        old_policy_version INTEGER NOT NULL,
        new_policy_id TEXT NOT NULL DEFAULT '',
        new_policy_version INTEGER NOT NULL,
        marked_at TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0, 1)),
        resolved_at TEXT,
        resolved_by_score_version INTEGER,
        PRIMARY KEY (
          tenant_id, job_id, stale_reason,
          old_policy_version, new_policy_version
        ),
        FOREIGN KEY (tenant_id, job_id)
          REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
      )
    `
    : `
      CREATE TABLE IF NOT EXISTS job_score_staleness (
        tenant_id TEXT NOT NULL DEFAULT 'local',
        job_url TEXT NOT NULL,
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
          tenant_id, job_url, stale_reason,
          old_policy_version, new_policy_version
        )
      )
    `);
  const referenceColumn = jobReferenceColumn(db, "job_score_staleness");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_score_staleness_unresolved
    ON job_score_staleness(tenant_id, resolved, marked_at DESC)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_score_staleness_job
    ON job_score_staleness(tenant_id, ${referenceColumn}, resolved)
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
    jobUrl: string;
    latest: Record<string, unknown>;
    correctedScore: number;
    correctedAt: string;
  },
): { previousPolicyVersion: number; newPolicyVersion: number } {
  ensureScoringPoliciesTable(db);
  const current = getCurrentScoringPolicyRow(db, input.correctedAt);
  const previousTrace = parseObjectOrDefault(String(input.latest.trace_json ?? "{}"));
  const previousBreakdown = parseObjectOrDefault(String(input.latest.breakdown_json ?? "{}"));
  const originalScore = Number(input.latest.fit_score ?? 0);
  const correctionDelta = input.correctedScore - originalScore;
  const anchor = sanitizePolicyAnchor({
    anchor_id: correctionAnchorId({
      tenant_id: "local",
      job_id: input.jobUrl,
      original_score: originalScore,
      corrected_score: input.correctedScore,
      corrected_at: input.correctedAt,
      source_policy_version: Number(previousTrace.scoring_policy_version ?? 0),
    }),
    job_ref_hash: policyAnchorJobRefHash(input.jobUrl),
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
     ) VALUES ('local', ?, ?, ?, ?, NULL)`,
  ).run(
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
    correctedJobUrl: string;
    markedAt: string;
    newPolicyId: string;
    newPolicyVersion: number;
  },
): void {
  ensureScoreStalenessTable(db);
  const scoreReferenceColumn = jobReferenceColumn(db, "job_scores");
  const staleReferenceColumn = jobReferenceColumn(db, "job_score_staleness");
  const identityJoin = scoreReferenceColumn === "job_id"
    ? "JOIN jobs ON jobs.tenant_id = s.tenant_id AND jobs.job_id = s.job_id"
    : "";
  const jobUrlSelect = scoreReferenceColumn === "job_id"
    ? "jobs.url"
    : "s.job_url";
  const latestRows = allRows<Record<string, unknown>>(
    db,
    `SELECT ${jobUrlSelect} AS job_url, s.trace_json
     FROM job_scores s
     ${identityJoin}
     INNER JOIN (
       SELECT tenant_id, ${scoreReferenceColumn}, MAX(version) AS max_version
       FROM job_scores
       WHERE tenant_id = 'local'
       GROUP BY tenant_id, ${scoreReferenceColumn}
     ) latest
       ON latest.tenant_id = s.tenant_id
      AND latest.${scoreReferenceColumn} = s.${scoreReferenceColumn}
      AND latest.max_version = s.version
     WHERE s.tenant_id = 'local'
       AND (s.correction_json IS NULL OR TRIM(s.correction_json) = '')`,
  );
  for (const row of latestRows) {
    const jobUrl = String(row.job_url ?? "");
    if (!jobUrl || jobUrl === input.correctedJobUrl) {
      continue;
    }
    const trace = parseObjectOrDefault(String(row.trace_json ?? "{}"));
    const oldPolicyVersion = numberOrDefault(trace.scoring_policy_version, 0);
    if (oldPolicyVersion >= input.newPolicyVersion) {
      continue;
    }
    const staleReason = "scoring_policy_changed";
    const oldPolicyId = String(trace.scoring_policy_id ?? "");
    const staleReference = jobReferenceForUrl(
      db,
      "job_score_staleness",
      jobUrl,
    );
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO job_score_staleness (
           tenant_id, ${staleReferenceColumn}, stale_reason,
           old_policy_id, old_policy_version,
           new_policy_id, new_policy_version,
           marked_at, resolved, resolved_at, resolved_by_score_version
         ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`,
      )
      .run(
        staleReference,
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
    markScoreStageStale(db, jobUrl, {
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
  jobUrl: string,
  marker: {
    staleReason: string;
    oldPolicyId: string;
    oldPolicyVersion: number;
    newPolicyId: string;
    newPolicyVersion: number;
    markedAt: string;
  },
): void {
  const stageReference = jobReferencePredicateForUrl(
    db,
    "job_stage_states",
    jobUrl,
  );
  const current = getRow<{ state?: string }>(
    db,
    `SELECT state FROM job_stage_states WHERE ${stageReference.sql} AND stage = 'score'`,
    stageReference.params,
  );
  if (!current || current.state === "succeeded") {
    upsertStageState(db, jobUrl, "score", "stale");
  }
  recordActionEvent(db, {
    jobUrl,
    stage: "score",
    eventType: "ScoreMarkedStale",
    level: "info",
    message: "Score marked stale after scoring policy changed.",
    payload: {
      tenantId: "local",
      jobId: jobUrl,
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
     WHERE tenant_id = 'local'
     ORDER BY version DESC
     LIMIT 1`,
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
     ) VALUES ('local', 1, ?, '[]', ?, NULL)`,
  ).run(rubricJson, createdAt);
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

function updateExistingJobColumns(db: SqliteDatabase, jobUrl: string, updates: Record<string, SqliteValue>): void {
  const names = columnNames(db, "jobs");
  const entries = Object.entries(updates).filter(([name]) => names.has(name));
  if (!entries.length) {
    return;
  }
  const assignments = entries.map(([name]) => `${name} = ?`).join(", ");
  db.prepare(`UPDATE jobs SET ${assignments} WHERE url = ?`).run(...entries.map(([, value]) => value), jobUrl);
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

function policyAnchorJobRefHash(jobUrl: string): string {
  return `sha256:${stablePolicyHash({ tenant_id: "local", job_id: jobUrl })}`;
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
 *   - `cancelJobAction`      — user-initiated cancel from any state
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
     * mark-applied, mark-skipped, cancel, reset) set this to mirror
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
  const referenceColumn = jobReferenceColumn(db, "job_stage_states");
  const reference = jobReferencePredicateForUrl(
    db,
    "job_stage_states",
    jobUrl,
  );
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
  const result = db.prepare(`UPDATE job_stage_states SET ${assignments} WHERE ${reference.sql} AND stage = ?`).run(
    ...updateEntries.map(([, value]) => value),
    ...reference.params,
    stage,
  );
  if (result.changes > 0) {
    return;
  }

  const insert: Record<string, SqliteValue> = {
    stage,
    state,
    attempt_count: options.attemptCount ?? 0,
    max_attempts: DEFAULT_MAX_ATTEMPTS[stage],
    updated_at: now,
    retryable: options.retryable === false ? 0 : 1,
    blocked_by_json: "[]",
  };
  if (referenceColumn === "job_id") {
    insert.tenant_id = "local";
    insert.job_id = jobReferenceForUrl(
      db,
      "job_stage_states",
      jobUrl,
    );
  } else {
    insert.job_url = jobUrl;
  }
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
  const reference = jobReferencePredicateForUrl(
    db,
    "job_stage_states",
    jobUrl,
  );
  const row = getRow<Record<string, unknown>>(
    db,
    `SELECT * FROM job_stage_states WHERE ${reference.sql} AND stage = ? LIMIT 1`,
    [...reference.params, stage],
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
  const reference = jobReferencePredicateForUrl(
    db,
    "job_stage_states",
    jobUrl,
  );
  const rows = allRows<Record<string, unknown>>(
    db,
    `SELECT stage, state FROM job_stage_states WHERE ${reference.sql} ORDER BY rowid`,
    reference.params,
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
  const reference = jobReferencePredicateForUrl(
    db,
    "job_stage_states",
    jobUrl,
  );
  const rows = allRows<{ stage: Stage; state: string; retryable: number | null }>(
    db,
    `SELECT stage, state, retryable FROM job_stage_states WHERE ${reference.sql}`,
    reference.params,
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
