/**
 * TS read-model projection refresher (Phase 9 / S-32, S-33).
 *
 * Mirror of ``workers/automation/src/jobhunter/infrastructure/projections/
 * projection_builder.py``.  The TS API process maintains the same
 * ``*_projections`` tables in SQLite so the read-model endpoints can
 * SELECT from a single denormalised source — no LEFT JOIN soup.
 *
 * Both the Python ProjectionBuilder and this TS refresher write to the
 * same tables; they share the ``operations_projections`` watermark in
 * ``event_watermarks``.  Either side can advance the watermark
 * independently — both produce the same projection state because both
 * derive from the canonical aggregate tables (jobs, job_stage_states,
 * job_scores, job_materials, job_enrichments,
 * jobhunter_deleted_jobs, job_artifacts, job_materials_artifacts).
 *
 * PR 4 of the Temporal stack collapsed the bespoke ``apply_runs``
 * table; the Python projection builder now sources
 * ``apply_run_projections`` from the ``job_events`` stream. This TS
 * refresher reads the projection table directly and no longer
 * materialises it.
 */
import { PROJECTION_WATERMARK_NAME, STAGES } from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import { normalizeJobLocation } from "./location-normalization.js";
import { getMarketCompensationEstimate } from "./market-compensation-estimates.js";
import { getPostedCompensationFact } from "./posted-compensation-facts.js";

const STAGE_ORDER: readonly string[] = STAGES;
const CLOSED_ACTIVE_STATES = ["closed", "expired", "removed", "location_incompatible"] as const;
const SOURCE_BOARD_NAMES = new Set(["greenhouse", "linkedin", "talent.com"]);
const SOURCE_QUALITY_EVENT_TYPES = new Set([
  "DiscoveryRunStarted",
  "DiscoveryRunCompleted",
  "DiscoveryRunFailed",
  "JobSourceObserved",
  "DuplicateJobLinked",
  "PostingContentSnapshotCaptured",
  "PostingContentSnapshotFailed",
  "JobEnriched",
  "EnrichmentFailed",
  "JobActiveStateChanged",
  "ContentDuplicateCandidateDetected",
  "DiscoveryFeedbackRecorded",
]);
const COMPENSATION_PROJECTION_VERSION = 1;
const WORKFLOW_RUN_PROJECTION_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["input_summary_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["error_code", "TEXT"],
  ["error_message", "TEXT"],
  ["retryable", "INTEGER NOT NULL DEFAULT 0"],
  ["temporal_run_id", "TEXT"],
];
const DEFAULT_MAX_ATTEMPTS: Record<string, number> = {
  discover: 1,
  enrich: 3,
  score: 3,
  tailor: 5,
  cover: 5,
  apply: 3,
};
const DEPENDENCY_BLOCKER_MESSAGES: Record<string, Array<{ downstream: string; messages: readonly string[] }>> = {
  enrich: [{ downstream: "score", messages: ["Enrichment has not completed."] }],
  score: [{ downstream: "tailor", messages: ["score has not completed."] }],
  tailor: [
    { downstream: "cover", messages: ["tailor has not completed."] },
    { downstream: "apply", messages: ["Materials are not ready."] },
  ],
};

