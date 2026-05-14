import fs from "node:fs";
import path from "node:path";

import type {
  BulkJobMutationRequest,
  CorrectScoreRequest,
  DeleteJobRequest,
  JobMutationResponse,
  MarkJobActionRequest,
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
} from "@jobhunter/domain-types";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import { matchingJobKeys, readSettingsConfig } from "./read-model.js";

export class InputError extends Error {}

const DEFAULT_MAX_ATTEMPTS: Record<Stage, number> = {
  discover: 1,
  enrich: 3,
  score: 3,
  tailor: 5,
  cover: 5,
  pdf: 3,
  apply: 3,
};

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
  const row = getRow<{ state?: string }>(
    db,
    "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = ?",
    [jobUrl, stage],
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
  // Manual cancel — admin override, bypasses §8.5 (parity with Python's
  // `cancel_stage` JSON-RPC handler).  Cancel from any state is permitted
  // when the user explicitly requests it from the UI.
  upsertStageState(db, jobUrl, stage, "canceled", {
    retryable: true,
    finishedAt: new Date().toISOString(),
    skipValidation: true,
  });
  recordActionEvent(db, {
    jobUrl,
    stage,
    // H1 (round-1 review): align with the new `StageCanceled` catalog event
    // (added to `domain/events/orchestration.py` this round).  Python RPC
    // `cancel_stage` handler writes the same string.
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
  const latest = getRow<Record<string, unknown>>(
    db,
    `SELECT * FROM job_scores
     WHERE tenant_id = 'local' AND job_url = ?
     ORDER BY version DESC LIMIT 1`,
    [jobUrl],
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
  db.prepare(
    `INSERT INTO job_scores (
       job_url, version, tenant_id, fit_score, breakdown_json, keywords_json,
       scored_at, correction_json, criteria_json, trace_json
     ) VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobUrl,
    nextVersion,
    request.correctedScore,
    String(latest.breakdown_json ?? "{}"),
    String(latest.keywords_json ?? "[]"),
    now,
    JSON.stringify(correction),
    String(latest.criteria_json ?? "{}"),
    JSON.stringify(trace),
  );
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
  return { jobUrl, version: nextVersion };
}

export function softDeleteJob(db: SqliteDatabase, jobKey: string, request: DeleteJobRequest = {}): JobMutationResponse {
  return softDeleteJobs(db, { allMatching: false, jobKeys: [jobKey], reason: request.reason });
}

export function softDeleteJobs(db: SqliteDatabase, request: BulkJobMutationRequest): JobMutationResponse {
  ensureDeletedJobsTable(db);
  const deletedAt = new Date().toISOString();
  const jobKeys = mutableJobKeys(db, request);
  const statement = db.prepare(`
    INSERT INTO jobhunter_deleted_jobs (job_url, deleted_at, reason, restored_at)
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
  const statement = db.prepare("UPDATE jobhunter_deleted_jobs SET restored_at = ? WHERE job_url = ? AND restored_at IS NULL");
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

export function writeSettingsConfig(paths: { settingsPath: string }, request: SettingsUpdateRequest): SettingsResponse {
  const next = readJsonObject(paths.settingsPath);
  let wrote = false;

  const assign = (key: string, value: unknown) => {
    next[key] = value;
    wrote = true;
  };

  if (request.targetRole !== undefined) {
    assign("target_role", request.targetRole);
  }
  if (request.locationFilter !== undefined) {
    assign("location_filter", request.locationFilter);
  }
  if (request.minFitScore !== undefined) {
    assign("min_fit_score", request.minFitScore);
  }
  if (request.autoApply !== undefined) {
    assign("auto_apply", request.autoApply);
  }
  if (request.applyConcurrency !== undefined) {
    assign("apply_concurrency", request.applyConcurrency);
  }
  if (request.scoreCriteria !== undefined) {
    assign("score_criteria", request.scoreCriteria);
  }
  if (request.targetCriteria !== undefined) {
    assign("target_criteria", request.targetCriteria);
  }

  if (!wrote) {
    throw new InputError("At least one settings field is required.");
  }

  writeJson(paths.settingsPath, next);
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
 * paths (CLI ``jobhunter retry enrich URL`` and API
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
  db.prepare(
    `UPDATE job_enrichments
       SET current_status = 'pending',
           full_description = NULL,
           application_url = NULL,
           enriched_at = NULL,
           extraction_tier = NULL,
           updated_at = ?
     WHERE job_url = ?`,
  ).run(now, jobUrl);
}

function ensureDeletedJobsTable(db: SqliteDatabase): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS jobhunter_deleted_jobs (
      job_url TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      reason TEXT,
      restored_at TEXT,
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

function ensureJobScoresTable(db: SqliteDatabase): void {
  db.exec(`
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
    value === "canceled" ||
    value === "stale"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
