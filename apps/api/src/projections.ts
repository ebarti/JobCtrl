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

const STAGE_ORDER: readonly string[] = STAGES;
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
const DEFAULT_MAX_ATTEMPTS: Record<string, number> = {
  discover: 1,
  enrich: 3,
  score: 3,
  tailor: 5,
  cover: 5,
  apply: 3,
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
      score_breakdown_json   TEXT,
      score_keywords_json    TEXT NOT NULL DEFAULT '[]',
      score_reasoning        TEXT NOT NULL DEFAULT '',
      score_version          INTEGER,
      scored_at              TEXT,
      score_criteria_json    TEXT,
      score_trace_json       TEXT,
      score_correction_json  TEXT,
      current_stage          TEXT NOT NULL DEFAULT 'discover',
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
      generated_at           TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS job_detail_projections (
      tenant_id              TEXT NOT NULL DEFAULT 'local',
      job_id                 TEXT NOT NULL,
      description_preview    TEXT NOT NULL DEFAULT '',
      score_breakdown_json   TEXT,
      score_keywords_json    TEXT NOT NULL DEFAULT '[]',
      score_reasoning        TEXT NOT NULL DEFAULT '',
      score_version          INTEGER,
      scored_at              TEXT,
      score_criteria_json    TEXT,
      score_trace_json       TEXT,
      score_correction_json  TEXT,
      stages_json            TEXT NOT NULL DEFAULT '[]',
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
      generation             INTEGER
    );
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
    CREATE TABLE IF NOT EXISTS discovery_run_projections (
      run_id                 TEXT PRIMARY KEY,
      tenant_id              TEXT NOT NULL DEFAULT 'local',
      source_ids_json        TEXT NOT NULL DEFAULT '[]',
      profile_snapshot_id    TEXT,
      status                 TEXT NOT NULL DEFAULT 'running',
      counts_json            TEXT NOT NULL DEFAULT '{}',
      error_classes_json     TEXT NOT NULL DEFAULT '[]',
      started_at             TEXT,
      completed_at           TEXT,
      failed_at              TEXT,
      failed_source_id       TEXT,
      retryable              INTEGER NOT NULL DEFAULT 1
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
  schemaChanged =
    ensureProjectionColumn(db, "job_list_projections", "score_keywords_json", "TEXT NOT NULL DEFAULT '[]'") ||
    schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "score_version", "INTEGER") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "scored_at", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "score_criteria_json", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "score_trace_json", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "score_correction_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "job_detail_projections", "score_breakdown_json", "TEXT") || schemaChanged;
  schemaChanged =
    ensureProjectionColumn(db, "job_detail_projections", "score_keywords_json", "TEXT NOT NULL DEFAULT '[]'") ||
    schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_detail_projections", "score_version", "INTEGER") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_detail_projections", "scored_at", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_detail_projections", "score_criteria_json", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_detail_projections", "score_trace_json", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_detail_projections", "score_correction_json", "TEXT") || schemaChanged;
  return schemaChanged;
}

function ensureProjectionColumn(
  db: SqliteDatabase,
  tableName: string,
  columnName: string,
  definition: string,
): boolean {
  const columns = new Set(
    allRows<{ name: string }>(db, `PRAGMA table_info(${tableName})`).map((row) => row.name),
  );
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    return true;
  }
  return false;
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

  const watermark = readWatermark(db, PROJECTION_WATERMARK_NAME);

  let dirtyJobs = new Set<string>();
  let sourceQualityDirty = false;
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
    }
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

  if (maxEventId > watermark) {
    setWatermark(db, PROJECTION_WATERMARK_NAME, maxEventId);
  }
}

interface MaterialsLatest {
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
  const generationRow = getRow<{ max_generation: number }>(
    db,
    "SELECT MAX(generation) AS max_generation FROM job_materials WHERE job_url = ?",
    [jobUrl],
  );
  const generation = generationRow ? generationRow.max_generation : null;
  if (generation === null || generation === undefined) {
    return empty;
  }
  const artifacts = allRows<{ artifact_type: string; path: string; created_at: string | null }>(
    db,
    `SELECT artifact_type, path, created_at FROM job_materials_artifacts
     WHERE job_url = ? AND generation = ? AND status = 'approved'`,
    [jobUrl, Number(generation)],
  );
  const latest: MaterialsLatest = { ...empty, generation: Number(generation) };
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

  const tailorPath = materials.tailorPath ?? nullableString(job.tailored_resume_path);
  const coverPath = materials.coverPath ?? nullableString(job.cover_letter_path);
  const hasResume = Boolean(tailorPath);
  const hasCoverLetter = Boolean(coverPath);
  const hasPdf = Boolean(materials.resumePdfPath ?? materials.coverPdfPath);

  const applyStatus = deriveApplyStatus(apply.status, nullableString(job.apply_status));
  const appliedAt = apply.status === "succeeded" ? apply.finishedAt : nullableString(job.applied_at);

  const description = stringField(job.description);
  const fullDescription = enrichment.fullDescription ?? stringField(job.full_description);