interface BackfillOpts {
  jobUrl: string;
  stage: string;
  attemptCount?: number;
  finishedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * Idempotently backfill ``job_stage_states`` from legacy ``jobs`` columns
 * for any job that has no explicit stage rows.
 *
 * Mirrors ``database._backfill_legacy_stage_states`` in Python.  Both
 * paths use ``INSERT OR IGNORE``, so running both is safe.  Per the
 * no-strangler directive, the projection refreshers MUST NOT carry a
 * "derive stage state from legacy columns" compat shim — the canonical
 * source has to be ``job_stage_states``.  This backfill makes that
 * possible for legacy databases that pre-date the post-DDD pipeline.
 */
function backfillLegacyStageStates(db: SqliteDatabase): void {
  if (!tableExists(db, "jobs") || !tableExists(db, "job_stage_states")) return;
  const legacyJobs = allRows<{
    url: string;
    discovered_at: string | null;
    full_description: string | null;
    detail_scraped_at: string | null;
    detail_error: string | null;
    fit_score: number | null;
    tailored_resume_path: string | null;
    tailor_attempts: number | null;
    cover_letter_path: string | null;
    cover_attempts: number | null;
    applied_at: string | null;
    apply_status: string | null;
    apply_error: string | null;
  }>(
    db,
    `SELECT j.url, j.discovered_at, j.full_description, j.detail_scraped_at,
            j.detail_error, j.fit_score,
            j.tailored_resume_path, j.tailor_attempts,
            j.cover_letter_path, j.cover_attempts,
            j.applied_at, j.apply_status, j.apply_error
     FROM jobs j
     LEFT JOIN job_stage_states jss ON jss.job_url = j.url
     GROUP BY j.url
     HAVING COUNT(jss.stage) = 0`,
  );
  if (legacyJobs.length === 0) return;

  const now = new Date().toISOString();
  const stageMaxAttempts: Record<string, number> = {
    discover: 1,
    enrich: 3,
    score: 3,
    tailor: 5,
    cover: 5,
    apply: 3,
  };
  // Column-aware INSERT: ``database.py::ensure_state_tables`` is the
  // canonical schema (includes ``metadata_json`` + ``version``), but
  // tests construct the table by hand and may omit those columns.  Read
  // the live PRAGMA, build the INSERT around what's actually there.
  const stageColumns = new Set(
    allRows<{ name: string }>(db, "PRAGMA table_info(job_stage_states)").map((r) => r.name),
  );
  const allColumnSpecs: Array<[string, (state: string, opts: BackfillOpts) => SqliteValue]> = [
    ["job_url", (_s, o) => o.jobUrl],
    ["stage", (_s, o) => o.stage],
    ["state", (s) => s],
    ["attempt_count", (_s, o) => o.attemptCount ?? 0],
    ["max_attempts", (_s, o) => stageMaxAttempts[o.stage] ?? null],
    ["started_at", () => null],
    ["updated_at", () => now],
    ["finished_at", (_s, o) => o.finishedAt ?? null],
    ["duration_ms", () => null],
    ["error_code", (_s, o) => o.errorCode ?? null],
    ["error_message", (_s, o) => o.errorMessage ?? null],
    ["retryable", (s) => (s === "blocked" ? 0 : 1)],
    ["blocked_by_json", () => null],
    ["next_action", () => null],
    ["metadata_json", () => null],
    ["version", () => 0],
  ];
  const presentColumns = allColumnSpecs.filter(([col]) => stageColumns.has(col));
  if (presentColumns.length === 0) return;
  const insertSql = `INSERT OR IGNORE INTO job_stage_states (${presentColumns
    .map(([col]) => col)
    .join(", ")}) VALUES (${presentColumns.map(() => "?").join(", ")})`;
  const insert = db.prepare(insertSql);
  const insertStage = (
    jobUrl: string,
    stage: string,
    state: string,
    opts: Omit<BackfillOpts, "jobUrl" | "stage"> = {},
  ): void => {
    const fullOpts: BackfillOpts = { ...opts, jobUrl, stage };
    const values = presentColumns.map(([, fn]) => fn(state, fullOpts));
    insert.run(...values);
  };

  for (const row of legacyJobs) {
    if (!row.url) continue;
    insertStage(row.url, "discover", "succeeded", {
      attemptCount: 1,
      finishedAt: row.discovered_at ?? now,
    });

    const hasEnrichment = Boolean(row.full_description) || Boolean(row.detail_scraped_at);
    let enrichSucceeded = false;
    if (row.detail_error && !hasEnrichment) {
      insertStage(row.url, "enrich", "failed", {
        errorCode: "LEGACY_DETAIL_ERROR",
        errorMessage: String(row.detail_error),
      });
    } else if (hasEnrichment) {
      insertStage(row.url, "enrich", "succeeded", { finishedAt: row.detail_scraped_at ?? now });
      enrichSucceeded = true;
    } else {
      insertStage(row.url, "enrich", "pending");
    }

    const hasScore = row.fit_score !== null && row.fit_score !== undefined;
    let scoreSucceeded = false;
    if (hasScore) {
      insertStage(row.url, "score", "succeeded", { finishedAt: now });
      scoreSucceeded = true;
    } else if (!enrichSucceeded) {
      insertStage(row.url, "score", "blocked", {
        errorCode: "BLOCKED",
        errorMessage: "Enrichment has not completed.",
      });
    } else {
      insertStage(row.url, "score", "pending");
    }

    const hasTailor = Boolean(row.tailored_resume_path);
    const tailorAttempts = Number(row.tailor_attempts ?? 0);
    let tailorSucceeded = false;
    if (hasTailor) {
      insertStage(row.url, "tailor", "succeeded", {
        attemptCount: tailorAttempts,
        finishedAt: now,
      });
      tailorSucceeded = true;
    } else if (!scoreSucceeded) {
      insertStage(row.url, "tailor", "blocked", {
        errorCode: "BLOCKED",
        errorMessage: "score has not completed.",
      });
    } else if (tailorAttempts >= (stageMaxAttempts.tailor ?? 5)) {
      insertStage(row.url, "tailor", "exhausted", {
        attemptCount: tailorAttempts,
        errorCode: "EXHAUSTED",
        errorMessage: "tailor attempts exhausted.",
      });
    } else {
      insertStage(row.url, "tailor", "pending", { attemptCount: tailorAttempts });
    }

    const hasCover = Boolean(row.cover_letter_path);
    const coverAttempts = Number(row.cover_attempts ?? 0);
    if (hasCover) {
      insertStage(row.url, "cover", "succeeded", { attemptCount: coverAttempts, finishedAt: now });
    } else if (!tailorSucceeded) {
      insertStage(row.url, "cover", "blocked", {
        errorCode: "BLOCKED",
        errorMessage: "tailor has not completed.",
      });
    } else if (coverAttempts >= (stageMaxAttempts.cover ?? 5)) {
      insertStage(row.url, "cover", "exhausted", {
        attemptCount: coverAttempts,
        errorCode: "EXHAUSTED",
        errorMessage: "cover attempts exhausted.",
      });
    } else {
      insertStage(row.url, "cover", "pending", { attemptCount: coverAttempts });
    }

    const applyStatusLower = String(row.apply_status ?? "").toLowerCase();
    if (row.applied_at || applyStatusLower === "applied") {
      insertStage(row.url, "apply", "succeeded", { finishedAt: row.applied_at ?? now });
    } else if (applyStatusLower === "in_progress") {
      insertStage(row.url, "apply", "running");
    } else if (row.apply_error) {
      insertStage(row.url, "apply", "failed", {
        errorCode: "LEGACY_APPLY_ERROR",
        errorMessage: String(row.apply_error),
      });
    } else if (!tailorSucceeded) {
      insertStage(row.url, "apply", "blocked", {
        errorCode: "BLOCKED",
        errorMessage: "Materials are not ready.",
      });
    } else {
      insertStage(row.url, "apply", "pending");
    }
  }
}

function reconcileDependencyBlockers(db: SqliteDatabase): Set<string> {
  const repairedJobs = new Set<string>();
  if (!tableExists(db, "job_stage_states")) return repairedJobs;

  const columns = new Set(
    allRows<{ name: string }>(db, "PRAGMA table_info(job_stage_states)").map((row) => row.name),
  );
  const assignments = [
    "state = 'pending'",
    columns.has("updated_at") ? "updated_at = ?" : null,
    columns.has("error_code") ? "error_code = NULL" : null,
    columns.has("error_message") ? "error_message = NULL" : null,
    columns.has("retryable") ? "retryable = 1" : null,
    columns.has("blocked_by_json") ? "blocked_by_json = NULL" : null,
    columns.has("next_action") ? "next_action = NULL" : null,
    columns.has("metadata_json") ? "metadata_json = NULL" : null,
  ].filter((assignment): assignment is string => Boolean(assignment));
  const updateSql = `UPDATE job_stage_states SET ${assignments.join(", ")} WHERE job_url = ? AND stage = ?`;
  const update = db.prepare(updateSql);
  const now = new Date().toISOString();

  for (const [upstream, downstreams] of Object.entries(DEPENDENCY_BLOCKER_MESSAGES)) {
    for (const { downstream, messages } of downstreams) {
      const placeholders = messages.map(() => "?").join(", ");
      const rows = allRows<{ job_url: string; stage: string }>(
        db,
        `SELECT downstream.job_url, downstream.stage
           FROM job_stage_states AS downstream
          WHERE downstream.stage = ?
            AND downstream.state = 'blocked'
            AND downstream.error_code = 'BLOCKED'
            AND downstream.error_message IN (${placeholders})
            AND EXISTS (
              SELECT 1
                FROM job_stage_states AS upstream
               WHERE upstream.job_url = downstream.job_url
                 AND upstream.stage = ?
                 AND upstream.state = 'succeeded'
            )`,
        [downstream, ...messages, upstream],
      );
      for (const row of rows) {
        update.run(...(columns.has("updated_at") ? [now] : []), row.job_url, row.stage);
        repairedJobs.add(row.job_url);
      }
    }
  }

  return repairedJobs;
}

function reconcileObsoleteCoverGenerationConflicts(db: SqliteDatabase): Set<string> {
  const repairedJobs = new Set<string>();
  if (!tableExists(db, "job_stage_states") || !tableExists(db, "job_materials_artifacts")) {
    return repairedJobs;
  }

  const columns = new Set(
    allRows<{ name: string }>(db, "PRAGMA table_info(job_stage_states)").map((row) => row.name),
  );
  const rows = allRows<{
    job_url: string;
    error_message: string | null;
    has_cover_letter: number | string | null;
  }>(
    db,
    `
    SELECT s.job_url,
           s.error_message,
           EXISTS (
             SELECT 1
               FROM job_materials_artifacts tr
               JOIN job_materials_artifacts pdf
                 ON pdf.job_url = tr.job_url
                AND pdf.generation = tr.generation
                AND pdf.artifact_type = 'resume_pdf'
                AND pdf.status = 'approved'
                AND COALESCE(TRIM(pdf.path), '') != ''
               JOIN job_materials_artifacts cover
                 ON cover.job_url = tr.job_url
                AND cover.generation = tr.generation
                AND cover.artifact_type = 'cover_letter'
                AND cover.status = 'approved'
                AND COALESCE(TRIM(cover.path), '') != ''
              WHERE tr.job_url = s.job_url
                AND tr.artifact_type = 'tailored_resume'
                AND tr.status = 'approved'
                AND COALESCE(TRIM(tr.path), '') != ''
           ) AS has_cover_letter
      FROM job_stage_states s
     WHERE s.stage = 'cover'
       AND s.state = 'failed'
       AND s.error_code = 'COVER_FAILED'
       AND s.error_message LIKE 'MaterialsSet generation conflict%'
       AND s.error_message LIKE '%(or current==%'
       AND EXISTS (
             SELECT 1
               FROM job_materials_artifacts tr
               JOIN job_materials_artifacts pdf
                 ON pdf.job_url = tr.job_url
                AND pdf.generation = tr.generation
                AND pdf.artifact_type = 'resume_pdf'
                AND pdf.status = 'approved'
                AND COALESCE(TRIM(pdf.path), '') != ''
              WHERE tr.job_url = s.job_url
                AND tr.artifact_type = 'tailored_resume'
                AND tr.status = 'approved'
                AND COALESCE(TRIM(tr.path), '') != ''
           )
    `,
  );
  if (rows.length === 0) return repairedJobs;

  const assignments = [
    "state = ?",
    columns.has("updated_at") ? "updated_at = ?" : null,
    columns.has("finished_at") ? "finished_at = ?" : null,
    columns.has("error_code") ? "error_code = NULL" : null,
    columns.has("error_message") ? "error_message = NULL" : null,
    columns.has("retryable") ? "retryable = ?" : null,
    columns.has("blocked_by_json") ? "blocked_by_json = NULL" : null,
    columns.has("next_action") ? "next_action = NULL" : null,
    columns.has("metadata_json") ? "metadata_json = ?" : null,
  ].filter((assignment): assignment is string => Boolean(assignment));
  const update = db.prepare(
    `UPDATE job_stage_states
        SET ${assignments.join(", ")}
      WHERE job_url = ?
        AND stage = 'cover'
        AND state = 'failed'
        AND error_code = 'COVER_FAILED'`,
  );
  const now = new Date().toISOString();

  for (const row of rows) {
    const targetState = Number(row.has_cover_letter ?? 0) > 0 ? "succeeded" : "pending";
    const values: SqliteValue[] = [targetState];
    if (columns.has("updated_at")) values.push(now);
    if (columns.has("finished_at")) values.push(targetState === "succeeded" ? now : null);
    if (columns.has("retryable")) values.push(targetState === "pending" ? 1 : 0);
    if (columns.has("metadata_json")) {
      values.push(
        JSON.stringify({
          repaired_at: now,
          repair_reason: "obsolete_cover_generation_conflict",
          target_state: targetState,
          previous_error_message: row.error_message,
        }),
      );
    }
    update.run(...values, row.job_url);
    repairedJobs.add(row.job_url);
  }

  return repairedJobs;
}

/** Idempotently create the projection tables. Mirrors the Python schema. */
export function ensureProjectionTables(db: SqliteDatabase): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_watermarks (
      projection_name     TEXT PRIMARY KEY,
      last_event_id       INTEGER NOT NULL DEFAULT 0,
      updated_at          TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_list_projections (
      tenant_id              TEXT NOT NULL DEFAULT 'local',
      job_id                 TEXT NOT NULL,
      title                  TEXT NOT NULL DEFAULT '',
      employer               TEXT NOT NULL DEFAULT '',
      source                 TEXT NOT NULL DEFAULT '',
      strategy               TEXT NOT NULL DEFAULT '',
      location               TEXT NOT NULL DEFAULT '',
      salary                 TEXT NOT NULL DEFAULT '',
      application_url        TEXT,
      discovered_at          TEXT,
      description            TEXT NOT NULL DEFAULT '',
      full_description       TEXT NOT NULL DEFAULT '',
      fit_score              INTEGER,
      compensation_summary_json TEXT,
      score_breakdown_json   TEXT,
      score_keywords_json    TEXT NOT NULL DEFAULT '[]',
      score_reasoning        TEXT NOT NULL DEFAULT '',
      score_version          INTEGER,
      scored_at              TEXT,
      score_criteria_json    TEXT,
      score_trace_json       TEXT,
      score_correction_json  TEXT,
      current_stage          TEXT NOT NULL DEFAULT 'discover',
      current_substage       TEXT NOT NULL DEFAULT 'discover',
      current_state          TEXT NOT NULL DEFAULT 'pending',
      current_error_code     TEXT,
      current_error_message  TEXT,
      current_next_action    TEXT,
      has_resume             INTEGER NOT NULL DEFAULT 0,
      has_cover_letter       INTEGER NOT NULL DEFAULT 0,
      has_pdf                INTEGER NOT NULL DEFAULT 0,
      apply_status           TEXT,
      applied_at             TEXT,
      artifact_count         INTEGER NOT NULL DEFAULT 0,
      deleted_at             TEXT,
      last_updated_at        TEXT,
      PRIMARY KEY (tenant_id, job_id)
    );
    CREATE TABLE IF NOT EXISTS dashboard_projections (
      tenant_id              TEXT PRIMARY KEY,
      total_jobs             INTEGER NOT NULL DEFAULT 0,
      failures               INTEGER NOT NULL DEFAULT 0,
      blocked                INTEGER NOT NULL DEFAULT 0,
      ready                  INTEGER NOT NULL DEFAULT 0,
      applied                INTEGER NOT NULL DEFAULT 0,
      dry_runs               INTEGER NOT NULL DEFAULT 0,
      funnel_json            TEXT NOT NULL DEFAULT '[]',
      by_source_json         TEXT NOT NULL DEFAULT '[]',
      score_distribution_json TEXT NOT NULL DEFAULT '[]',
      outcome_conversion_json TEXT NOT NULL DEFAULT '{}',
      generated_at           TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS job_detail_projections (
      tenant_id              TEXT NOT NULL DEFAULT 'local',
      job_id                 TEXT NOT NULL,
      description_preview    TEXT NOT NULL DEFAULT '',
      compensation_summary_json TEXT,
      compensation_audit_json TEXT,
      score_breakdown_json   TEXT,
      score_keywords_json    TEXT NOT NULL DEFAULT '[]',
      score_reasoning        TEXT NOT NULL DEFAULT '',
      score_version          INTEGER,
      scored_at              TEXT,
      score_criteria_json    TEXT,
      score_trace_json       TEXT,
      score_correction_json  TEXT,
      stages_json            TEXT NOT NULL DEFAULT '[]',
      employer_analysis_json TEXT,
      requirement_fit_report_json TEXT,
      interview_prep_json    TEXT,
      last_updated_at        TEXT,
      PRIMARY KEY (tenant_id, job_id)
    );
    CREATE TABLE IF NOT EXISTS artifact_list_projections (
      artifact_id            TEXT PRIMARY KEY,
      tenant_id              TEXT NOT NULL DEFAULT 'local',
      job_id                 TEXT NOT NULL,
      job_title              TEXT NOT NULL DEFAULT '',
      job_employer           TEXT NOT NULL DEFAULT '',
      artifact_type          TEXT NOT NULL DEFAULT '',
      status                 TEXT NOT NULL DEFAULT '',
      local_path             TEXT NOT NULL DEFAULT '',
      size_bytes             INTEGER,
      created_at             TEXT,
      generation             INTEGER,
      metadata_json          TEXT,
      layout_boxes_json      TEXT,
      bullet_provenance_json TEXT,
      coverage_audit_json    TEXT,
      voice_pass_json        TEXT
    );
    CREATE TABLE IF NOT EXISTS evidence_usage_projections (
      tenant_id              TEXT NOT NULL DEFAULT 'local',
      projection_kind        TEXT NOT NULL CHECK(projection_kind IN ('entry', 'gap')),
      projection_id          TEXT NOT NULL,
      evidence_id            TEXT,
      skill_id               TEXT,
      requirement_id         TEXT,
      title                  TEXT NOT NULL DEFAULT '',
      payload_json           TEXT NOT NULL,
      last_updated_at        TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tenant_id, projection_kind, projection_id)
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_usage_projection_evidence
      ON evidence_usage_projections(tenant_id, evidence_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_usage_projection_skill
      ON evidence_usage_projections(tenant_id, skill_id);
    CREATE TABLE IF NOT EXISTS apply_run_projections (
      run_id                 TEXT PRIMARY KEY,
      tenant_id              TEXT NOT NULL DEFAULT 'local',
      job_id                 TEXT NOT NULL,
      job_title              TEXT NOT NULL DEFAULT '',
      job_employer           TEXT NOT NULL DEFAULT '',
      status                 TEXT NOT NULL DEFAULT '',
      result                 TEXT,
      dry_run                INTEGER NOT NULL DEFAULT 0,
      worker_id              INTEGER,
      model                  TEXT,
      started_at             TEXT,
      finished_at            TEXT,
      duration_ms            INTEGER,
      events_json            TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS workflow_run_projections (
      workflow_id            TEXT PRIMARY KEY,
      tenant_id              TEXT NOT NULL DEFAULT 'local',
      workflow_type          TEXT NOT NULL DEFAULT '',
      status                 TEXT NOT NULL DEFAULT 'in_progress',
      input_summary_json     TEXT NOT NULL DEFAULT '{}',
      error_code             TEXT,
      error_message          TEXT,
      retryable              INTEGER NOT NULL DEFAULT 0,
      started_at             TEXT,
      finished_at            TEXT,
      duration_ms            INTEGER,
      temporal_run_id        TEXT,
      events_json            TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS source_quality_stats (
      tenant_id                         TEXT NOT NULL DEFAULT 'local',
      source_id                         TEXT NOT NULL,
      window_start                      TEXT NOT NULL,
      window_end                        TEXT NOT NULL,
      run_count                         INTEGER NOT NULL DEFAULT 0,
      failed_run_count                  INTEGER NOT NULL DEFAULT 0,
      consecutive_failures              INTEGER NOT NULL DEFAULT 0,
      observed_jobs                     INTEGER NOT NULL DEFAULT 0,
      new_jobs                          INTEGER NOT NULL DEFAULT 0,
      existing_jobs                     INTEGER NOT NULL DEFAULT 0,
      duplicate_jobs                    INTEGER NOT NULL DEFAULT 0,
      active_jobs                       INTEGER NOT NULL DEFAULT 0,
      stale_jobs                        INTEGER NOT NULL DEFAULT 0,
      detail_success_count              INTEGER NOT NULL DEFAULT 0,
      detail_failure_count              INTEGER NOT NULL DEFAULT 0,
      active_verification_rate          REAL,
      duplicate_rate                    REAL,
      full_description_success_rate     REAL,
      apply_url_success_rate            REAL,
      last_run_id                       TEXT,
      last_error_class                  TEXT,
      recommended_state                 TEXT NOT NULL DEFAULT 'normal',
      updated_at                        TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tenant_id, source_id, window_start, window_end)
    );
    CREATE TABLE IF NOT EXISTS operational_attempt_metrics (
      metric_id               INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id               TEXT NOT NULL DEFAULT 'local',
      occurred_at             TEXT NOT NULL,
      stage                   TEXT NOT NULL,
      source_id               TEXT,
      source_kind             TEXT,
      source_priority         TEXT,
      source_role             TEXT,
      adapter                 TEXT,
      attempt_kind            TEXT NOT NULL,
      outcome                 TEXT NOT NULL,
      failure_category        TEXT,
      is_operational_failure  INTEGER NOT NULL DEFAULT 0,
      is_scrape_failure       INTEGER NOT NULL DEFAULT 0,
      is_retryable            INTEGER NOT NULL DEFAULT 1,
      run_id                  TEXT,
      job_url                 TEXT,
      duration_ms             INTEGER,
      total_count             INTEGER,
      new_count               INTEGER,
      existing_count          INTEGER,
      observed_count          INTEGER,
      duplicate_count         INTEGER,
      error_class             TEXT,
      error_message           TEXT,
      metadata_json           TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_operational_attempt_metrics_stage_time
      ON operational_attempt_metrics(tenant_id, stage, occurred_at DESC, metric_id DESC);
    CREATE INDEX IF NOT EXISTS idx_operational_attempt_metrics_source_time
      ON operational_attempt_metrics(tenant_id, source_id, occurred_at DESC, metric_id DESC);
  `);
  let schemaChanged = false;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "score_breakdown_json", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "compensation_summary_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "job_list_projections", "score_keywords_json", "TEXT NOT NULL DEFAULT '[]'") ||
    schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "score_version", "INTEGER") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "scored_at", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "score_criteria_json", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "score_trace_json", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "score_correction_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "job_list_projections", "current_substage", "TEXT NOT NULL DEFAULT 'discover'") ||
    schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "job_detail_projections", "score_breakdown_json", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_detail_projections", "compensation_summary_json", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_detail_projections", "compensation_audit_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "job_detail_projections", "score_keywords_json", "TEXT NOT NULL DEFAULT '[]'") ||
    schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_detail_projections", "score_version", "INTEGER") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_detail_projections", "scored_at", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_detail_projections", "score_criteria_json", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_detail_projections", "score_trace_json", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_detail_projections", "score_correction_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "job_detail_projections", "employer_analysis_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "job_detail_projections", "requirement_fit_report_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "job_detail_projections", "interview_prep_json", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "artifact_list_projections", "metadata_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "artifact_list_projections", "layout_boxes_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "artifact_list_projections", "bullet_provenance_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "artifact_list_projections", "coverage_audit_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "artifact_list_projections", "voice_pass_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "dashboard_projections", "outcome_conversion_json", "TEXT NOT NULL DEFAULT '{}'") ||
    schemaChanged;
  for (const [columnName, definition] of WORKFLOW_RUN_PROJECTION_COLUMNS) {
    schemaChanged = ensureProjectionColumn(db, "workflow_run_projections", columnName, definition) || schemaChanged;
  }
  return schemaChanged;
}

function ensureProjectionColumn(
  db: SqliteDatabase,
  tableName: string,
  columnName: string,
  definition: string,
): boolean {
  const existingColumns = () =>
    new Set(allRows<{ name: string }>(db, `PRAGMA table_info(${tableName})`).map((row) => row.name));
  if (existingColumns().has(columnName)) {
    return false;
  }
  try {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    // The TS API and the Python worker both run this upgrade at startup against
    // the same SQLite file; the loser of the check-then-ALTER race must treat
    // "duplicate column" as an upgrade that already happened, not a failure.
    if (existingColumns().has(columnName)) {
      return true;
    }
    throw error;
  }
  return true;
}

/** Read the watermark; returns 0 when missing. */
function readWatermark(db: SqliteDatabase, projection: string): number {
  const row = getRow<{ last_event_id: number | string }>(
    db,
    "SELECT last_event_id FROM event_watermarks WHERE projection_name = ?",
    [projection],
  );
  return row ? Number(row.last_event_id) : 0;
}

/** Atomic upsert + commit of the watermark. */
function setWatermark(db: SqliteDatabase, projection: string, eventId: number): void {
  db.prepare(
    `INSERT INTO event_watermarks (projection_name, last_event_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(projection_name) DO UPDATE SET
       last_event_id = excluded.last_event_id,
       updated_at    = excluded.updated_at`,
  ).run(projection, eventId, new Date().toISOString());
}

/**
 * Refresh the projections from canonical state, advancing the
 * shared watermark.  Called at the top of every read-model query so
 * dashboards, lists, and detail views always reflect the latest
 * worker writes (which also bump ``job_events``).
 */
export function refreshProjections(db: SqliteDatabase, tenantId = "local"): void {
  const projectionSchemaChanged = ensureProjectionTables(db);
  backfillLegacyStageStates(db);
  const repairedDependencyJobs = reconcileDependencyBlockers(db);
  const repairedCoverConflictJobs = reconcileObsoleteCoverGenerationConflicts(db);

  const watermark = readWatermark(db, PROJECTION_WATERMARK_NAME);

  let dirtyJobs = new Set<string>([...repairedDependencyJobs, ...repairedCoverConflictJobs]);
  let sourceQualityDirty = false;
  let evidenceUsageDirty = projectionSchemaChanged;
  let maxEventId = watermark;
  if (tableExists(db, "job_events")) {
    const rows = allRows<{ event_id: number; job_url: string | null; event_type: string }>(
      db,
      "SELECT event_id, job_url, event_type FROM job_events WHERE event_id > ? ORDER BY event_id ASC",
      [watermark],
    );
    for (const row of rows) {
      const eventId = Number(row.event_id);
      if (eventId > maxEventId) maxEventId = eventId;
      if (row.job_url) dirtyJobs.add(String(row.job_url));
      if (SOURCE_QUALITY_EVENT_TYPES.has(String(row.event_type))) {
        sourceQualityDirty = true;
      }
      evidenceUsageDirty = true;
    }
  }
  const evidenceProjectionCount =
    getRow<{ c: number }>(db, "SELECT COUNT(*) AS c FROM evidence_usage_projections WHERE tenant_id = ?", [
      tenantId,
    ])?.c ?? 0;
  if (evidenceProjectionCount === 0) {
    evidenceUsageDirty = true;
  }

  // First-run backfill: if the projection table is empty, force a full
  // sweep so jobs that pre-date event-driven writes still get projected.
  const rowCount = getRow<{ c: number }>(
    db,
    "SELECT COUNT(*) AS c FROM job_list_projections WHERE tenant_id = ?",
    [tenantId],
  );
  if (!rowCount || Number(rowCount.c) === 0) {
    if (tableExists(db, "jobs")) {
      const jobs = allRows<{ url: string }>(db, "SELECT url FROM jobs");
      for (const job of jobs) {
        if (job.url) dirtyJobs.add(job.url);
      }
    }
  }
  if (projectionSchemaChanged && tableExists(db, "jobs")) {
    const jobs = allRows<{ url: string }>(db, "SELECT url FROM jobs");
    for (const job of jobs) {
      if (job.url) dirtyJobs.add(job.url);
    }
  }
  if (tableExists(db, "jobs")) {
    const missingProjectedJobs = allRows<{ url: string }>(
      db,
      `SELECT j.url
       FROM jobs j
       LEFT JOIN job_list_projections p
         ON p.tenant_id = ? AND p.job_id = j.url
       WHERE p.job_id IS NULL`,
      [tenantId],
    );
    for (const job of missingProjectedJobs) {
      if (job.url) dirtyJobs.add(job.url);
    }
  }
  for (const jobUrl of staleDeletedProjectionJobs(db, tenantId)) {
    dirtyJobs.add(jobUrl);
  }
  for (const jobUrl of staleArtifactMetadataProjectionJobs(db, tenantId)) {
    dirtyJobs.add(jobUrl);
  }

  // L5 (round-1 review): nothing dirty AND no new events ⇒ skip the
  // O(jobs × stages) dashboard / apply-run rebuilds.
  const sourceQualityExists =
    getRow<{ c: number }>(db, "SELECT COUNT(*) AS c FROM source_quality_stats WHERE tenant_id = ?", [
      tenantId,
    ])?.c ?? 0;
  const sourceQualityHistory = sourceQualityDirty || hasSourceQualityHistory(db);

  if (
    dirtyJobs.size === 0 &&
    !sourceQualityDirty &&
    !evidenceUsageDirty &&
    (sourceQualityExists > 0 || !sourceQualityHistory) &&
    maxEventId === watermark
  ) {
    return;
  }

  if (sourceQualityDirty || (sourceQualityExists === 0 && sourceQualityHistory)) {
    rebuildSourceQualityProjections(db, tenantId);
  }

  for (const jobUrl of dirtyJobs) {
    rebuildJobProjections(db, tenantId, jobUrl);
  }
  if (dirtyJobs.size > 0) {
    // PR 4 of the Temporal stack: ``apply_run_projections`` is now
    // owned by the Python projection builder (sourced from
    // ``job_events``); the TS refresher reads it directly via
    // ``loadLatestApplyRun`` / ``recentApplyRuns`` and no longer
    // materialises the table itself.
    rebuildDashboardProjection(db, tenantId);
  }
  if (evidenceUsageDirty || dirtyJobs.size > 0) {
    rebuildEvidenceUsageProjection(db, tenantId);
  }

  if (maxEventId > watermark) {
    setWatermark(db, PROJECTION_WATERMARK_NAME, maxEventId);
  }
}

interface MaterialsLatest {
  hasCanonicalHistory: boolean;
  generation: number | null;
  tailorPath: string | null;
  tailoredAt: string | null;
  coverPath: string | null;
  coverAt: string | null;
  resumePdfPath: string | null;
  coverPdfPath: string | null;
}

function loadLatestMaterials(db: SqliteDatabase, jobUrl: string): MaterialsLatest {
  const empty: MaterialsLatest = {
    hasCanonicalHistory: false,
    generation: null,
    tailorPath: null,
    tailoredAt: null,
    coverPath: null,
    coverAt: null,
    resumePdfPath: null,
    coverPdfPath: null,
  };
  if (!tableExists(db, "job_materials") || !tableExists(db, "job_materials_artifacts")) {
    return empty;
  }
  const hasCanonicalHistory = Boolean(
    getRow<{ c: number }>(
      db,
      `SELECT COUNT(*) AS c
         FROM job_materials_artifacts
        WHERE job_url = ?
          AND artifact_type IN ('tailored_resume', 'cover_letter', 'resume_pdf', 'cover_letter_pdf')`,
      [jobUrl],
    )?.c,
  );
  const generationRow = getRow<{ max_generation: number }>(
    db,
    `SELECT MAX(generation) AS max_generation
       FROM job_materials_artifacts
      WHERE job_url = ?
        AND status = 'approved'
        AND artifact_type IN ('tailored_resume', 'cover_letter', 'resume_pdf', 'cover_letter_pdf')`,
    [jobUrl],
  );
  const generation = generationRow ? generationRow.max_generation : null;
  if (generation === null || generation === undefined) {
    return { ...empty, hasCanonicalHistory };
  }
  const artifacts = allRows<{ artifact_type: string; path: string; created_at: string | null }>(
    db,
    `SELECT artifact_type, path, created_at FROM job_materials_artifacts
     WHERE job_url = ? AND generation = ? AND status = 'approved'`,
    [jobUrl, Number(generation)],
  );
  const latest: MaterialsLatest = { ...empty, hasCanonicalHistory, generation: Number(generation) };
  for (const a of artifacts) {
    if (!a.path) continue;
    if (a.artifact_type === "tailored_resume") {
      latest.tailorPath = a.path;
      latest.tailoredAt = a.created_at;
    } else if (a.artifact_type === "cover_letter") {
      latest.coverPath = a.path;
      latest.coverAt = a.created_at;
    } else if (a.artifact_type === "resume_pdf") {
      latest.resumePdfPath = a.path;
    } else if (a.artifact_type === "cover_letter_pdf") {
      latest.coverPdfPath = a.path;
    }
  }
  return latest;
}

interface EmployerAnalysisRow extends Record<string, unknown> {
  generation: number;
  snapshot_hash: string;
  prompt_version: string;
  sdk_set_version: string;
  cache_key: string;
  role_framing: string;
  inferred_seniority: string;
  ideal_candidate_narrative: string;
  requirements_json: string;
  keywords_json: string;
  agreement_json: string;
  legs_attempted: number;
  legs_succeeded: number;
  created_at: string;
}

interface RequirementFitReportRow extends Record<string, unknown> {
  job_url: string;
  score_version: number;
  employer_analysis_generation: number;
  profile_snapshot_version: number;
  scoring_policy_version: number;
  formula_version: string;
  resolved_fit_score: number | null;
  fit_band: string;
  confidence: string;
  summary_json: string;
}

interface RequirementFitItemRow extends Record<string, unknown> {
  requirement_id: string;
  requirement_text: string;
  tier: string;
  weight: number;
  job_evidence_span: string;
  fit_json: string;
  contribution_json: string;
  tailoring_json: string;
  artifact_coverage_json: string | null;
}

interface InterviewPrepRow extends Record<string, unknown> {
  job_url: string;
  generation: number;
  status: string;
  model: string | null;
  generated_at: string;
  gate_status: string;
  fabrication_findings_json: string;
  grounding_findings_json: string;
  judge_verdict: string | null;
  warnings_json: string;
}

interface InterviewPrepItemRow extends Record<string, unknown> {
  item_id: string;
  kind: string;
  title: string;
  generated_text: string;
  evidence_ids_json: string;
  requirement_ids_json: string;
  source_text_json: string;
  transform_type: string;
  control: string;
  grounding_audit_json: string;
  warnings_json: string;
  position: number;
}

interface BulletProvenanceRow extends Record<string, unknown> {
  job_url: string;
  artifact_id: string;
  generation: number;
  bullet_id: string;
  section: string;
  source_id: string | null;
  evidence_ids_json: string;
  requirement_ids_json: string;
  matched_keywords_json: string;
  transform_type: string;
  control: string;
  rationale: string | null;
  generated_text: string;
  position: number;
  created_at: string;
}

interface EvidenceMapEntryPayload {
  entryId: string;
  kind: "achievement_evidence" | "skill";
  evidenceId: string | null;
  skillId: string | null;
  title: string;
  story: {
    scope: string;
    action: string;
    outcome: string;
    metrics: string[];
  } | null;
  skills: string[];
  tags: string[];
  freshness: {
    evidenceDateRange: string | null;
    evidenceStrength: string | null;
    userConfirmed: boolean;
    claimConfidence: number | null;
    lastUsedAt: string | null;
  };
  resumeUsages: EvidenceUsagePayload[];
  requirementUsages: EvidenceUsagePayload[];
  coverageUsages: EvidenceUsagePayload[];
  gaps: EvidenceGapPayload[];
}

interface EvidenceUsagePayload {
  kind: "resume_bullet" | "requirement_fit" | "skill_coverage";
  jobKey: string;
  jobTitle: string | null;
  employer: string | null;
  artifactId: string | null;
  bulletId: string | null;
  generation: number | null;
  generatedTextPreview: string | null;
  scoreVersion: number | null;
  requirementId: string | null;
  requirementText: string | null;
  requirementFitKind: string | null;
  artifactCoverageState: string | null;
  keyword: string | null;
  coverageState: "covered" | "declared" | "missing" | null;
  occurredAt: string | null;
}

interface EvidenceGapPayload {
  gapId: string;
  kind: "missing_requirement" | "blocked_requirement" | "transferable_requirement" | "missing_skill";
  requirementId: string | null;
  requirementText: string;
  demandedSkill: string | null;
  tier: string | null;
  weight: number | null;
  fitKind: string | null;
  reason: string;
  jobRefs: EvidenceUsagePayload[];
}

/**
 * Phase 1: rebuild the canonical employer-analysis read shape from canonical
 * rows. This MUST stay byte-equivalent to the Python
 * ``EmployerAnalysis.to_read_model()`` — the cross-runtime projection parity
 * test asserts both builders agree. Returns null when no analysis exists.
 */
function loadEmployerAnalysisJson(db: SqliteDatabase, jobUrl: string): string | null {
  if (!tableExists(db, "job_employer_analysis")) return null;
  const row = getRow<EmployerAnalysisRow>(
    db,
    `SELECT * FROM job_employer_analysis WHERE job_url = ?
      ORDER BY generation DESC LIMIT 1`,
    [jobUrl],
  );
  if (!row) return null;
  const generation = Number(row.generation);
  const legsAttempted = Number(row.legs_attempted);
  const legsSucceeded = Number(row.legs_succeeded);
  const agreement = parseAnalysisAgreement(row.agreement_json);

  const subRows = allRows<{ model_id: string; analysis_json: string }>(
    db,
    `SELECT model_id, analysis_json FROM job_employer_analysis_sub_analyses
      WHERE job_url = ? AND generation = ? ORDER BY model_id`,
    [jobUrl, generation],
  );
  const failureRows = allRows<{ model_id: string; error: string; raw_output: string | null }>(
    db,
    `SELECT model_id, error, raw_output FROM job_employer_analysis_failures
      WHERE job_url = ? AND generation = ? ORDER BY model_id`,
    [jobUrl, generation],
  );

  const readModel = {
    generation,
    snapshot_hash: row.snapshot_hash,
    prompt_version: row.prompt_version,
    sdk_set_version: row.sdk_set_version,
    cache_key: row.cache_key,
    created_at: row.created_at,
    ensemble_completeness: `${legsSucceeded}/${legsAttempted}`,
    legs_attempted: legsAttempted,
    legs_succeeded: legsSucceeded,
    is_degraded: legsSucceeded < legsAttempted,
    agreement,
    role_framing: row.role_framing,
    inferred_seniority: row.inferred_seniority,
    ideal_candidate_narrative: row.ideal_candidate_narrative,
    requirements: parseJsonArray(row.requirements_json),
    keywords: parseJsonArray(row.keywords_json),
    sub_analyses: subRows.map((sub) => ({
      model_id: sub.model_id,
      ...(parseJsonObject(sub.analysis_json) as Record<string, unknown>),
    })),
    failures: failureRows.map((f) => ({
      model_id: f.model_id,
      error: f.error,
      raw_output: f.raw_output ?? null,
    })),
  };
  return JSON.stringify(readModel);
}

function loadRequirementFitReportJson(
  db: SqliteDatabase,
  tenantId: string,
  jobUrl: string,
): string | null {
  if (!tableExists(db, "job_requirement_fit_reports")) return null;
  if (!tableExists(db, "job_requirement_fit_items")) return null;
  const row = getRow<RequirementFitReportRow>(
    db,
    `SELECT job_url, score_version, tenant_id, employer_analysis_generation,
            profile_snapshot_version, scoring_policy_version, formula_version,
            resolved_fit_score, fit_band, confidence, summary_json
       FROM job_requirement_fit_reports
      WHERE tenant_id = ? AND job_url = ?
      ORDER BY score_version DESC
      LIMIT 1`,
    [tenantId, jobUrl],
  );
  if (!row) return null;
  const scoreVersion = Number(row.score_version);
  const items = allRows<RequirementFitItemRow>(
    db,
    `SELECT requirement_id, requirement_text, tier, weight, job_evidence_span,
            fit_json, contribution_json, tailoring_json, artifact_coverage_json
       FROM job_requirement_fit_items
      WHERE tenant_id = ? AND job_url = ? AND score_version = ?
      ORDER BY position ASC, requirement_id ASC`,
    [tenantId, jobUrl, scoreVersion],
  );
  const readModel = {
    jobKey: row.job_url,
    scoreVersion,
    employerAnalysisGeneration: Number(row.employer_analysis_generation ?? 0),
    profileSnapshotVersion: Number(row.profile_snapshot_version ?? 0),
    scoringPolicyVersion: Number(row.scoring_policy_version ?? 0),
    formulaVersion: row.formula_version,
    resolvedFitScore: nullableNumber(row.resolved_fit_score),
    fitBand: row.fit_band,
    confidence: row.confidence,
    summary: requirementFitSummaryToReadModel(parseJsonObject(row.summary_json)),
    assessments: items.map(requirementFitAssessmentToReadModel),
  };
  return JSON.stringify(readModel);
}

function loadInterviewPrepJson(
  db: SqliteDatabase,
  tenantId: string,
  jobUrl: string,
): string | null {
  if (!tableExists(db, "job_interview_prep")) return null;
  if (!tableExists(db, "job_interview_prep_items")) return null;
  const row = getRow<InterviewPrepRow>(
    db,
    `SELECT job_url, generation, status, model, generated_at, gate_status,
            fabrication_findings_json, grounding_findings_json, judge_verdict,
            warnings_json
       FROM job_interview_prep
      WHERE tenant_id = ? AND job_url = ? AND status = 'accepted'
      ORDER BY generation DESC
      LIMIT 1`,
    [tenantId, jobUrl],
  );
  if (!row) return null;
  const generation = Number(row.generation);
  const items = allRows<InterviewPrepItemRow>(
    db,
    `SELECT item_id, kind, title, generated_text, evidence_ids_json,
            requirement_ids_json, source_text_json, transform_type, control,
            grounding_audit_json, warnings_json, position
       FROM job_interview_prep_items
      WHERE tenant_id = ? AND job_url = ? AND generation = ?
      ORDER BY position ASC, item_id ASC`,
    [tenantId, jobUrl, generation],
  );
  const readModel = {
    jobKey: row.job_url,
    generation,
    status: row.status,
    generatedAt: row.generated_at,
    model: row.model ?? null,
    gateAudit: {
      status: row.gate_status,
      fabricationFindings: parseStringList(parseJsonArray(row.fabrication_findings_json)),
      groundingFindings: parseStringList(parseJsonArray(row.grounding_findings_json)),
      judgeVerdict: row.judge_verdict ?? null,
      warnings: parseStringList(parseJsonArray(row.warnings_json)),
    },
    items: items.map((item) => ({
      itemId: item.item_id,
      kind: item.kind,
      title: item.title,
      generatedText: item.generated_text,
      evidenceIds: parseStringList(parseJsonArray(item.evidence_ids_json)),
      requirementIds: parseStringList(parseJsonArray(item.requirement_ids_json)),
      sourceText: parseStringList(parseJsonArray(item.source_text_json)),
      transformType: item.transform_type,
      control: item.control,
      groundingAudit: parseStringList(parseJsonArray(item.grounding_audit_json)),
      warnings: parseStringList(parseJsonArray(item.warnings_json)),
      position: Number(item.position ?? 0),
    })),
  };
  return JSON.stringify(readModel);
}

function requirementFitAssessmentToReadModel(row: RequirementFitItemRow): Record<string, unknown> {
  return {
    requirementId: row.requirement_id,
    requirementText: row.requirement_text,
    tier: row.tier,
    weight: nullableNumber(row.weight) ?? 0,
    jobEvidenceSpan: row.job_evidence_span,
    fit: requirementFitStatusToReadModel(parseJsonObject(row.fit_json)),
    contribution: requirementContributionToReadModel(parseJsonObject(row.contribution_json)),
    tailoring: requirementTailoringToReadModel(parseJsonObject(row.tailoring_json)),
    artifactCoverage: row.artifact_coverage_json
      ? requirementArtifactCoverageToReadModel(parseJsonObject(row.artifact_coverage_json))
      : null,
  };
}

function requirementFitStatusToReadModel(value: Record<string, unknown>): Record<string, unknown> {
  const kind = stringField(value.kind) || "not_assessed";
  if (kind === "matched") {
    return {
      kind,
      evidenceIds: parseStringList(value.evidence_ids ?? value.evidenceIds),
      strength: stringField(value.strength) || "direct",
    };
  }
  if (kind === "transferable") {
    return {
      kind,
      evidenceIds: parseStringList(value.evidence_ids ?? value.evidenceIds),
      gap: stringField(value.gap),
      bridge: stringField(value.bridge),
    };
  }
  if (kind === "missing") {
    return { kind, reason: stringField(value.reason) };
  }
  if (kind === "blocked") {
    return { kind, blocker: stringField(value.blocker) };
  }
  return { kind: "not_assessed", reason: stringField(value.reason) };
}

function requirementContributionToReadModel(value: Record<string, unknown>): Record<string, unknown> {
  return {
    maxPoints: nullableNumber(value.max_points ?? value.maxPoints) ?? 0,
    awardedPoints: nullableNumber(value.awarded_points ?? value.awardedPoints) ?? 0,
    weightedImpact: nullableNumber(value.weighted_impact ?? value.weightedImpact) ?? 0,
    rationale: stringField(value.rationale),
  };
}

function requirementTailoringToReadModel(value: Record<string, unknown>): Record<string, unknown> {
  return {
    action: stringField(value.action) || "low_priority",
    priority: nullableNumber(value.priority) ?? 0,
    allowedEvidenceIds: parseStringList(value.allowed_evidence_ids ?? value.allowedEvidenceIds),
    targetKeywords: parseStringList(value.target_keywords ?? value.targetKeywords),
    prohibitedClaims: parseStringList(value.prohibited_claims ?? value.prohibitedClaims),
    instruction: stringField(value.instruction),
  };
}

function requirementArtifactCoverageToReadModel(value: Record<string, unknown>): Record<string, unknown> {
  return {
    state: stringField(value.state) || "not_recorded",
    source: stringField(value.source) || "tailored_resume_bullet_provenance",
    bulletCount: nullableNumber(value.bullet_count ?? value.bulletCount) ?? 0,
    examples: parseStringList(value.examples),
  };
}

function requirementFitSummaryToReadModel(value: Record<string, unknown>): Record<string, unknown> {
  return {
    weightedFit: nullableNumber(value.weighted_fit ?? value.weightedFit) ?? 0,
    mustHaveCoverage: nullableNumber(value.must_have_coverage ?? value.mustHaveCoverage) ?? 0,
    blockerCount: nullableNumber(value.blocker_count ?? value.blockerCount) ?? 0,
    missingHighWeightCount: nullableNumber(value.missing_high_weight_count ?? value.missingHighWeightCount) ?? 0,
  };
}

/**
 * Phase 2 — load the latest per-bullet provenance read shape keyed by artifact.
 *
 * Mirrors the Python ``BulletProvenanceSet.to_read_model()`` projection so the
 * TS API and Python builder materialise the SAME read shape — the cross-runtime
 * parity test asserts both agree. Returns an empty map when no provenance exists.
 */
function loadBulletProvenanceByArtifact(
  db: SqliteDatabase,
  tenantId: string,
  jobUrl: string,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!tableExists(db, "job_bullet_provenance")) return result;
  // Tenant-scope BOTH the MAX(generation) probe and the row fetch so this matches
  // the Python repo (``bullet_provenance_repository.py`` filters job_url AND
  // tenant_id AND generation). Benign today under LOCAL_TENANT, but keeps the
  // cross-runtime read path symmetric before any multi-tenant work.
  const genRow = getRow<{ generation: number | null }>(
    db,
    `SELECT MAX(generation) AS generation FROM job_bullet_provenance
      WHERE job_url = ? AND tenant_id = ?`,
    [jobUrl, tenantId],
  );
  const generation = genRow?.generation;
  if (generation === null || generation === undefined) return result;
  const rows = allRows<BulletProvenanceRow>(
    db,
    `SELECT * FROM job_bullet_provenance
      WHERE job_url = ? AND tenant_id = ? AND generation = ?
      ORDER BY position, bullet_id`,
    [jobUrl, tenantId, Number(generation)],
  );
  if (rows.length === 0) return result;
  // All rows of one generation share the artifact they explain (the writer binds
  // the whole set to one artifact_id). Group defensively by artifact_id anyway.
  const byArtifact = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const entry = {
      bullet_id: row.bullet_id,
      section: row.section,
      source_id: row.source_id ?? null,
      evidence_ids: parseJsonArray(row.evidence_ids_json),
      requirement_ids: parseJsonArray(row.requirement_ids_json),
      matched_keywords: parseJsonArray(row.matched_keywords_json),
      transform_type: row.transform_type,
      control: row.control,
      rationale: row.rationale ?? "",
      generated_text: row.generated_text,
    };
    const list = byArtifact.get(row.artifact_id) ?? [];
    list.push(entry);
    byArtifact.set(row.artifact_id, list);
  }
  for (const [artifactId, entries] of byArtifact) {
    result.set(artifactId, JSON.stringify(entries));
  }
  return result;
}

/**
 * Phase 3 — load the latest generation's set-level coverage + voice read shapes,
 * keyed by artifact.
 *
 * Coverage (GROUND-06) and the voice-pass audit (VOICE-02) are set-level facts
 * denormalised onto every ``job_bullet_provenance`` row (the Python repo writes
 * the same value on every row of a generation), so we read them off ANY row of the
 * latest generation. Returns ``{ coverage, voice }`` maps mirroring the Python
 * projection builder so the cross-runtime parity test asserts both agree. Empty
 * maps when no provenance exists or the columns predate Phase 3.
 */
function loadProvenanceAuxByArtifact(
  db: SqliteDatabase,
  tenantId: string,
  jobUrl: string,
): { coverage: Map<string, string>; voice: Map<string, string> } {
  const coverage = new Map<string, string>();
  const voice = new Map<string, string>();
  if (!tableExists(db, "job_bullet_provenance")) return { coverage, voice };
  const genRow = getRow<{ generation: number | null }>(
    db,
    `SELECT MAX(generation) AS generation FROM job_bullet_provenance
      WHERE job_url = ? AND tenant_id = ?`,
    [jobUrl, tenantId],
  );
  const generation = genRow?.generation;
  if (generation === null || generation === undefined) return { coverage, voice };
  let row: { artifact_id: string; coverage_json: string | null; voice_json: string | null } | undefined;
  try {
    row = getRow<{ artifact_id: string; coverage_json: string | null; voice_json: string | null }>(
      db,
      `SELECT artifact_id, coverage_json, voice_json FROM job_bullet_provenance
        WHERE job_url = ? AND tenant_id = ? AND generation = ?
        ORDER BY position, bullet_id
        LIMIT 1`,
      [jobUrl, tenantId, Number(generation)],
    );
  } catch {
    // Columns predate Phase 3 (a DB written before this migration ran) — no aux data.
    return { coverage, voice };
  }
  if (!row) return { coverage, voice };
  if (row.coverage_json && row.coverage_json.trim()) coverage.set(row.artifact_id, row.coverage_json);
  if (row.voice_json && row.voice_json.trim()) voice.set(row.artifact_id, row.voice_json);
  return { coverage, voice };
}

function rebuildEvidenceUsageProjection(db: SqliteDatabase, tenantId: string): void {
  const now = new Date().toISOString();
  const entries = new Map<string, EvidenceMapEntryPayload>();
  const gaps = new Map<string, EvidenceGapPayload>();

  loadProfileEvidenceEntries(db, tenantId, entries);
  const skillEntriesByName = loadProfileSkillEntries(db, tenantId, entries);
  attachResumeUsages(db, tenantId, entries);
  attachRequirementUsagesAndGaps(db, tenantId, entries, gaps);
  attachSkillCoverageUsagesAndGaps(db, tenantId, entries, skillEntriesByName, gaps);

  const insert = db.prepare(
    `INSERT INTO evidence_usage_projections (
       tenant_id, projection_kind, projection_id, evidence_id, skill_id,
       requirement_id, title, payload_json, last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.prepare("DELETE FROM evidence_usage_projections WHERE tenant_id = ?").run(tenantId);
  for (const entry of [...entries.values()].sort((a, b) => a.title.localeCompare(b.title))) {
    insert.run(
      tenantId,
      "entry",
      entry.entryId,
      entry.evidenceId,
      entry.skillId,
      null,
      entry.title,
      JSON.stringify(entry),
      now,
    );
  }
  for (const gap of [...gaps.values()].sort((a, b) => a.requirementText.localeCompare(b.requirementText))) {
    insert.run(
      tenantId,
      "gap",
      gap.gapId,
      null,
      null,
      gap.requirementId,
      gap.requirementText,
      JSON.stringify(gap),
      now,
    );
  }
}

function loadProfileEvidenceEntries(
  db: SqliteDatabase,
  tenantId: string,
  entries: Map<string, EvidenceMapEntryPayload>,
): void {
  if (!tableExists(db, "candidate_profile_achievement_evidence")) return;
  const evidenceStrengthExpr = columnOrLiteral(
    db,
    "candidate_profile_achievement_evidence",
    "evidence_strength",
    "'supported'",
    "evidence",
  );
  const claimConfidenceExpr = columnOrLiteral(
    db,
    "candidate_profile_achievement_evidence",
    "claim_confidence",
    "0",
    "evidence",
  );
  const userConfirmedExpr = columnOrLiteral(
    db,
    "candidate_profile_achievement_evidence",
    "user_confirmed",
    "0",
    "evidence",
  );
  const tagsJsonExpr = columnOrLiteral(
    db,
    "candidate_profile_achievement_evidence",
    "tags_json",
    "'[]'",
    "evidence",
  );
  const hasExperience =
    tableExists(db, "candidate_profile_experience_entries") &&
    hasColumn(db, "candidate_profile_experience_entries", "date_range");
  const rows = allRows<{
    entry_id: string;
    evidence_id: string;
    source_text: string;
    scope: string;
    action: string;
    tools_json: string;
    metrics_json: string;
    outcome: string;
    evidence_strength: string;
    claim_confidence: number | null;
    user_confirmed: number | string | null;
    tags_json: string;
    date_range: string | null;
  }>(
    db,
    hasExperience
      ? `SELECT evidence.entry_id, evidence.evidence_id, evidence.source_text,
                evidence.scope, evidence.action, evidence.tools_json,
                evidence.metrics_json, evidence.outcome, ${evidenceStrengthExpr} AS evidence_strength,
                ${claimConfidenceExpr} AS claim_confidence, ${userConfirmedExpr} AS user_confirmed,
                ${tagsJsonExpr} AS tags_json,
                experience.date_range
           FROM candidate_profile_achievement_evidence AS evidence
           LEFT JOIN candidate_profile_experience_entries AS experience
             ON experience.tenant_id = evidence.tenant_id
            AND experience.profile_id = evidence.profile_id
            AND experience.entry_id = evidence.entry_id
          WHERE evidence.tenant_id = ? AND evidence.profile_id = ?
            AND TRIM(evidence.evidence_id) != ''
          ORDER BY evidence.entry_id, evidence.evidence_index`
      : `SELECT evidence.entry_id, evidence.evidence_id, evidence.source_text,
                evidence.scope, evidence.action, evidence.tools_json,
                evidence.metrics_json, evidence.outcome, ${evidenceStrengthExpr} AS evidence_strength,
                ${claimConfidenceExpr} AS claim_confidence, ${userConfirmedExpr} AS user_confirmed,
                ${tagsJsonExpr} AS tags_json,
                NULL AS date_range
           FROM candidate_profile_achievement_evidence AS evidence
          WHERE evidence.tenant_id = ? AND evidence.profile_id = ?
            AND TRIM(evidence.evidence_id) != ''
          ORDER BY evidence.entry_id, evidence.evidence_index`,
    [tenantId, "default"],
  );
  for (const row of rows) {
    const evidenceId = stringField(row.evidence_id).trim();
    if (!evidenceId) continue;
    const title = previewText(row.action || row.scope || row.outcome || row.source_text || evidenceId, 140);
    entries.set(evidenceId, {
      entryId: evidenceId,
      kind: "achievement_evidence",
      evidenceId,
      skillId: null,
      title,
      story: {
        scope: stringField(row.scope),
        action: stringField(row.action),
        outcome: stringField(row.outcome),
        metrics: parseStringList(parseJsonArray(row.metrics_json)),
      },
      skills: parseStringList(parseJsonArray(row.tools_json)),
      tags: parseStringList(parseJsonArray(row.tags_json)),
      freshness: {
        evidenceDateRange: nullableString(row.date_range),
        evidenceStrength: nullableString(row.evidence_strength),
        userConfirmed: Number(row.user_confirmed ?? 0) === 1,
        claimConfidence: nullableNumber(row.claim_confidence),
        lastUsedAt: null,
      },
      resumeUsages: [],
      requirementUsages: [],
      coverageUsages: [],
      gaps: [],
    });
  }
}

function loadProfileSkillEntries(
  db: SqliteDatabase,
  tenantId: string,
  entries: Map<string, EvidenceMapEntryPayload>,
): Map<string, EvidenceMapEntryPayload[]> {
  const byName = new Map<string, EvidenceMapEntryPayload[]>();
  if (!tableExists(db, "candidate_profile_skill_items")) return byName;
  const hasCategories = tableExists(db, "candidate_profile_skill_categories");
  const rows = allRows<{ category_id: string; item_index: number; item_text: string; label: string }>(
    db,
    hasCategories
      ? `SELECT skills.category_id, skills.item_index, skills.item_text,
                COALESCE(NULLIF(categories.label, ''), skills.category_id) AS label
           FROM candidate_profile_skill_items AS skills
           LEFT JOIN candidate_profile_skill_categories AS categories
             ON categories.tenant_id = skills.tenant_id
            AND categories.profile_id = skills.profile_id
            AND categories.category_id = skills.category_id
          WHERE skills.tenant_id = ? AND skills.profile_id = ?
            AND TRIM(skills.item_text) != ''
          ORDER BY categories.position_index, skills.item_index`
      : `SELECT category_id, item_index, item_text, category_id AS label
           FROM candidate_profile_skill_items
          WHERE tenant_id = ? AND profile_id = ?
            AND TRIM(item_text) != ''
          ORDER BY category_id, item_index`,
    [tenantId, "default"],
  );
  for (const row of rows) {
    const skillText = stringField(row.item_text).trim();
    if (!skillText) continue;
    const skillId = `skill:${row.category_id}:${row.item_index}`;
    const entry: EvidenceMapEntryPayload = {
      entryId: skillId,
      kind: "skill",
      evidenceId: null,
      skillId,
      title: skillText,
      story: null,
      skills: [skillText],
      tags: [stringField(row.label)].filter(Boolean),
      freshness: {
        evidenceDateRange: null,
        evidenceStrength: "declared",
        userConfirmed: true,
        claimConfidence: null,
        lastUsedAt: null,
      },
      resumeUsages: [],
      requirementUsages: [],
      coverageUsages: [],
      gaps: [],
    };
    entries.set(skillId, entry);
    const key = skillText.toLowerCase();
    const existing = byName.get(key) ?? [];
    existing.push(entry);
    byName.set(key, existing);
  }
  return byName;
}

function attachResumeUsages(
  db: SqliteDatabase,
  tenantId: string,
  entries: Map<string, EvidenceMapEntryPayload>,
): void {
  if (!tableExists(db, "job_bullet_provenance")) return;
  const jobMetadata = jobMetadataJoinSql(db, "provenance.job_url");
  const rows = allRows<BulletProvenanceRow & { job_title: string | null; employer: string | null }>(
    db,
    `SELECT provenance.job_url, provenance.artifact_id, provenance.generation,
            provenance.bullet_id, provenance.section, provenance.source_id,
            provenance.evidence_ids_json, provenance.requirement_ids_json,
            provenance.matched_keywords_json, provenance.transform_type,
            provenance.control, provenance.rationale, provenance.generated_text,
            provenance.position, provenance.created_at,
            ${jobMetadata.selectSql}
       FROM job_bullet_provenance AS provenance
       ${jobMetadata.joinSql}
      WHERE provenance.tenant_id = ?
        AND provenance.generation = (
          SELECT MAX(latest.generation)
            FROM job_bullet_provenance AS latest
           WHERE latest.tenant_id = provenance.tenant_id
             AND latest.job_url = provenance.job_url
        )
      ORDER BY provenance.job_url, provenance.position, provenance.bullet_id`,
    [tenantId],
  );
  for (const row of rows) {
    const usage: EvidenceUsagePayload = {
      kind: "resume_bullet",
      jobKey: row.job_url,
      jobTitle: nullableString(row.job_title),
      employer: nullableString(row.employer),
      artifactId: row.artifact_id,
      bulletId: row.bullet_id,
      generation: Number(row.generation),
      generatedTextPreview: previewText(row.generated_text, 240),
      scoreVersion: null,
      requirementId: null,
      requirementText: null,
      requirementFitKind: null,
      artifactCoverageState: null,
      keyword: null,
      coverageState: null,
      occurredAt: nullableString(row.created_at),
    };
    for (const evidenceId of parseStringList(parseJsonArray(row.evidence_ids_json))) {
      const entry = entries.get(evidenceId);
      if (!entry) continue;
      entry.resumeUsages.push(usage);
      if (!entry.freshness.lastUsedAt || (usage.occurredAt && usage.occurredAt > entry.freshness.lastUsedAt)) {
        entry.freshness.lastUsedAt = usage.occurredAt;
      }
    }
  }
}

function attachRequirementUsagesAndGaps(
  db: SqliteDatabase,
  tenantId: string,
  entries: Map<string, EvidenceMapEntryPayload>,
  gaps: Map<string, EvidenceGapPayload>,
): void {
  if (!tableExists(db, "job_requirement_fit_reports") || !tableExists(db, "job_requirement_fit_items")) return;
  const jobMetadata = jobMetadataJoinSql(db, "items.job_url");
  const rows = allRows<RequirementFitItemRow & {
    job_url: string;
    score_version: number;
    job_title: string | null;
    employer: string | null;
  }>(
    db,
    `SELECT items.job_url, items.score_version, items.requirement_id,
            items.requirement_text, items.tier, items.weight, items.job_evidence_span,
            items.fit_json, items.contribution_json, items.tailoring_json,
            items.artifact_coverage_json,
            ${jobMetadata.selectSql}
       FROM job_requirement_fit_items AS items
       ${jobMetadata.joinSql}
      WHERE items.tenant_id = ?
        AND items.score_version = (
          SELECT MAX(report.score_version)
            FROM job_requirement_fit_reports AS report
           WHERE report.tenant_id = items.tenant_id
             AND report.job_url = items.job_url
        )
      ORDER BY items.job_url, items.position, items.requirement_id`,
    [tenantId],
  );
  for (const row of rows) {
    const fit = requirementFitStatusToReadModel(parseJsonObject(row.fit_json));
    const fitKind = stringField(fit.kind || "not_assessed");
    const coverage = row.artifact_coverage_json
      ? requirementArtifactCoverageToReadModel(parseJsonObject(row.artifact_coverage_json))
      : null;
    const usage: EvidenceUsagePayload = {
      kind: "requirement_fit",
      jobKey: row.job_url,
      jobTitle: nullableString(row.job_title),
      employer: nullableString(row.employer),
      artifactId: null,
      bulletId: null,
      generation: null,
      generatedTextPreview: null,
      scoreVersion: Number(row.score_version),
      requirementId: row.requirement_id,
      requirementText: row.requirement_text,
      requirementFitKind: fitKind,
      artifactCoverageState: coverage ? stringField(coverage.state) : null,
      keyword: null,
      coverageState: null,
      occurredAt: null,
    };
    for (const evidenceId of parseStringList(fit.evidenceIds)) {
      const entry = entries.get(evidenceId);
      if (entry) entry.requirementUsages.push(usage);
    }
    if (fitKind === "missing" || fitKind === "blocked" || fitKind === "transferable") {
      const kind =
        fitKind === "blocked"
          ? "blocked_requirement"
          : fitKind === "transferable"
            ? "transferable_requirement"
            : "missing_requirement";
      const reason =
        stringField(fit.reason) || stringField(fit.blocker) || stringField(fit.gap) || "Recorded requirement gap.";
      const gap: EvidenceGapPayload = {
        gapId: `${row.job_url}#${row.requirement_id}`,
        kind,
        requirementId: row.requirement_id,
        requirementText: row.requirement_text,
        demandedSkill: null,
        tier: row.tier,
        weight: nullableNumber(row.weight),
        fitKind,
        reason,
        jobRefs: [usage],
      };
      gaps.set(gap.gapId, gap);
    }
  }
}

function attachSkillCoverageUsagesAndGaps(
  db: SqliteDatabase,
  tenantId: string,
  entries: Map<string, EvidenceMapEntryPayload>,
  skillEntriesByName: Map<string, EvidenceMapEntryPayload[]>,
  gaps: Map<string, EvidenceGapPayload>,
): void {
  if (!tableExists(db, "artifact_list_projections")) return;
  const rows = allRows<{
    job_id: string;
    job_title: string;
    job_employer: string;
    artifact_id: string;
    generation: number | null;
    coverage_audit_json: string | null;
    created_at: string | null;
  }>(
    db,
    `SELECT job_id, job_title, job_employer, artifact_id, generation,
            coverage_audit_json, created_at
       FROM artifact_list_projections
      WHERE tenant_id = ?
        AND coverage_audit_json IS NOT NULL
        AND TRIM(coverage_audit_json) != ''`,
    [tenantId],
  );
  for (const row of rows) {
    const coverage = parseJsonObject(row.coverage_audit_json);
    for (const state of ["covered", "declared"] as const) {
      for (const keyword of parseStringList(coverage[state])) {
        const skillEntries = skillEntriesByName.get(keyword.toLowerCase()) ?? [];
        for (const entry of skillEntries) {
          entry.coverageUsages.push({
            kind: "skill_coverage",
            jobKey: row.job_id,
            jobTitle: nullableString(row.job_title),
            employer: nullableString(row.job_employer),
            artifactId: row.artifact_id,
            bulletId: null,
            generation: nullableNumber(row.generation),
            generatedTextPreview: null,
            scoreVersion: null,
            requirementId: null,
            requirementText: null,
            requirementFitKind: null,
            artifactCoverageState: null,
            keyword,
            coverageState: state,
            occurredAt: nullableString(row.created_at),
          });
        }
      }
    }
    for (const keyword of parseStringList(coverage.missing)) {
      const gap: EvidenceGapPayload = {
        gapId: `${row.job_id}#skill#${keyword.toLowerCase()}`,
        kind: "missing_skill",
        requirementId: null,
        requirementText: keyword,
        demandedSkill: keyword,
        tier: null,
        weight: null,
        fitKind: null,
        reason: "The generated coverage audit recorded this demanded skill as missing from shipped materials.",
        jobRefs: [
          {
            kind: "skill_coverage",
            jobKey: row.job_id,
            jobTitle: nullableString(row.job_title),
            employer: nullableString(row.job_employer),
            artifactId: row.artifact_id,
            bulletId: null,
            generation: nullableNumber(row.generation),
            generatedTextPreview: null,
            scoreVersion: null,
            requirementId: null,
            requirementText: null,
            requirementFitKind: null,
            artifactCoverageState: null,
            keyword,
            coverageState: "missing",
            occurredAt: nullableString(row.created_at),
          },
        ],
      };
      gaps.set(gap.gapId, gap);
      for (const entry of skillEntriesByName.get(keyword.toLowerCase()) ?? []) {
        entry.gaps.push(gap);
      }
    }
  }
}

function parseAnalysisAgreement(value: string | null): {
  score: number;
  flagged_requirements: string[];
  flagged_keywords: string[];
} {
  const parsed = parseJsonObject(value);
  return {
    score: typeof parsed.score === "number" ? parsed.score : 0.0,
    flagged_requirements: Array.isArray(parsed.flagged_requirements)
      ? (parsed.flagged_requirements as string[])
      : [],
    flagged_keywords: Array.isArray(parsed.flagged_keywords) ? (parsed.flagged_keywords as string[]) : [],
  };
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

interface ScoreBreakdownLatest {
  technicalFit: number;
  experienceFit: number;
  roleFit: number;
  reasoning: string;
  fitBand: string;
  confidence: string;
  eligibility: {
    status: string;
    hardBlockers: string[];
    warnings: string[];
  };
  matchedSignals: string[];
  missingSignals: string[];
  transferableSignals: string[];
}

interface ScoreLatest {
  fitScore: number | null;
  breakdown: ScoreBreakdownLatest | null;
  keywords: string[];
  reasoning: string;
  version: number | null;
  scoredAt: string | null;
  criteriaJson: string | null;
  traceJson: string | null;
  correctionJson: string | null;
}

function loadLatestScore(db: SqliteDatabase, jobUrl: string): ScoreLatest {
  if (!tableExists(db, "job_scores")) {
    return emptyScore();
  }
  const row = getRow<{
    fit_score: number;
    version: number;
    breakdown_json: string | null;
    keywords_json: string | null;
    scored_at: string | null;
    correction_json: string | null;
    criteria_json: string | null;
    trace_json: string | null;
  }>(
    db,
    `SELECT fit_score, version, breakdown_json, keywords_json, scored_at,
            correction_json, criteria_json, trace_json
     FROM job_scores WHERE job_url = ? ORDER BY version DESC LIMIT 1`,
    [jobUrl],
  );
  if (!row) {
    return emptyScore();
  }
  const parsedBreakdown = parseScoreBreakdown(row.breakdown_json);
  const keywords = parseScoreKeywords(row.keywords_json);
  return {
    fitScore: Number(row.fit_score),
    breakdown: parsedBreakdown.legacy ? null : parsedBreakdown.breakdown,
    keywords: parsedBreakdown.legacy && keywords.length === 1 && keywords[0] === "legacy" ? [] : keywords,
    reasoning: parsedBreakdown.reasoning,
    version: nullableNumber(row.version),
    scoredAt: nullableString(row.scored_at),
    criteriaJson: row.criteria_json,
    traceJson: row.trace_json,
    correctionJson: row.correction_json,
  };
}

function emptyScore(): ScoreLatest {
  return {
    fitScore: null,
    breakdown: null,
    keywords: [],
    reasoning: "",
    version: null,
    scoredAt: null,
    criteriaJson: null,
    traceJson: null,
    correctionJson: null,
  };
}

function parseScoreBreakdown(
  value: string | null,
): { breakdown: ScoreBreakdownLatest | null; reasoning: string; legacy: boolean } {
  let parsed: unknown = null;
  try {
    parsed = value ? JSON.parse(value) : null;
  } catch {
    return { breakdown: null, reasoning: "", legacy: false };
  }
  if (!parsed || typeof parsed !== "object") {
    return { breakdown: null, reasoning: "", legacy: false };
  }
  const record = parsed as Record<string, unknown>;
  const reasoning = typeof record.reasoning === "string" ? record.reasoning : "";
  if (record.legacy === true) {
    return { breakdown: null, reasoning, legacy: true };
  }
  return {
    breakdown: {
      technicalFit: scoreDimension(record.technical_fit ?? record.technicalFit),
      experienceFit: scoreDimension(record.experience_fit ?? record.experienceFit),
      roleFit: scoreDimension(record.role_fit ?? record.roleFit),
      reasoning,
      fitBand: stringChoice(record.fit_band ?? record.fitBand, "plausible"),
      confidence: stringChoice(record.confidence, "medium"),
      eligibility: parseEligibility(record.eligibility),
      matchedSignals: parseStringList(record.matched_signals ?? record.matchedSignals),
      missingSignals: parseStringList(record.missing_signals ?? record.missingSignals),
      transferableSignals: parseStringList(record.transferable_signals ?? record.transferableSignals),
    },
    reasoning,
    legacy: false,
  };
}

function parseEligibility(value: unknown): ScoreBreakdownLatest["eligibility"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "unknown", hardBlockers: [], warnings: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    status: stringChoice(record.status, "unknown"),
    hardBlockers: parseStringList(record.hard_blockers ?? record.hardBlockers),
    warnings: parseStringList(record.warnings),
  };
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const text = String(raw ?? "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function stringChoice(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function parseScoreKeywords(value: string | null): string[] {
  let parsed: unknown = [];
  try {
    parsed = value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parsed) {
    const keyword = String(raw ?? "").trim();
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  return out;
}

function scoreDimension(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 10) return 10;
  return Math.trunc(n);
}

interface EnrichmentLatest {
  fullDescription: string | null;
  applicationUrl: string | null;
  enrichedAt: string | null;
  currentStatus: string | null;
}

function loadEnrichment(db: SqliteDatabase, jobUrl: string): EnrichmentLatest {
  const empty: EnrichmentLatest = {
    fullDescription: null,
    applicationUrl: null,
    enrichedAt: null,
    currentStatus: null,
  };
  if (!tableExists(db, "job_enrichments")) {
    return empty;
  }
  const row = getRow<{
    full_description: string | null;
    application_url: string | null;
    enriched_at: string | null;
    current_status: string | null;
  }>(
    db,
    "SELECT full_description, application_url, enriched_at, current_status FROM job_enrichments WHERE job_url = ?",
    [jobUrl],
  );
  if (!row) return empty;
  return {
    fullDescription: row.full_description,
    applicationUrl: row.application_url,
    enrichedAt: row.enriched_at,
    currentStatus: row.current_status,
  };
}

interface ApplyLatest {
  runId: string | null;
  status: string | null;
  result: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  workerId: number | null;
  model: string | null;
  dryRun: boolean;
  durationMs: number | null;
}

function loadLatestApplyRun(db: SqliteDatabase, jobUrl: string): ApplyLatest {
  const empty: ApplyLatest = {
    runId: null,
    status: null,
    result: null,
    startedAt: null,
    finishedAt: null,
    workerId: null,
    model: null,
    dryRun: false,
    durationMs: null,
  };
  if (!tableExists(db, "apply_run_projections")) return empty;
  const row = getRow<Record<string, unknown>>(
    db,
    `SELECT run_id, status, result, started_at, finished_at, worker_id,
            model, dry_run, duration_ms
     FROM apply_run_projections WHERE job_id = ?
     ORDER BY started_at DESC, run_id DESC LIMIT 1`,
    [jobUrl],
  );
  if (!row) return empty;
  return {
    runId: nullableString(row.run_id),
    status: nullableString(row.status),
    result: nullableString(row.result),
    startedAt: nullableString(row.started_at),
    finishedAt: nullableString(row.finished_at),
    workerId: nullableNumber(row.worker_id),
    model: nullableString(row.model),
    dryRun: Boolean(row.dry_run),
    durationMs: nullableNumber(row.duration_ms),
  };
}

function loadDeletedAt(db: SqliteDatabase, jobUrl: string): string | null {
  if (!tableExists(db, "jobhunter_deleted_jobs")) return null;
  const row = getRow<{ deleted_at: string | null }>(
    db,
    "SELECT deleted_at FROM jobhunter_deleted_jobs WHERE job_url = ? AND (restored_at IS NULL OR julianday(restored_at) <= julianday(deleted_at))",
    [jobUrl],
  );
  return row ? nullableString(row.deleted_at) : null;
}

function staleDeletedProjectionJobs(db: SqliteDatabase, tenantId: string): string[] {
  if (!tableExists(db, "jobhunter_deleted_jobs")) return [];
  const rows = allRows<{ job_id: string }>(
    db,
    `SELECT p.job_id
     FROM job_list_projections p
     JOIN jobhunter_deleted_jobs d
       ON d.job_url = p.job_id
     WHERE p.tenant_id = ?
       AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
       AND (p.deleted_at IS NULL OR p.deleted_at != d.deleted_at)`,
    [tenantId],
  );
  return rows.map((row) => row.job_id).filter(Boolean);
}

function staleArtifactMetadataProjectionJobs(db: SqliteDatabase, tenantId: string): string[] {
  if (
    !tableExists(db, "jobs") ||
    !tableExists(db, "artifact_list_projections") ||
    !tableExists(db, "job_materials_artifacts")
  ) {
    return [];
  }
  if (
    !hasColumn(db, "artifact_list_projections", "metadata_json") ||
    !hasColumn(db, "job_materials_artifacts", "metadata_json")
  ) {
    return [];
  }

  const rows = allRows<{ job_id: string }>(
    db,
    `SELECT DISTINCT a.job_url AS job_id
       FROM job_materials_artifacts a
       LEFT JOIN artifact_list_projections p
         ON p.tenant_id = ?
        AND p.job_id = a.job_url
        AND p.artifact_id = COALESCE(NULLIF(a.artifact_id, ''), a.artifact_type || ':' || a.path)
      WHERE a.artifact_type IN ('tailored_resume', 'tailored_resume_txt')
        AND a.path IS NOT NULL
        AND TRIM(a.path) != ''
        AND a.metadata_json IS NOT NULL
        AND TRIM(a.metadata_json) != ''
        AND TRIM(a.metadata_json) != '{}'
        AND (
          p.artifact_id IS NULL
          OR p.metadata_json IS NULL
          OR TRIM(p.metadata_json) != TRIM(a.metadata_json)
        )`,
    [tenantId],
  );
  return rows.map((row) => row.job_id).filter(Boolean);
}

interface StageRow extends Record<string, unknown> {
  stage: string;
  state: string;
  attempt_count: number | null;
  max_attempts: number | null;
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  retryable: number | null;
  blocked_by_json: string | null;
  next_action: string | null;
}

interface NormalizedStage {
  stage: string;
  state: string;
  attempt_count: number;
  max_attempts: number | null;
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  retryable: boolean;
  blocked_by: string[];
  next_action: string | null;
}

function loadStages(db: SqliteDatabase, jobUrl: string): NormalizedStage[] {
  const explicit = new Map<string, StageRow>();
  if (tableExists(db, "job_stage_states")) {
    for (const row of allRows<StageRow>(
      db,
      "SELECT * FROM job_stage_states WHERE job_url = ?",
      [jobUrl],
    )) {
      if (row.stage) explicit.set(String(row.stage), row);
    }
  }
  return STAGE_ORDER.map((stage) => {
    const row = explicit.get(stage);
    if (!row) {
      return {
        stage,
        state: "pending",
        attempt_count: 0,
        max_attempts: DEFAULT_MAX_ATTEMPTS[stage] ?? null,
        started_at: null,
        updated_at: null,
        finished_at: null,
        duration_ms: null,
        error_code: null,
        error_message: null,
        retryable: true,
        blocked_by: [],
        next_action: null,
      };
    }
    let blockedBy: string[] = [];
    if (row.blocked_by_json) {
      try {
        const parsed: unknown = JSON.parse(row.blocked_by_json);
        if (Array.isArray(parsed)) blockedBy = parsed.map((item) => String(item));
      } catch {
        blockedBy = [];
      }
    }
    return {
      stage: String(row.stage ?? stage),
      state: String(row.state ?? "pending"),
      attempt_count: Number(row.attempt_count ?? 0),
      max_attempts:
        row.max_attempts === null || row.max_attempts === undefined
          ? (DEFAULT_MAX_ATTEMPTS[stage] ?? null)
          : Number(row.max_attempts),
      started_at: nullableString(row.started_at),
      updated_at: nullableString(row.updated_at),
      finished_at: nullableString(row.finished_at),
      duration_ms: nullableNumber(row.duration_ms),
      error_code: nullableString(row.error_code),
      error_message: nullableString(row.error_message),
      retryable: row.retryable === null || row.retryable === undefined ? true : Boolean(row.retryable),
      blocked_by: blockedBy,
      next_action: nullableString(row.next_action),
    };
  });
}

function jobListStage(stage: string | null | undefined, hasResume = false): "discover" | "apply" {
  return stage === "apply" || (stage === "cover" && hasResume) ? "apply" : "discover";
}

function rebuildJobProjections(db: SqliteDatabase, tenantId: string, jobUrl: string): void {
  const job = getRow<Record<string, unknown>>(db, "SELECT * FROM jobs WHERE url = ?", [jobUrl]);
  if (!job) {
    db.prepare("DELETE FROM job_list_projections WHERE tenant_id = ? AND job_id = ?").run(
      tenantId,
      jobUrl,
    );
    db.prepare("DELETE FROM job_detail_projections WHERE tenant_id = ? AND job_id = ?").run(
      tenantId,
      jobUrl,
    );
    db.prepare("DELETE FROM artifact_list_projections WHERE tenant_id = ? AND job_id = ?").run(
      tenantId,
      jobUrl,
    );
    return;
  }

  const score = loadLatestScore(db, jobUrl);
  const materials = loadLatestMaterials(db, jobUrl);
  const employerAnalysisJson = loadEmployerAnalysisJson(db, jobUrl);
  const requirementFitReportJson = loadRequirementFitReportJson(db, tenantId, jobUrl);
  const interviewPrepJson = loadInterviewPrepJson(db, tenantId, jobUrl);
  const enrichment = loadEnrichment(db, jobUrl);
  const apply = loadLatestApplyRun(db, jobUrl);
  const deletedAt = loadDeletedAt(db, jobUrl);
  const stages = loadStages(db, jobUrl);

  const title = stringField(job.title) || "Untitled";
  const site = stringField(job.site);
  const applicationUrl = enrichment.applicationUrl ?? nullableString(job.application_url);
  const employer = stringField(job.company) || companyName(site, applicationUrl ?? jobUrl);

  const firstActionable =
    stages.find((s) => !["succeeded", "skipped"].includes(s.state)) ?? stages[stages.length - 1];

  const fitScore = score.fitScore ?? nullableNumber(job.fit_score);
  const scoreReasoning = score.reasoning || stringField(job.score_reasoning);
  const scoreBreakdownJson = score.breakdown ? JSON.stringify(score.breakdown) : null;
  const scoreKeywordsJson = JSON.stringify(score.keywords);
  const compensationProjection = buildCompensationProjection(db, jobUrl);

  const hasCanonicalMaterials = materials.hasCanonicalHistory;
  const tailorPath = hasCanonicalMaterials ? materials.tailorPath : nullableString(job.tailored_resume_path);
  const coverPath = hasCanonicalMaterials ? materials.coverPath : nullableString(job.cover_letter_path);
  const hasResume = Boolean(tailorPath);
  const hasCoverLetter = Boolean(coverPath);
  const hasPdf = Boolean(materials.resumePdfPath ?? materials.coverPdfPath);

  const applyStatus = deriveApplyStatus(apply.status, nullableString(job.apply_status));
  const appliedAt = apply.status === "succeeded" ? apply.finishedAt : nullableString(job.applied_at);

  const description = stringField(job.description);
  const fullDescription = enrichment.fullDescription ?? stringField(job.full_description);

  const lastUpdatedAt = new Date().toISOString();

  const artifacts = collectArtifacts(db, jobUrl, materials);
  const provenanceByArtifact = loadBulletProvenanceByArtifact(db, tenantId, jobUrl);
  const { coverage: coverageByArtifact, voice: voiceByArtifact } = loadProvenanceAuxByArtifact(
    db,
    tenantId,
    jobUrl,
  );
  const activeArtifacts = artifacts.filter(isDefaultVisibleArtifact);

  db.prepare(
    `INSERT INTO job_list_projections (
     tenant_id, job_id, title, employer, source, strategy, location,
     salary, application_url, discovered_at, description, full_description,
       fit_score, compensation_summary_json,
       score_breakdown_json, score_keywords_json, score_reasoning,
       score_version, scored_at, score_criteria_json, score_trace_json,
       score_correction_json, current_stage, current_substage, current_state,
       current_error_code, current_error_message, current_next_action,
       has_resume, has_cover_letter, has_pdf, apply_status, applied_at,
       artifact_count, deleted_at, last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, job_id) DO UPDATE SET
       title                 = excluded.title,
       employer              = excluded.employer,
       source                = excluded.source,
       strategy              = excluded.strategy,
       location              = excluded.location,
       salary                = excluded.salary,
       application_url       = excluded.application_url,
       discovered_at         = excluded.discovered_at,
       description           = excluded.description,
       full_description      = excluded.full_description,
       fit_score             = excluded.fit_score,
       compensation_summary_json = excluded.compensation_summary_json,
       score_breakdown_json  = excluded.score_breakdown_json,
       score_keywords_json   = excluded.score_keywords_json,
       score_reasoning       = excluded.score_reasoning,
       score_version         = excluded.score_version,
       scored_at             = excluded.scored_at,
       score_criteria_json   = excluded.score_criteria_json,
       score_trace_json      = excluded.score_trace_json,
       score_correction_json = excluded.score_correction_json,
       current_stage         = excluded.current_stage,
       current_substage      = excluded.current_substage,
       current_state         = excluded.current_state,
       current_error_code    = excluded.current_error_code,
       current_error_message = excluded.current_error_message,
       current_next_action   = excluded.current_next_action,
       has_resume            = excluded.has_resume,
       has_cover_letter      = excluded.has_cover_letter,
       has_pdf               = excluded.has_pdf,
       apply_status          = excluded.apply_status,
       applied_at            = excluded.applied_at,
       artifact_count        = excluded.artifact_count,
       deleted_at            = excluded.deleted_at,
       last_updated_at       = excluded.last_updated_at`,
  ).run(
    tenantId,
    jobUrl,
    title,
    employer,
    site || "unknown",
    stringField(job.strategy),
    normalizeJobLocation(stringField(job.location)),
    stringField(job.salary),
    applicationUrl,
    nullableString(job.discovered_at),
    description,
    fullDescription,
    fitScore,
    compensationProjection.summaryJson,
    scoreBreakdownJson,
    scoreKeywordsJson,
    scoreReasoning,
    score.version,
    score.scoredAt,
    score.criteriaJson,
    score.traceJson,
    score.correctionJson,
    jobListStage(firstActionable?.stage, hasResume),
    firstActionable?.stage ?? "discover",
    firstActionable?.state ?? "pending",
    firstActionable?.error_code ?? null,
    firstActionable?.error_message ?? null,
    firstActionable?.next_action ?? null,
    hasResume ? 1 : 0,
    hasCoverLetter ? 1 : 0,
    hasPdf ? 1 : 0,
    applyStatus,
    appliedAt,
    activeArtifacts.length,
    deletedAt,
    lastUpdatedAt,
  );

  db.prepare(
    `INSERT INTO job_detail_projections (
       tenant_id, job_id, description_preview, compensation_summary_json,
       compensation_audit_json, score_breakdown_json, score_keywords_json,
       score_reasoning, score_version, scored_at,
       score_criteria_json, score_trace_json, score_correction_json,
       stages_json, employer_analysis_json, requirement_fit_report_json,
       interview_prep_json,
       last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, job_id) DO UPDATE SET
       description_preview    = excluded.description_preview,
       compensation_summary_json = excluded.compensation_summary_json,
       compensation_audit_json = excluded.compensation_audit_json,
       score_breakdown_json   = excluded.score_breakdown_json,
       score_keywords_json    = excluded.score_keywords_json,
       score_reasoning        = excluded.score_reasoning,
       score_version          = excluded.score_version,
       scored_at              = excluded.scored_at,
       score_criteria_json    = excluded.score_criteria_json,
       score_trace_json       = excluded.score_trace_json,
       score_correction_json  = excluded.score_correction_json,
       stages_json            = excluded.stages_json,
       employer_analysis_json = excluded.employer_analysis_json,
       requirement_fit_report_json = excluded.requirement_fit_report_json,
       interview_prep_json    = excluded.interview_prep_json,
       last_updated_at        = excluded.last_updated_at`,
  ).run(
    tenantId,
    jobUrl,
    previewText(fullDescription || description, 6000),
    compensationProjection.summaryJson,
    compensationProjection.auditJson,
    scoreBreakdownJson,
    scoreKeywordsJson,
    scoreReasoning,
    score.version,
    score.scoredAt,
    score.criteriaJson,
    score.traceJson,
    score.correctionJson,
    JSON.stringify(stages),
    employerAnalysisJson,
    requirementFitReportJson,
    interviewPrepJson,
    lastUpdatedAt,
  );

  db.prepare("DELETE FROM artifact_list_projections WHERE tenant_id = ? AND job_id = ?").run(
    tenantId,
    jobUrl,
  );
  const insertArtifact = db.prepare(
    `INSERT INTO artifact_list_projections (
       artifact_id, tenant_id, job_id, job_title, job_employer, artifact_type,
       status, local_path, size_bytes, created_at, generation, metadata_json,
       layout_boxes_json, bullet_provenance_json, coverage_audit_json, voice_pass_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const layoutBoxesByArtifact = loadLayoutBoxesByArtifact(db, tenantId, jobUrl);
  for (const a of artifacts) {
    insertArtifact.run(
      a.artifactId,
      tenantId,
      jobUrl,
      title,
      employer,
      a.artifactType,
      a.status,
      a.localPath,
      a.sizeBytes,
      a.createdAt,
      a.generation,
      a.metadataJson,
      layoutBoxesByArtifact.get(a.artifactId) ?? null,
      provenanceByArtifact.get(a.artifactId) ?? null,
      coverageByArtifact.get(a.artifactId) ?? null,
      voiceByArtifact.get(a.artifactId) ?? null,
    );
  }
}

function loadLayoutBoxesByArtifact(
  db: SqliteDatabase,
  tenantId: string,
  jobUrl: string,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!tableExists(db, "job_material_layout_boxes")) return result;
  const rows = allRows<{
    artifact_id: string;
    semantic_id: string;
    page_number: number;
    line_number: number | null;
    text_excerpt: string;
    left_pct: number;
    top_pct: number;
    width_pct: number;
    height_pct: number;
  }>(
    db,
    `SELECT artifact_id, semantic_id, page_number, line_number, text_excerpt,
            left_pct, top_pct, width_pct, height_pct
       FROM job_material_layout_boxes
      WHERE tenant_id = ? AND job_url = ?
      ORDER BY artifact_id, page_number, box_index`,
    [tenantId, jobUrl],
  );
  const byArtifact = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const artifactId = String(row.artifact_id || "");
    if (!artifactId) continue;
    const boxes = byArtifact.get(artifactId) ?? [];
    boxes.push({
      semanticId: String(row.semantic_id || ""),
      pageNumber: Number(row.page_number || 1),
      lineNumber: row.line_number === null || row.line_number === undefined ? null : Number(row.line_number),
      textExcerpt: String(row.text_excerpt || ""),
      leftPct: Number(row.left_pct || 0),
      topPct: Number(row.top_pct || 0),
      widthPct: Number(row.width_pct || 0),
      heightPct: Number(row.height_pct || 0),
    });
    byArtifact.set(artifactId, boxes);
  }
  for (const [artifactId, boxes] of byArtifact) {
    result.set(artifactId, JSON.stringify(boxes));
  }
  return result;
}

type PostedCompensationProjectionResponse = NonNullable<ReturnType<typeof getPostedCompensationFact>>;
type MarketCompensationProjectionResponse = NonNullable<ReturnType<typeof getMarketCompensationEstimate>>;

interface CompensationRangeSummary {
  currency: string | null;
  period: string;
  component: string;
  minimumAmount: number | null;
  maximumAmount: number | null;
  annualizedMinimumAmount?: number | null;
  annualizedMaximumAmount?: number | null;
  annualizedMinimumEur?: number | null;
  annualizedMaximumEur?: number | null;
  displayRange: string | null;
}

interface CompensationProjectionPair {
  summaryJson: string;
  auditJson: string;
}

function buildCompensationProjection(db: SqliteDatabase, jobUrl: string): CompensationProjectionPair {
  const posted =
    getPostedCompensationFact(db, jobUrl) ??
    ({
      ok: true,
      recordStatus: "not_recorded",
      jobKey: jobUrl,
      legacyRawSalary: null,
    } as const);
  const market =
    getMarketCompensationEstimate(db, jobUrl) ??
    ({
      ok: true,
      recordStatus: "not_requested",
      jobKey: jobUrl,
    } as const);
  const summary = buildCompensationSummary(posted, market);
  return {
    summaryJson: JSON.stringify(summary),
    auditJson: JSON.stringify({
      projectionVersion: COMPENSATION_PROJECTION_VERSION,
      posted,
      market,
    }),
  };
}

function buildCompensationSummary(
  posted: PostedCompensationProjectionResponse,
  market: MarketCompensationProjectionResponse,
): Record<string, unknown> {
  const postedWarnings = posted.recordStatus === "recorded" ? posted.fact.warnings.length : 0;
  const marketWarnings = market.recordStatus === "recorded" ? market.estimate.warnings.length : 0;
  const postedRange = posted.recordStatus === "recorded" ? postedRangeSummary(posted.fact) : null;
  const marketRange = market.recordStatus === "recorded" ? marketRangeSummary(market.estimate) : null;
  const marketConfidenceInterval =
    market.recordStatus === "recorded" ? marketConfidenceIntervalSummary(market.estimate) : null;
  return {
    projectionVersion: COMPENSATION_PROJECTION_VERSION,
    legacyRawSalary:
      posted.recordStatus === "recorded" ? posted.fact.legacyRawSalary : posted.legacyRawSalary,
    warningCount: postedWarnings + marketWarnings,
    posted: {
      sourceKind: "posted",
      recordStatus: posted.recordStatus,
      parseState: posted.recordStatus === "recorded" ? posted.fact.parseState : null,
      confidence: posted.recordStatus === "recorded" ? posted.fact.confidence : "none",
      warningCount: postedWarnings,
      range: postedRange,
      displayRange: postedRange?.displayRange ?? null,
    },
    market: {
      sourceKind: "reported_company_role_market",
      recordStatus: market.recordStatus,
      estimateState: market.recordStatus === "recorded" ? market.estimate.estimateState : "not_requested",
      confidenceBand: market.recordStatus === "recorded" ? market.estimate.confidenceBand : "none",
      confidenceScore: market.recordStatus === "recorded" ? market.estimate.confidenceScore : null,
      sourceCount: market.recordStatus === "recorded" ? market.estimate.sourceCount : 0,
      sampleCount: market.recordStatus === "recorded" ? market.estimate.sampleCount : null,
      warningCount: marketWarnings,
      range: marketRange,
      displayRange: marketRange?.displayRange ?? null,
      confidenceInterval: marketConfidenceInterval,
      displayConfidenceInterval: marketConfidenceInterval?.displayRange ?? null,
    },
  };
}

function postedRangeSummary(
  fact: Extract<PostedCompensationProjectionResponse, { recordStatus: "recorded" }>["fact"],
): CompensationRangeSummary | null {
  if (fact.parseState !== "parsed_range") {
    return null;
  }
  return {
    currency: fact.currency,
    period: fact.period,
    component: fact.component,
    minimumAmount: fact.minimumAmount,
    maximumAmount: fact.maximumAmount,
    annualizedMinimumAmount: fact.annualizedMinimumAmount,
    annualizedMaximumAmount: fact.annualizedMaximumAmount,
    annualizedMinimumEur: normalizeAnnualizedEur(fact.annualizedMinimumAmount, fact.currency),
    annualizedMaximumEur: normalizeAnnualizedEur(fact.annualizedMaximumAmount, fact.currency),
    displayRange: formatCompensationRange(fact.currency, fact.minimumAmount, fact.maximumAmount, fact.period),
  };
}

function marketRangeSummary(
  estimate: Extract<MarketCompensationProjectionResponse, { recordStatus: "recorded" }>["estimate"],
): CompensationRangeSummary | null {
  if (estimate.estimateState !== "estimated_range") {
    return null;
  }
  return {
    currency: estimate.currency,
    period: estimate.period,
    component: estimate.component,
    minimumAmount: estimate.minimumAmount,
    maximumAmount: estimate.maximumAmount,
    annualizedMinimumAmount: annualizeCompensationAmount(estimate.minimumAmount, estimate.period),
    annualizedMaximumAmount: annualizeCompensationAmount(estimate.maximumAmount, estimate.period),
    annualizedMinimumEur: normalizeAnnualizedEur(
      annualizeCompensationAmount(estimate.minimumAmount, estimate.period),
      estimate.currency,
    ),
    annualizedMaximumEur: normalizeAnnualizedEur(
      annualizeCompensationAmount(estimate.maximumAmount, estimate.period),
      estimate.currency,
    ),
    displayRange: formatCompensationRange(
      estimate.currency,
      estimate.minimumAmount,
      estimate.maximumAmount,
      estimate.period,
    ),
  };
}

function marketConfidenceIntervalSummary(
  estimate: Extract<MarketCompensationProjectionResponse, { recordStatus: "recorded" }>["estimate"],
): CompensationRangeSummary | null {
  if (estimate.estimateState !== "estimated_range") {
    return null;
  }
  return {
    currency: estimate.currency,
    period: estimate.period,
    component: estimate.component,
    minimumAmount: estimate.confidenceInterval.minimumAmount,
    maximumAmount: estimate.confidenceInterval.maximumAmount,
    annualizedMinimumAmount: annualizeCompensationAmount(
      estimate.confidenceInterval.minimumAmount,
      estimate.period,
    ),
    annualizedMaximumAmount: annualizeCompensationAmount(
      estimate.confidenceInterval.maximumAmount,
      estimate.period,
    ),
    annualizedMinimumEur: normalizeAnnualizedEur(
      annualizeCompensationAmount(estimate.confidenceInterval.minimumAmount, estimate.period),
      estimate.currency,
    ),
    annualizedMaximumEur: normalizeAnnualizedEur(
      annualizeCompensationAmount(estimate.confidenceInterval.maximumAmount, estimate.period),
      estimate.currency,
    ),
    displayRange: formatCompensationRange(
      estimate.currency,
      estimate.confidenceInterval.minimumAmount,
      estimate.confidenceInterval.maximumAmount,
      estimate.period,
    ),
  };
}

const EUR_NORMALIZATION_RATES: Readonly<Record<string, number>> = {
  EUR: 1,
  USD: 0.92,
  GBP: 1.17,
  CHF: 1.06,
  SEK: 0.09,
  NOK: 0.087,
  DKK: 0.134,
  PLN: 0.235,
  CZK: 0.041,
};

function normalizeAnnualizedEur(amount: number | null | undefined, currency: string | null | undefined): number | null {
  if (!Number.isFinite(amount)) return null;
  const rate = currency ? EUR_NORMALIZATION_RATES[currency.toUpperCase()] : undefined;
  if (!rate) return null;
  return Math.round(Number(amount) * rate);
}

function annualizeCompensationAmount(amount: number | null, period: string): number | null {
  if (!Number.isFinite(amount)) return null;
  const value = Number(amount);
  if (period === "year") return value;
  if (period === "month") return value * 12;
  if (period === "hour") return value * 2080;
  return null;
}

function formatCompensationRange(
  currency: string | null,
  minimumAmount: number | null,
  maximumAmount: number | null,
  period: string,
): string | null {
  if (minimumAmount === null && maximumAmount === null) {
    return null;
  }
  const prefix = currency ? `${currency} ` : "";
  const suffix = period ? `/${period}` : "";
  if (minimumAmount !== null && maximumAmount !== null) {
    return minimumAmount === maximumAmount
      ? `${prefix}${minimumAmount}${suffix}`
      : `${prefix}${minimumAmount}-${maximumAmount}${suffix}`;
  }
  if (minimumAmount !== null) {
    return `${prefix}${minimumAmount}+${suffix}`;
  }
  return `${prefix}up to ${maximumAmount}${suffix}`;
}

interface ArtifactRow {
  artifactId: string;
  artifactType: string;
  status: string;
  localPath: string;
  sizeBytes: number | null;
  createdAt: string | null;
  generation: number | null;
  metadataJson: string | null;
}

function collectArtifacts(
  db: SqliteDatabase,
  jobUrl: string,
  materials: MaterialsLatest,
): ArtifactRow[] {
  const out: ArtifactRow[] = [];
  const seen = new Set<string>();
  if (tableExists(db, "job_materials_artifacts")) {
    const metadataSelect = hasColumn(db, "job_materials_artifacts", "metadata_json")
      ? "metadata_json"
      : "NULL AS metadata_json";
    const rows = allRows<{
      artifact_id: string;
      artifact_type: string;
      status: string;
      path: string;
      created_at: string | null;
      size_bytes: number | null;
      generation: number | null;
      metadata_json: string | null;
    }>(
      db,
      `SELECT artifact_id, artifact_type, status, path, created_at, size_bytes, generation, ${metadataSelect}
       FROM job_materials_artifacts WHERE job_url = ?`,
      [jobUrl],
    );
    for (const row of rows) {
      if (!row.path) continue;
      const key = `${row.artifact_type}:${row.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        artifactId: row.artifact_id || key,
        artifactType: row.artifact_type || "artifact",
        status: row.status || "active",
        localPath: row.path,
        sizeBytes: nullableNumber(row.size_bytes),
        createdAt: nullableString(row.created_at),
        generation: nullableNumber(row.generation),
        metadataJson: nullableString(row.metadata_json),
      });
    }
  }
  if (tableExists(db, "job_artifacts")) {
    const rows = allRows<{
      row_id: number | string;
      artifact_type: string;
      status: string;
      path: string;
      created_at: string | null;
      size_bytes: number | null;
    }>(
      db,
      `SELECT rowid AS row_id, artifact_type, status, path, created_at, size_bytes
       FROM job_artifacts WHERE job_url = ?`,
      [jobUrl],
    );
    for (const row of rows) {
      if (!row.path) continue;
      const key = `${row.artifact_type || "artifact"}:${row.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        artifactId: String(row.row_id ?? key),
        artifactType: row.artifact_type || "artifact",
        status: row.status || "active",
        localPath: row.path,
        sizeBytes: nullableNumber(row.size_bytes),
        createdAt: nullableString(row.created_at),
        generation: null,
        metadataJson: null,
      });
    }
  }
  // Derive PDF siblings for legacy txt artifacts whose registered PDF
  // doesn't exist as a separate row.  Mirrors the prior read-model.ts
  // behaviour so downstream consumers (web UI artifact list, tests)
  // still see the matching ``*_pdf`` row.  When a real PDF artifact is
  // registered we never overwrite it (``seen`` guards against
  // duplicates).
  const tailorSource = preferredArtifactSource(
    out,
    ["tailored_resume", "tailored_resume_txt"],
    materials.generation,
  );
  const tailorPdfPath =
    materials.resumePdfPath ??
    (tailorSource?.artifactType === "tailored_resume_txt"
      ? pdfSibling(tailorSource.localPath)
      : null);
  if (tailorPdfPath && !seen.has(`tailored_resume_pdf:${tailorPdfPath}`)) {
    seen.add(`tailored_resume_pdf:${tailorPdfPath}`);
    out.push({
      artifactId: `${jobUrl}:tailored_resume_pdf:${tailorPdfPath}`,
      artifactType: "tailored_resume_pdf",
      status: "active",
      localPath: tailorPdfPath,
      sizeBytes: null,
      createdAt: tailorSource?.createdAt ?? null,
      generation: null,
      metadataJson: tailorSource?.metadataJson ?? null,
    });
  }
  const coverSource = preferredArtifactSource(
    out,
    ["cover_letter", "cover_letter_txt"],
    materials.generation,
  );
  const coverPdfPath =
    materials.coverPdfPath ??
    (coverSource?.artifactType === "cover_letter_txt"
      ? pdfSibling(coverSource.localPath)
      : null);
  if (coverPdfPath && !seen.has(`cover_letter_pdf:${coverPdfPath}`)) {
    seen.add(`cover_letter_pdf:${coverPdfPath}`);
    out.push({
      artifactId: `${jobUrl}:cover_letter_pdf:${coverPdfPath}`,
      artifactType: "cover_letter_pdf",
      status: "active",
      localPath: coverPdfPath,
      sizeBytes: null,
      createdAt: coverSource?.createdAt ?? null,
      generation: null,
      metadataJson: coverSource?.metadataJson ?? null,
    });
  }
  return out;
}

function isDefaultVisibleArtifact(artifact: Pick<ArtifactRow, "status">): boolean {
  return String(artifact.status ?? "").toLowerCase() !== "suppressed";
}

function preferredArtifactSource(
  artifacts: ArtifactRow[],
  artifactTypes: string[],
  preferredGeneration: number | null,
): ArtifactRow | undefined {
  const typeSet = new Set(artifactTypes);
  return artifacts
    .filter((artifact) => typeSet.has(artifact.artifactType) && isDefaultVisibleArtifact(artifact))
    .sort((left, right) => {
      const leftPreferred = left.generation === preferredGeneration ? 1 : 0;
      const rightPreferred = right.generation === preferredGeneration ? 1 : 0;
      if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
      const leftStatus = artifactStatusRank(left.status);
      const rightStatus = artifactStatusRank(right.status);
      if (leftStatus !== rightStatus) return rightStatus - leftStatus;
      return Number(right.generation ?? -1) - Number(left.generation ?? -1);
    })[0];
}

function artifactStatusRank(status: string): number {
  switch (String(status ?? "").toLowerCase()) {
    case "approved":
    case "active":
      return 3;
    case "candidate":
      return 2;
    case "rejected":
      return 1;
    default:
      return 0;
  }
}

function pdfSibling(value: string | null | undefined): string | null {
  if (!value) return null;
  return `${value.replace(/\.[^.]+$/, "")}.pdf`;
}

// Score bands bucket ``fit_score`` by the user-facing scoring criteria in
// workers .../scoring/use_cases.py SCORE_PROMPT (9-10 perfect ... 1-2 poor). MUST
// stay byte-equivalent to the Python ``_score_band`` — the cross-runtime parity
// test asserts both builders write the same outcome_conversion_json.
const SCORE_BAND_ORDER = ["perfect", "strong", "moderate", "weak", "poor", "unscored"] as const;
// Outcome kinds that mark an applied job as having reached each funnel stage.
// Later stages imply earlier ones (an offer implies an interview and a reply).
const REPLY_OUTCOME_KINDS = new Set(["recruiter_reply", "interview", "assessment", "offer", "rejection"]);
const INTERVIEW_OUTCOME_KINDS = new Set(["interview", "assessment", "offer"]);
const OFFER_OUTCOME_KINDS = new Set(["offer"]);
const REJECTION_OUTCOME_KINDS = new Set(["rejection"]);

interface ConversionCounts {
  applied: number;
  reply: number;
  interview: number;
  offer: number;
  rejection: number;
}

interface OutcomeConversion {
  version: number;
  totals: ConversionCounts;
  bySource: Array<{ source: string } & ConversionCounts>;
  byBand: Array<{ band: string } & ConversionCounts>;
}

function scoreBand(fitScore: number | null | undefined): string {
  if (fitScore === null || fitScore === undefined) return "unscored";
  if (fitScore >= 9) return "perfect";
  if (fitScore >= 7) return "strong";
  if (fitScore >= 5) return "moderate";
  if (fitScore >= 3) return "weak";
  return "poor";
}

function hasAnyKind(kinds: Set<string>, target: Set<string>): boolean {
  for (const kind of kinds) if (target.has(kind)) return true;
  return false;
}

function loadOutcomeKindsByJob(db: SqliteDatabase, tenantId: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  if (!tableExists(db, "application_outcomes")) return result;
  const rows = allRows<{ job_key: string; kind: string }>(
    db,
    "SELECT job_key, kind FROM application_outcomes WHERE tenant_id = ?",
    [tenantId],
  );
  for (const row of rows) {
    if (!row.job_key || !row.kind) continue;
    const set = result.get(row.job_key) ?? new Set<string>();
    set.add(row.kind);
    result.set(row.job_key, set);
  }
  return result;
}

function buildOutcomeConversion(
  db: SqliteDatabase,
  tenantId: string,
  active: Array<{
    job_id: string;
    apply_status: string | null;
    applied_at: string | null;
    fit_score: number | null;
    source: string;
  }>,
): OutcomeConversion {
  const appliedRows = active.filter((row) => row.applied_at || row.apply_status === "applied");
  const outcomesByJob = loadOutcomeKindsByJob(db, tenantId);
  const blank = (): ConversionCounts => ({ applied: 0, reply: 0, interview: 0, offer: 0, rejection: 0 });
  const totals = blank();
  const bySource = new Map<string, ConversionCounts>();
  const byBand = new Map<string, ConversionCounts>();
  for (const row of appliedRows) {
    const source = row.source || "unknown";
    const band = scoreBand(row.fit_score === null || row.fit_score === undefined ? null : Number(row.fit_score));
    const kinds = outcomesByJob.get(row.job_id) ?? new Set<string>();
    let sourceBucket = bySource.get(source);
    if (!sourceBucket) {
      sourceBucket = blank();
      bySource.set(source, sourceBucket);
    }
    let bandBucket = byBand.get(band);
    if (!bandBucket) {
      bandBucket = blank();
      byBand.set(band, bandBucket);
    }
    for (const bucket of [totals, sourceBucket, bandBucket]) {
      bucket.applied += 1;
      if (hasAnyKind(kinds, REPLY_OUTCOME_KINDS)) bucket.reply += 1;
      if (hasAnyKind(kinds, INTERVIEW_OUTCOME_KINDS)) bucket.interview += 1;
      if (hasAnyKind(kinds, OFFER_OUTCOME_KINDS)) bucket.offer += 1;
      if (hasAnyKind(kinds, REJECTION_OUTCOME_KINDS)) bucket.rejection += 1;
    }
  }
  const bySourceList = [...bySource.entries()]
    .map(([source, counts]) => ({ source, ...counts }))
    .sort((a, b) => b.applied - a.applied || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const byBandList = SCORE_BAND_ORDER.filter((band) => byBand.has(band)).map((band) => ({
    band,
    ...byBand.get(band)!,
  }));
  return { version: 1, totals, bySource: bySourceList, byBand: byBandList };
}

function rebuildDashboardProjection(db: SqliteDatabase, tenantId: string): void {
  const hiddenWhere = tableExists(db, "jobhunter_hidden_jobs")
    ? `AND NOT EXISTS (
         SELECT 1 FROM jobhunter_hidden_jobs h
         WHERE h.job_url = jlp.job_id AND h.unhidden_at IS NULL
       )`
    : "";
  const closedWhere = tableExists(db, "posting_snapshot_sets")
    ? `AND NOT EXISTS (
         SELECT 1 FROM posting_snapshot_sets pss
         WHERE pss.tenant_id = jlp.tenant_id
           AND pss.job_url = jlp.job_id
           AND pss.latest_active_state IN (${CLOSED_ACTIVE_STATES.map((state) => `'${state}'`).join(", ")})
       )`
    : "";
  const rows = allRows<{
    job_id: string;
    current_stage: string;
    current_state: string;
    apply_status: string | null;
    applied_at: string | null;
    deleted_at: string | null;
    has_resume: number;
    fit_score: number | null;
    source: string;
  }>(
    db,
    `SELECT job_id, current_stage, current_state, apply_status, applied_at,
            deleted_at, has_resume, fit_score, source
     FROM job_list_projections jlp
     WHERE jlp.tenant_id = ?
       ${hiddenWhere}
       ${closedWhere}`,
    [tenantId],
  );
  const active = rows.filter((row) => !row.deleted_at);
  const totalJobs = active.length;
  const failures = active.filter((row) =>
    ["failed", "exhausted"].includes(row.current_state),
  ).length;
  const blocked = active.filter((row) => row.current_state === "blocked").length;
  const ready = active.filter(
    (row) =>
      row.current_stage === "apply" && row.current_state === "pending" && Number(row.has_resume ?? 0) === 1,
  ).length;
  const applied = active.filter(
    (row) => row.applied_at || row.apply_status === "applied",
  ).length;
  let dryRuns = 0;
  if (tableExists(db, "apply_run_projections")) {
    if (
      tableExists(db, "jobhunter_deleted_jobs") ||
      tableExists(db, "jobhunter_hidden_jobs") ||
      tableExists(db, "posting_snapshot_sets")
    ) {
      const hasDeleted = tableExists(db, "jobhunter_deleted_jobs");
      const hasHidden = tableExists(db, "jobhunter_hidden_jobs");
      const hasSnapshots = tableExists(db, "posting_snapshot_sets");
      const deletedJoin = hasDeleted
        ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = arp.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
        : "";
      const hiddenJoin = hasHidden
        ? " LEFT JOIN jobhunter_hidden_jobs h ON h.job_url = arp.job_id AND h.unhidden_at IS NULL"
        : "";
      const snapshotJoin = hasSnapshots
        ? " LEFT JOIN posting_snapshot_sets pss ON pss.tenant_id = arp.tenant_id AND pss.job_url = arp.job_id"
        : "";
      const lifecycleWhere = [
        hasDeleted ? "d.job_url IS NULL" : "",
        hasHidden ? "h.job_url IS NULL" : "",
        hasSnapshots
          ? `(pss.latest_active_state IS NULL OR pss.latest_active_state NOT IN (${CLOSED_ACTIVE_STATES.map((state) => `'${state}'`).join(", ")}))`
          : "",
      ].filter(Boolean).join(" AND ");
      const dryRunsRow = getRow<{ c: number }>(
        db,
        `SELECT COUNT(*) AS c FROM apply_run_projections arp${deletedJoin}${hiddenJoin}${snapshotJoin}
         WHERE arp.dry_run = 1 AND ${lifecycleWhere}`,
      );
      dryRuns = dryRunsRow ? Number(dryRunsRow.c) : 0;
    } else {
      const dryRunsRow = getRow<{ c: number }>(
        db,
        "SELECT COUNT(*) AS c FROM apply_run_projections WHERE dry_run = 1",
      );
      dryRuns = dryRunsRow ? Number(dryRunsRow.c) : 0;
    }
  }

  // Funnel — read per-job stage rows from job_detail_projections.
  const funnelCounts: Record<
    string,
    { stage: string; total: number; succeeded: number; running: number; pending: number; blocked: number; failed: number }
  > = {};
  for (const stage of STAGE_ORDER) {
    funnelCounts[stage] = {
      stage,
      total: 0,
      succeeded: 0,
      running: 0,
      pending: 0,
      blocked: 0,
      failed: 0,
    };
  }
  for (const row of active) {
    const detail = getRow<{ stages_json: string }>(
      db,
      "SELECT stages_json FROM job_detail_projections WHERE tenant_id = ? AND job_id = ?",
      [tenantId, row.job_id],
    );
    if (!detail || !detail.stages_json) continue;
    let stages: Array<{ stage: string; state: string }> = [];
    try {
      stages = JSON.parse(detail.stages_json) as Array<{ stage: string; state: string }>;
    } catch {
      continue;
    }
    for (const stage of stages) {
      const counts = funnelCounts[stage.stage];
      if (!counts) continue;
      if (stage.state === "skipped") continue;
      counts.total += 1;
      if (["failed", "exhausted"].includes(stage.state)) counts.failed += 1;
      else if (["running", "queued"].includes(stage.state)) counts.running += 1;
      else if (stage.state === "blocked") counts.blocked += 1;
      else if (stage.state === "succeeded") counts.succeeded += 1;
      else counts.pending += 1;
    }
  }
  const funnel = STAGE_ORDER.map((stage) => funnelCounts[stage]!);

  const sourceCounts = new Map<string, number>();
  for (const row of active) {
    const key = row.source || "unknown";
    sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
  }
  const bySource = [...sourceCounts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );

  const scoreCounts = new Map<number, number>();
  for (const row of active) {
    if (row.fit_score === null || row.fit_score === undefined) continue;
    const k = Number(row.fit_score);
    scoreCounts.set(k, (scoreCounts.get(k) ?? 0) + 1);
  }
  const scoreDistribution = [...scoreCounts.entries()].sort((a, b) => b[0] - a[0]);

  const outcomeConversion = buildOutcomeConversion(db, tenantId, active);

  db.prepare(
    `INSERT INTO dashboard_projections (
       tenant_id, total_jobs, failures, blocked, ready, applied, dry_runs,
       funnel_json, by_source_json, score_distribution_json,
       outcome_conversion_json, generated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       total_jobs              = excluded.total_jobs,
       failures                = excluded.failures,
       blocked                 = excluded.blocked,
       ready                   = excluded.ready,
       applied                 = excluded.applied,
       dry_runs                = excluded.dry_runs,
       funnel_json             = excluded.funnel_json,
       by_source_json          = excluded.by_source_json,
       score_distribution_json = excluded.score_distribution_json,
       outcome_conversion_json = excluded.outcome_conversion_json,
       generated_at            = excluded.generated_at`,
  ).run(
    tenantId,
    totalJobs,
    failures,
    blocked,
    ready,
    applied,
    dryRuns,
    JSON.stringify(funnel),
    JSON.stringify(bySource),
    JSON.stringify(scoreDistribution),
    JSON.stringify(outcomeConversion),
    new Date().toISOString(),
  );
}

interface SourceQualityEventRow extends Record<string, unknown> {
  job_url: string | null;
  event_type: string;
  occurred_at: string;
  payload_json: string | null;
}

interface MutableSourceStats {
  runCount: number;
  failedRunCount: number;
  consecutiveFailures: number;
  observedJobs: number;
  newJobs: number;
  existingJobs: number;
  duplicateJobs: number;
  activeJobs: number;
  staleJobs: number;
  detailSuccessCount: number;
  detailFailureCount: number;
  applyUrlSuccessCount: number;
  applyUrlFailureCount: number;
  lastRunId: string | null;
  lastErrorClass: string | null;
  detailSuccessJobs: Set<string>;
  detailFailureJobs: Set<string>;
  applySuccessJobs: Set<string>;
  applyFailureJobs: Set<string>;
}

interface DiscoveryRunProjection {
  runId: string;
  sourceIds: string[];
  profileSnapshotId: string | null;
  status: string;
  counts: Record<string, number>;
  errorClasses: string[];
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failedSourceId: string | null;
  retryable: boolean;
}

function rebuildSourceQualityProjections(db: SqliteDatabase, tenantId: string): void {
  if (!tableExists(db, "job_events")) return;
  const payloadColumn = hasColumn(db, "job_events", "payload_json")
    ? "payload_json"
    : "NULL AS payload_json";
  const rows = allRows<SourceQualityEventRow>(
    db,
    `SELECT job_url, event_type, occurred_at, ${payloadColumn}
     FROM job_events
     WHERE event_type IN (
       'DiscoveryRunStarted',
       'DiscoveryRunCompleted',
       'DiscoveryRunFailed',
       'JobSourceObserved',
       'DuplicateJobLinked',
       'PostingContentSnapshotCaptured',
       'PostingContentSnapshotFailed',
       'JobEnriched',
       'EnrichmentFailed',
       'JobActiveStateChanged',
       'ContentDuplicateCandidateDetected',
       'DiscoveryFeedbackRecorded'
     )
     ORDER BY event_id ASC`,
  );
  const runs = new Map<string, DiscoveryRunProjection>();
  const stats = new Map<string, MutableSourceStats>();
  const sourceByObservation = new Map<string, string>();
  const sourcesByJob = new Map<string, Set<string>>();
  const activeRunBySource = new Map<string, string>();
  const observedByRunSource = new Map<string, number>();
  const duplicateByRunSource = new Map<string, number>();
  const windowStart = rows[0]?.occurred_at ?? new Date().toISOString();
  const windowEnd = rows[rows.length - 1]?.occurred_at ?? windowStart;

  for (const row of rows) {
    const payload = parsePayload(row.payload_json);
    if (row.event_type === "DiscoveryRunStarted") {
      const runId = text(payload, "run_id", "runId");
      const sourceIds = stringList(value(payload, "source_ids", "sourceIds"));
      if (!runId) continue;
      runs.set(runId, {
        runId,
        sourceIds,
        profileSnapshotId: nullableText(value(payload, "profile_snapshot_id", "profileSnapshotId")),
        status: "running",
        counts: {},
        errorClasses: [],
        startedAt: text(payload, "started_at", "startedAt") || row.occurred_at,
        completedAt: null,
        failedAt: null,
        failedSourceId: null,
        retryable: true,
      });
      for (const sourceId of sourceIds) {
        getStats(stats, sourceId);
        activeRunBySource.set(sourceId, runId);
      }
    } else if (row.event_type === "DiscoveryRunCompleted") {
      const runId = text(payload, "run_id", "runId");
      const run = runs.get(runId);
      const counts = normalizeCounts(record(value(payload, "counts")));
      const skipped = Boolean(value(payload, "skipped"));
      const failedSourceIds = new Set(
        stringList(
          value(payload, "failed_source_ids", "failedSourceIds", "failed_sources", "failedSources"),
        ),
      );
      if (run) {
        run.status = "completed";
        run.counts = counts;
        run.errorClasses = stringList(value(payload, "error_classes", "errorClasses"));
        run.completedAt = text(payload, "completed_at", "completedAt") || row.occurred_at;
        for (const sourceId of run.sourceIds) {
          const current = getStats(stats, sourceId);
          const failedInRun = failedSourceIds.has(sourceId);
          if (!skipped && !failedInRun) {
            current.runCount += 1;
            current.consecutiveFailures = 0;
          }
          if (run.sourceIds.length === 1 && !skipped && !failedInRun) {
            current.newJobs += counts.new_jobs ?? 0;
            current.existingJobs += counts.existing_jobs ?? 0;
            const observedKey = runSourceKey(runId, sourceId);
            const observedFallback = counts.observed_jobs ?? 0;
            current.observedJobs += Math.max(
              0,
              observedFallback - (observedByRunSource.get(observedKey) ?? 0),
            );
            const duplicateFallback = counts.duplicate_jobs ?? 0;
            current.duplicateJobs += Math.max(
              0,
              duplicateFallback - (duplicateByRunSource.get(observedKey) ?? 0),
            );
          }
          current.lastRunId = runId;
          if (activeRunBySource.get(sourceId) === runId) activeRunBySource.delete(sourceId);
        }
      }
    } else if (row.event_type === "DiscoveryRunFailed") {
      const runId = text(payload, "run_id", "runId");
      const sourceId = text(payload, "source_id", "sourceId");
      const errorClass = text(payload, "error_class", "errorClass");
      const run = runs.get(runId);
      if (run) {
        run.status = "failed";
        run.errorClasses = errorClass ? [errorClass] : [];
        run.failedAt = text(payload, "failed_at", "failedAt") || row.occurred_at;
        run.failedSourceId = sourceId || null;
        run.retryable = value(payload, "retryable") !== false;
      }
      if (sourceId) {
        const current = getStats(stats, sourceId);
        current.failedRunCount += 1;
        current.consecutiveFailures += 1;
        current.lastRunId = runId || current.lastRunId;
        current.lastErrorClass = errorClass || current.lastErrorClass;
        if (activeRunBySource.get(sourceId) === runId) activeRunBySource.delete(sourceId);
      }
    } else if (row.event_type === "JobSourceObserved") {
      const sourceId = text(payload, "source_id", "sourceId");
      const observationId = text(payload, "source_observation_id", "sourceObservationId");
      const jobId = text(payload, "job_id", "jobId") || row.job_url || "";
      if (!sourceId) continue;
      getStats(stats, sourceId).observedJobs += 1;
      const activeRunId = activeRunBySource.get(sourceId);
      if (activeRunId) {
        const key = runSourceKey(activeRunId, sourceId);
        observedByRunSource.set(key, (observedByRunSource.get(key) ?? 0) + 1);
      }
      if (observationId) sourceByObservation.set(observationId, sourceId);
      if (jobId) {
        const set = sourcesByJob.get(jobId) ?? new Set<string>();
        set.add(sourceId);
        sourcesByJob.set(jobId, set);
      }
    } else if (row.event_type === "DuplicateJobLinked") {
      const observationId = text(
        payload,
        "superseded_job_or_observation_id",
        "supersededJobOrObservationId",
      );
      const sourceId = sourceByObservation.get(observationId);
      if (sourceId) {
        getStats(stats, sourceId).duplicateJobs += 1;
        const activeRunId = activeRunBySource.get(sourceId);
        if (activeRunId) {
          const key = runSourceKey(activeRunId, sourceId);
          duplicateByRunSource.set(key, (duplicateByRunSource.get(key) ?? 0) + 1);
        }
      }
    } else if (row.event_type === "PostingContentSnapshotCaptured") {
      const sourceId = text(payload, "source_id", "sourceId");
      const jobId = text(payload, "job_id", "jobId") || row.job_url || "";
      if (sourceId) markDetailSuccess(getStats(stats, sourceId), jobId);
    } else if (row.event_type === "PostingContentSnapshotFailed") {
      const sourceId = text(payload, "source_id", "sourceId");
      const jobId = text(payload, "job_id", "jobId") || row.job_url || "";
      if (sourceId) {
        const current = getStats(stats, sourceId);
        markDetailFailure(current, jobId);
        current.lastErrorClass = text(payload, "error_class", "errorClass") || current.lastErrorClass;
      }
    } else if (row.event_type === "JobEnriched") {
      const jobId = text(payload, "job_id", "jobId") || row.job_url || "";
      const fullDescription = text(payload, "full_description", "fullDescription");
      const applicationUrl = text(payload, "application_url", "applicationUrl");
      for (const sourceId of sourcesByJob.get(jobId) ?? []) {
        const current = getStats(stats, sourceId);
        if (fullDescription.trim()) markDetailSuccess(current, jobId);
        else markDetailFailure(current, jobId);
        if (applicationUrl.trim()) markApplySuccess(current, jobId);
        else markApplyFailure(current, jobId);
      }
    } else if (row.event_type === "EnrichmentFailed") {
      const jobId = text(payload, "job_id", "jobId") || row.job_url || "";
      const errorClass = text(payload, "error_class", "errorClass", "error");
      for (const sourceId of sourcesByJob.get(jobId) ?? []) {
        const current = getStats(stats, sourceId);
        markDetailFailure(current, jobId);
        markApplyFailure(current, jobId);
        current.lastErrorClass = errorClass || current.lastErrorClass;
      }
    } else if (row.event_type === "JobActiveStateChanged") {
      const jobId = text(payload, "job_id", "jobId") || row.job_url || "";
      const activeState = text(payload, "active_state", "activeState");
      for (const sourceId of sourcesByJob.get(jobId) ?? []) {
        const current = getStats(stats, sourceId);
        if (activeState === "active") current.activeJobs += 1;
        if (["closed", "expired", "removed", "location_incompatible"].includes(activeState)) {
          current.staleJobs += 1;
        }
      }
    } else if (row.event_type === "ContentDuplicateCandidateDetected") {
      const jobId = text(payload, "job_id", "jobId") || row.job_url || "";
      const candidateJobId = text(payload, "candidate_job_id", "candidateJobId");
      const sourceIds = new Set([
        ...(sourcesByJob.get(jobId) ?? []),
        ...(sourcesByJob.get(candidateJobId) ?? []),
      ]);
      for (const sourceId of sourceIds) {
        getStats(stats, sourceId).duplicateJobs += 1;
        const activeRunId = activeRunBySource.get(sourceId);
        if (activeRunId) {
          const key = runSourceKey(activeRunId, sourceId);
          duplicateByRunSource.set(key, (duplicateByRunSource.get(key) ?? 0) + 1);
        }
      }
    } else if (row.event_type === "DiscoveryFeedbackRecorded") {
      const jobId = text(payload, "job_id", "jobId") || row.job_url || "";
      const explicitSourceId = nullableText(value(payload, "source_id", "sourceId"));
      const sourceIds = explicitSourceId ? [explicitSourceId] : [...(sourcesByJob.get(jobId) ?? [])];
      const kind = text(payload, "kind");
      for (const sourceId of sourceIds) {
        const current = getStats(stats, sourceId);
        current.observedJobs += 1;
        if (kind === "duplicate") {
          current.duplicateJobs += 1;
        } else if (["stale", "wrong_company", "wrong_location", "irrelevant"].includes(kind)) {
          current.staleJobs += 1;
        } else if (kind === "bad_source") {
          markDetailFailure(current, jobId);
          current.lastErrorClass = "user_bad_source";
        } else if (["saved", "applied", "useful"].includes(kind)) {
          current.activeJobs += 1;
          markDetailSuccess(current, jobId);
          if (kind === "applied") {
            markApplySuccess(current, jobId);
          }
        }
      }
    }
  }

  db.prepare("DELETE FROM source_quality_stats WHERE tenant_id = ?").run(tenantId);
  const updatedAt = new Date().toISOString();
  for (const [sourceId, current] of stats.entries()) {
    const activeRate = rate(current.activeJobs, current.activeJobs + current.staleJobs);
    const duplicateRate = rate(current.duplicateJobs, current.observedJobs);
    const detailRate = rate(
      current.detailSuccessCount,
      current.detailSuccessCount + current.detailFailureCount,
    );
    const applyUrlRate = rate(
      current.applyUrlSuccessCount,
      current.applyUrlSuccessCount + current.applyUrlFailureCount,
    );
    db.prepare(
      `INSERT INTO source_quality_stats (
         tenant_id, source_id, window_start, window_end, run_count,
         failed_run_count, consecutive_failures, observed_jobs, new_jobs,
         existing_jobs, duplicate_jobs, active_jobs, stale_jobs,
         detail_success_count, detail_failure_count, active_verification_rate,
         duplicate_rate, full_description_success_rate, apply_url_success_rate,
         last_run_id, last_error_class, recommended_state, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tenantId,
      sourceId,
      windowStart,
      windowEnd,
      current.runCount,
      current.failedRunCount,
      current.consecutiveFailures,
      current.observedJobs,
      current.newJobs,
      current.existingJobs,
      current.duplicateJobs,
      current.activeJobs,
      current.staleJobs,
      current.detailSuccessCount,
      current.detailFailureCount,
      activeRate,
      duplicateRate,
      detailRate,
      applyUrlRate,
      current.lastRunId,
      current.lastErrorClass,
      recommendedState(current, activeRate, duplicateRate, detailRate),
      updatedAt,
    );
  }
}

function hasSourceQualityHistory(db: SqliteDatabase): boolean {
  if (!tableExists(db, "job_events")) return false;
  const row = getRow<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c
     FROM job_events
     WHERE event_type IN (
       'DiscoveryRunStarted',
       'DiscoveryRunCompleted',
       'DiscoveryRunFailed',
       'JobSourceObserved',
       'DuplicateJobLinked',
       'PostingContentSnapshotCaptured',
       'PostingContentSnapshotFailed',
       'JobEnriched',
       'EnrichmentFailed',
       'JobActiveStateChanged',
       'ContentDuplicateCandidateDetected',
       'DiscoveryFeedbackRecorded'
     )`,
  );
  return Number(row?.c ?? 0) > 0;
}

// =============================================================== helpers

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hasColumn(db: SqliteDatabase, tableName: string, columnName: string): boolean {
  return allRows<{ name: string }>(db, `PRAGMA table_info(${tableName})`).some(
    (row) => row.name === columnName,
  );
}

function columnOrLiteral(
  db: SqliteDatabase,
  tableName: string,
  columnName: string,
  fallbackSql: string,
  alias: string,
): string {
  return hasColumn(db, tableName, columnName) ? `${alias}.${columnName}` : fallbackSql;
}

function jobMetadataJoinSql(
  db: SqliteDatabase,
  jobUrlExpression: string,
): { selectSql: string; joinSql: string } {
  if (!tableExists(db, "jobs")) {
    return { selectSql: "NULL AS job_title, NULL AS employer", joinSql: "" };
  }
  const titleSql = columnOrLiteral(db, "jobs", "title", "NULL", "jobs");
  const employerParts = [
    hasColumn(db, "jobs", "company") ? "NULLIF(jobs.company, '')" : null,
    hasColumn(db, "jobs", "site") ? "jobs.site" : null,
  ].filter((part): part is string => Boolean(part));
  const employerSql =
    employerParts.length > 1
      ? `COALESCE(${employerParts.join(", ")})`
      : employerParts[0] ?? "NULL";
  return {
    selectSql: `${titleSql} AS job_title, ${employerSql} AS employer`,
    joinSql: `LEFT JOIN jobs ON jobs.url = ${jobUrlExpression}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function value(payload: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return payload[key];
    }
  }
  return undefined;
}

function text(payload: Record<string, unknown>, ...keys: string[]): string {
  const candidate = value(payload, ...keys);
  return candidate === null || candidate === undefined ? "" : String(candidate);
}

function nullableText(candidate: unknown): string | null {
  return candidate === null || candidate === undefined || candidate === "" ? null : String(candidate);
}

function stringList(candidate: unknown): string[] {
  return Array.isArray(candidate)
    ? candidate.map((item) => String(item)).filter((item) => item.length > 0)
    : [];
}

function record(candidate: unknown): Record<string, unknown> {
  return isRecord(candidate) ? candidate : {};
}

function normalizeCounts(counts: Record<string, unknown>): Record<string, number> {
  return {
    total: numberValue(counts, "total"),
    new_jobs: numberValue(counts, "new_jobs", "newJobs"),
    existing_jobs: numberValue(counts, "existing_jobs", "existingJobs"),
    observed_jobs: numberValue(counts, "observed_jobs", "observedJobs"),
    duplicate_jobs: numberValue(counts, "duplicate_jobs", "duplicateJobs"),
    rejected_duplicates: numberValue(counts, "rejected_duplicates", "rejectedDuplicates"),
  };
}

function numberValue(payload: Record<string, unknown>, ...keys: string[]): number {
  const candidate = value(payload, ...keys);
  const number = Number(candidate ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function getStats(stats: Map<string, MutableSourceStats>, sourceId: string): MutableSourceStats {
  const existing = stats.get(sourceId);
  if (existing) return existing;
  const created: MutableSourceStats = {
    runCount: 0,
    failedRunCount: 0,
    consecutiveFailures: 0,
    observedJobs: 0,
    newJobs: 0,
    existingJobs: 0,
    duplicateJobs: 0,
    activeJobs: 0,
    staleJobs: 0,
    detailSuccessCount: 0,
    detailFailureCount: 0,
    applyUrlSuccessCount: 0,
    applyUrlFailureCount: 0,
    lastRunId: null,
    lastErrorClass: null,
    detailSuccessJobs: new Set<string>(),
    detailFailureJobs: new Set<string>(),
    applySuccessJobs: new Set<string>(),
    applyFailureJobs: new Set<string>(),
  };
  stats.set(sourceId, created);
  return created;
}

function runSourceKey(runId: string, sourceId: string): string {
  return `${runId}\u0000${sourceId}`;
}

function markDetailSuccess(stats: MutableSourceStats, jobId: string): void {
  if (jobId && stats.detailSuccessJobs.has(jobId)) return;
  if (jobId) {
    stats.detailSuccessJobs.add(jobId);
    stats.detailFailureJobs.delete(jobId);
  }
  stats.detailSuccessCount += 1;
}

function markDetailFailure(stats: MutableSourceStats, jobId: string): void {
  if (jobId && (stats.detailFailureJobs.has(jobId) || stats.detailSuccessJobs.has(jobId))) return;
  if (jobId) stats.detailFailureJobs.add(jobId);
  stats.detailFailureCount += 1;
}

function markApplySuccess(stats: MutableSourceStats, jobId: string): void {
  if (jobId && stats.applySuccessJobs.has(jobId)) return;
  if (jobId) {
    stats.applySuccessJobs.add(jobId);
    stats.applyFailureJobs.delete(jobId);
  }
  stats.applyUrlSuccessCount += 1;
}

function markApplyFailure(stats: MutableSourceStats, jobId: string): void {
  if (jobId && (stats.applyFailureJobs.has(jobId) || stats.applySuccessJobs.has(jobId))) return;
  if (jobId) stats.applyFailureJobs.add(jobId);
  stats.applyUrlFailureCount += 1;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function recommendedState(
  stats: MutableSourceStats,
  activeRate: number | null,
  duplicateRate: number | null,
  detailRate: number | null,
): string {
  const sample = Math.max(stats.observedJobs, stats.newJobs + stats.existingJobs);
  if (stats.consecutiveFailures >= 5) return "disabled";
  if (stats.consecutiveFailures >= 3) return "quarantined";
  if (sample >= 10 && duplicateRate !== null && duplicateRate >= 0.85) return "quarantined";
  if (sample >= 10 && activeRate !== null && activeRate < 0.25) return "quarantined";
  if (sample >= 10 && detailRate !== null && detailRate < 0.25) return "quarantined";
  return "normal";
}

function stringField(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function previewText(value: string, limit: number): string {
  if (!value) return "";
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function deriveApplyStatus(arStatus: string | null, legacyStatus: string | null): string | null {
  if (arStatus) {
    if (arStatus === "succeeded") return "applied";
    if (arStatus === "starting" || arStatus === "in_progress") return "in_progress";
    if (arStatus === "dry_run_complete") return "dry_run";
    return arStatus;
  }
  return legacyStatus;
}

function companyName(site: string, postingUrl: string): string {
  const inferred = inferredCompanyFromUrl(postingUrl);
  if (inferred) return inferred;
  if (!site || SOURCE_BOARD_NAMES.has(site.toLowerCase())) return "Unknown company";
  return site;
}

function inferredCompanyFromUrl(rawUrl: string): string {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (parsed.hostname.endsWith("greenhouse.io") && segments[0]) {
      return titleFromSlug(segments[0]);
    }
    if (parsed.hostname === "jobs.lever.co" && segments[0]) {
      return titleFromSlug(segments[0]);
    }
    if (parsed.hostname === "jobs.ashbyhq.com" && segments[0]) {
      return titleFromSlug(segments[0]);
    }
  } catch {
    return "";
  }
  return "";
}

function titleFromSlug(value: string): string {
  const known: Record<string, string> = { gitlab: "GitLab" };
  const lower = value.toLowerCase();
  if (known[lower]) return known[lower]!;
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Suppress unused import warning for SqliteValue (re-exported for consumers).
export type { SqliteValue };