  const lastUpdatedAt = new Date().toISOString();

  const artifacts = collectArtifacts(db, jobUrl, materials);

  db.prepare(
    `INSERT INTO job_list_projections (
     tenant_id, job_id, title, employer, source, strategy, location,
     salary, application_url, discovered_at, description, full_description,
       fit_score, score_breakdown_json, score_keywords_json, score_reasoning,
       score_version, scored_at, score_criteria_json, score_trace_json,
       score_correction_json, current_stage, current_state,
       current_error_code, current_error_message, current_next_action,
       has_resume, has_cover_letter, has_pdf, apply_status, applied_at,
       artifact_count, deleted_at, last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       score_breakdown_json  = excluded.score_breakdown_json,
       score_keywords_json   = excluded.score_keywords_json,
       score_reasoning       = excluded.score_reasoning,
       score_version         = excluded.score_version,
       scored_at             = excluded.scored_at,
       score_criteria_json   = excluded.score_criteria_json,
       score_trace_json      = excluded.score_trace_json,
       score_correction_json = excluded.score_correction_json,
       current_stage         = excluded.current_stage,
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
    scoreBreakdownJson,
    scoreKeywordsJson,
    scoreReasoning,
    score.version,
    score.scoredAt,
    score.criteriaJson,
    score.traceJson,
    score.correctionJson,
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
    artifacts.length,
    deletedAt,
    lastUpdatedAt,
  );

  db.prepare(
    `INSERT INTO job_detail_projections (
       tenant_id, job_id, description_preview, score_breakdown_json,
       score_keywords_json, score_reasoning, score_version, scored_at,
       score_criteria_json, score_trace_json, score_correction_json,
       stages_json, last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, job_id) DO UPDATE SET
       description_preview  = excluded.description_preview,
       score_breakdown_json = excluded.score_breakdown_json,
       score_keywords_json  = excluded.score_keywords_json,
       score_reasoning      = excluded.score_reasoning,
       score_version        = excluded.score_version,
       scored_at            = excluded.scored_at,
       score_criteria_json  = excluded.score_criteria_json,
       score_trace_json     = excluded.score_trace_json,
       score_correction_json = excluded.score_correction_json,
       stages_json          = excluded.stages_json,
       last_updated_at      = excluded.last_updated_at`,
  ).run(
    tenantId,
    jobUrl,
    previewText(fullDescription || description, 6000),
    scoreBreakdownJson,
    scoreKeywordsJson,
    scoreReasoning,
    score.version,
    score.scoredAt,
    score.criteriaJson,
    score.traceJson,
    score.correctionJson,
    JSON.stringify(stages),
    lastUpdatedAt,
  );

  db.prepare("DELETE FROM artifact_list_projections WHERE tenant_id = ? AND job_id = ?").run(
    tenantId,
    jobUrl,
  );
  const insertArtifact = db.prepare(
    `INSERT INTO artifact_list_projections (
       artifact_id, tenant_id, job_id, job_title, job_employer, artifact_type,
       status, local_path, size_bytes, created_at, generation
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
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
    );
  }
}

interface ArtifactRow {
  artifactId: string;
  artifactType: string;
  status: string;
  localPath: string;
  sizeBytes: number | null;
  createdAt: string | null;
  generation: number | null;
}

function collectArtifacts(
  db: SqliteDatabase,
  jobUrl: string,
  materials: MaterialsLatest,
): ArtifactRow[] {
  const out: ArtifactRow[] = [];
  const seen = new Set<string>();
  if (tableExists(db, "job_materials_artifacts")) {
    const rows = allRows<{
      artifact_id: string;
      artifact_type: string;
      status: string;
      path: string;
      created_at: string | null;
      size_bytes: number | null;
      generation: number | null;
    }>(
      db,
      `SELECT artifact_id, artifact_type, status, path, created_at, size_bytes, generation
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
      });
    }
  }
  // Derive PDF siblings for legacy txt artifacts whose registered PDF
  // doesn't exist as a separate row.  Mirrors the prior read-model.ts
  // behaviour so downstream consumers (web UI artifact list, tests)
  // still see the matching ``*_pdf`` row.  When a real PDF artifact is
  // registered we never overwrite it (``seen`` guards against
  // duplicates).
  const tailorTxt = out.find((a) => a.artifactType === "tailored_resume_txt");
  const tailorPdfPath =
    materials.resumePdfPath ?? (tailorTxt ? pdfSibling(tailorTxt.localPath) : null);
  if (tailorPdfPath && !seen.has(`tailored_resume_pdf:${tailorPdfPath}`)) {
    seen.add(`tailored_resume_pdf:${tailorPdfPath}`);
    out.push({
      artifactId: `${jobUrl}:tailored_resume_pdf:${tailorPdfPath}`,
      artifactType: "tailored_resume_pdf",
      status: "active",
      localPath: tailorPdfPath,
      sizeBytes: null,
      createdAt: tailorTxt?.createdAt ?? null,
      generation: null,
    });
  }
  const coverTxt = out.find((a) => a.artifactType === "cover_letter_txt");
  const coverPdfPath =
    materials.coverPdfPath ?? (coverTxt ? pdfSibling(coverTxt.localPath) : null);
  if (coverPdfPath && !seen.has(`cover_letter_pdf:${coverPdfPath}`)) {
    seen.add(`cover_letter_pdf:${coverPdfPath}`);
    out.push({
      artifactId: `${jobUrl}:cover_letter_pdf:${coverPdfPath}`,
      artifactType: "cover_letter_pdf",
      status: "active",
      localPath: coverPdfPath,
      sizeBytes: null,
      createdAt: coverTxt?.createdAt ?? null,
      generation: null,
    });
  }
  return out;
}

function pdfSibling(value: string | null | undefined): string | null {
  if (!value) return null;
  return `${value.replace(/\.[^.]+$/, "")}.pdf`;
}

function rebuildDashboardProjection(db: SqliteDatabase, tenantId: string): void {
  const hiddenWhere = tableExists(db, "jobhunter_hidden_jobs")
    ? `AND NOT EXISTS (
         SELECT 1 FROM jobhunter_hidden_jobs h
         WHERE h.job_url = jlp.job_id AND h.unhidden_at IS NULL
       )`
    : "";
  const rows = allRows<{
    job_id: string;
    current_stage: string;
    current_state: string;
    apply_status: string | null;
    applied_at: string | null;
    deleted_at: string | null;
    fit_score: number | null;
    source: string;
  }>(
    db,
    `SELECT job_id, current_stage, current_state, apply_status, applied_at,
            deleted_at, fit_score, source
     FROM job_list_projections jlp
     WHERE tenant_id = ?
       ${hiddenWhere}`,
    [tenantId],
  );
  const active = rows.filter((row) => !row.deleted_at);
  const totalJobs = active.length;
  const failures = active.filter((row) =>
    ["failed", "exhausted"].includes(row.current_state),
  ).length;
  const blocked = active.filter((row) => row.current_state === "blocked").length;
  const ready = active.filter(
    (row) => row.current_stage === "apply" && row.current_state === "pending",
  ).length;
  const applied = active.filter(
    (row) => row.applied_at || row.apply_status === "applied",
  ).length;
  let dryRuns = 0;
  if (tableExists(db, "apply_run_projections")) {
    if (tableExists(db, "jobhunter_deleted_jobs") || tableExists(db, "jobhunter_hidden_jobs")) {
      const deletedJoin = tableExists(db, "jobhunter_deleted_jobs")
        ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = arp.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
        : "";
      const hiddenJoin = tableExists(db, "jobhunter_hidden_jobs")
        ? " LEFT JOIN jobhunter_hidden_jobs h ON h.job_url = arp.job_id AND h.unhidden_at IS NULL"
        : "";
      const hiddenWhere = [
        tableExists(db, "jobhunter_deleted_jobs") ? "d.job_url IS NULL" : "",
        tableExists(db, "jobhunter_hidden_jobs") ? "h.job_url IS NULL" : "",
      ].filter(Boolean).join(" AND ");
      const dryRunsRow = getRow<{ c: number }>(
        db,
        `SELECT COUNT(*) AS c FROM apply_run_projections arp${deletedJoin}${hiddenJoin}
         WHERE arp.dry_run = 1 AND ${hiddenWhere}`,
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
  const bySource = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]);

  const scoreCounts = new Map<number, number>();
  for (const row of active) {
    if (row.fit_score === null || row.fit_score === undefined) continue;
    const k = Number(row.fit_score);
    scoreCounts.set(k, (scoreCounts.get(k) ?? 0) + 1);
  }
  const scoreDistribution = [...scoreCounts.entries()].sort((a, b) => b[0] - a[0]);

  db.prepare(
    `INSERT INTO dashboard_projections (
       tenant_id, total_jobs, failures, blocked, ready, applied, dry_runs,
       funnel_json, by_source_json, score_distribution_json, generated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  for (const run of runs.values()) {
    db.prepare(
      `INSERT INTO discovery_run_projections (
         run_id, tenant_id, source_ids_json, profile_snapshot_id, status,
         counts_json, error_classes_json, started_at, completed_at,
         failed_at, failed_source_id, retryable
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         source_ids_json = excluded.source_ids_json,
         profile_snapshot_id = excluded.profile_snapshot_id,
         status = excluded.status,
         counts_json = excluded.counts_json,
         error_classes_json = excluded.error_classes_json,
         started_at = excluded.started_at,
         completed_at = excluded.completed_at,
         failed_at = excluded.failed_at,
         failed_source_id = excluded.failed_source_id,
         retryable = excluded.retryable`,
    ).run(
      run.runId,
      tenantId,
      JSON.stringify(run.sourceIds),
      run.profileSnapshotId,
      run.status,
      JSON.stringify(run.counts),
      JSON.stringify(run.errorClasses),
      run.startedAt,
      run.completedAt,
      run.failedAt,
      run.failedSourceId,
      run.retryable ? 1 : 0,
    );
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
