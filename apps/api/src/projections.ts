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
 * job_scores, job_materials, job_enrichments, apply_runs,
 * jobhunter_deleted_jobs, job_artifacts, job_materials_artifacts).
 */
import { PROJECTION_WATERMARK_NAME, STAGES } from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";

const STAGE_ORDER: readonly string[] = STAGES;
const SOURCE_BOARD_NAMES = new Set(["greenhouse", "linkedin", "talent.com"]);
const DEFAULT_MAX_ATTEMPTS: Record<string, number> = {
  discover: 1,
  enrich: 3,
  score: 3,
  tailor: 5,
  cover: 5,
  pdf: 3,
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
    pdf: 3,
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

    if (tailorSucceeded) {
      insertStage(row.url, "pdf", "succeeded", { finishedAt: now });
    } else {
      insertStage(row.url, "pdf", "blocked", {
        errorCode: "BLOCKED",
        errorMessage: "tailor has not completed.",
      });
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
export function ensureProjectionTables(db: SqliteDatabase): void {
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
      score_reasoning        TEXT NOT NULL DEFAULT '',
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
      score_reasoning        TEXT NOT NULL DEFAULT '',
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
  `);
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
  ensureProjectionTables(db);
  backfillLegacyStageStates(db);

  const watermark = readWatermark(db, PROJECTION_WATERMARK_NAME);

  let dirtyJobs = new Set<string>();
  let maxEventId = watermark;
  if (tableExists(db, "job_events")) {
    const rows = allRows<{ event_id: number; job_url: string | null }>(
      db,
      "SELECT event_id, job_url FROM job_events WHERE event_id > ? ORDER BY event_id ASC",
      [watermark],
    );
    for (const row of rows) {
      const eventId = Number(row.event_id);
      if (eventId > maxEventId) maxEventId = eventId;
      if (row.job_url) dirtyJobs.add(String(row.job_url));
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

  // L5 (round-1 review): nothing dirty AND no new events ⇒ skip the
  // O(jobs × stages) dashboard / apply-run rebuilds.
  if (dirtyJobs.size === 0 && maxEventId === watermark) {
    return;
  }

  for (const jobUrl of dirtyJobs) {
    rebuildJobProjections(db, tenantId, jobUrl);
  }
  if (dirtyJobs.size > 0) {
    rebuildApplyRunProjections(db, tenantId);
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

interface ScoreLatest {
  fitScore: number | null;
  reasoning: string;
}

function loadLatestScore(db: SqliteDatabase, jobUrl: string): ScoreLatest {
  if (!tableExists(db, "job_scores")) {
    return { fitScore: null, reasoning: "" };
  }
  const row = getRow<{ fit_score: number; breakdown_json: string | null }>(
    db,
    "SELECT fit_score, breakdown_json FROM job_scores WHERE job_url = ? ORDER BY version DESC LIMIT 1",
    [jobUrl],
  );
  if (!row) {
    return { fitScore: null, reasoning: "" };
  }
  let reasoning = "";
  if (row.breakdown_json) {
    try {
      const parsed: unknown = JSON.parse(row.breakdown_json);
      if (parsed && typeof parsed === "object" && "reasoning" in parsed) {
        const r = (parsed as { reasoning?: unknown }).reasoning;
        if (typeof r === "string") reasoning = r;
      }
    } catch {
      // ignore — broken JSON in job_scores doesn't take down the dashboard
    }
  }
  return { fitScore: Number(row.fit_score), reasoning };
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
  if (!tableExists(db, "apply_runs")) return empty;
  const columns = new Set(
    allRows<{ name: string }>(db, "PRAGMA table_info(apply_runs)").map((row) => row.name),
  );
  const select = ["run_id", "status"];
  if (columns.has("result")) select.push("result");
  if (columns.has("started_at")) select.push("started_at");
  if (columns.has("finished_at")) select.push("finished_at");
  if (columns.has("worker_id")) select.push("worker_id");
  if (columns.has("model")) select.push("model");
  if (columns.has("dry_run")) select.push("dry_run");
  if (columns.has("duration_ms")) select.push("duration_ms");
  const row = getRow<Record<string, unknown>>(
    db,
    `SELECT ${select.join(", ")} FROM apply_runs WHERE job_url = ?
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
    "SELECT deleted_at FROM jobhunter_deleted_jobs WHERE job_url = ? AND restored_at IS NULL",
    [jobUrl],
  );
  return row ? nullableString(row.deleted_at) : null;
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
  const employer = companyName(site, applicationUrl ?? jobUrl);

  const firstActionable =
    stages.find((s) => !["succeeded", "skipped"].includes(s.state)) ?? stages[stages.length - 1];

  const fitScore = score.fitScore ?? nullableNumber(job.fit_score);
  const scoreReasoning = score.reasoning || stringField(job.score_reasoning);

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
       fit_score, score_reasoning, current_stage, current_state,
       current_error_code, current_error_message, current_next_action,
       has_resume, has_cover_letter, has_pdf, apply_status, applied_at,
       artifact_count, deleted_at, last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       score_reasoning       = excluded.score_reasoning,
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
    stringField(job.location),
    stringField(job.salary),
    applicationUrl,
    nullableString(job.discovered_at),
    description,
    fullDescription,
    fitScore,
    scoreReasoning,
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
       tenant_id, job_id, description_preview, score_reasoning, stages_json,
       last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, job_id) DO UPDATE SET
       description_preview = excluded.description_preview,
       score_reasoning     = excluded.score_reasoning,
       stages_json         = excluded.stages_json,
       last_updated_at     = excluded.last_updated_at`,
  ).run(
    tenantId,
    jobUrl,
    previewText(fullDescription || description, 6000),
    scoreReasoning,
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
      const artifactType = canonicalArtifactType(row.artifact_type);
      const key = `${artifactType}:${row.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        artifactId: row.artifact_id || key,
        artifactType,
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
      const artifactType = canonicalArtifactType(row.artifact_type);
      const key = `${artifactType}:${row.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        artifactId: String(row.row_id ?? key),
        artifactType,
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

function canonicalArtifactType(value: string | null | undefined): string {
  if (value === "tailored_resume") return "tailored_resume_txt";
  if (value === "resume_pdf") return "tailored_resume_pdf";
  if (value === "cover_letter") return "cover_letter_txt";
  return value || "artifact";
}

function pdfSibling(value: string | null | undefined): string | null {
  if (!value) return null;
  return `${value.replace(/\.[^.]+$/, "")}.pdf`;
}

function rebuildApplyRunProjections(db: SqliteDatabase, tenantId: string): void {
  if (!tableExists(db, "apply_runs")) return;
  const columns = new Set(
    allRows<{ name: string }>(db, "PRAGMA table_info(apply_runs)").map((row) => row.name),
  );
  const select = ["run_id", "job_url"];
  for (const col of [
    "site",
    "title",
    "status",
    "result",
    "dry_run",
    "worker_id",
    "model",
    "started_at",
    "finished_at",
    "duration_ms",
  ]) {
    if (columns.has(col)) select.push(col);
  }
  const rows = allRows<Record<string, unknown>>(
    db,
    `SELECT ${select.join(", ")} FROM apply_runs ORDER BY started_at DESC`,
  );
  const insert = db.prepare(
    `INSERT INTO apply_run_projections (
       run_id, tenant_id, job_id, job_title, job_employer, status, result,
       dry_run, worker_id, model, started_at, finished_at, duration_ms,
       events_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       tenant_id    = excluded.tenant_id,
       job_id       = excluded.job_id,
       job_title    = excluded.job_title,
       job_employer = excluded.job_employer,
       status       = excluded.status,
       result       = excluded.result,
       dry_run      = excluded.dry_run,
       worker_id    = excluded.worker_id,
       model        = excluded.model,
       started_at   = excluded.started_at,
       finished_at  = excluded.finished_at,
       duration_ms  = excluded.duration_ms,
       events_json  = excluded.events_json`,
  );
  for (const row of rows) {
    const runId = String(row.run_id ?? "");
    if (!runId) continue;
    const jobUrl = String(row.job_url ?? "");
    const title = stringField(row.title) || "Untitled";
    const employer = companyName(stringField(row.site), jobUrl);
    const events = loadApplyRunEvents(db, runId);
    insert.run(
      runId,
      tenantId,
      jobUrl,
      title,
      employer,
      stringField(row.status) || "unknown",
      nullableString(row.result),
      row.dry_run ? 1 : 0,
      nullableNumber(row.worker_id),
      nullableString(row.model),
      nullableString(row.started_at),
      nullableString(row.finished_at),
      nullableNumber(row.duration_ms),
      JSON.stringify(events),
    );
  }
}

function loadApplyRunEvents(db: SqliteDatabase, runId: string): Record<string, unknown>[] {
  if (!tableExists(db, "apply_run_events")) return [];
  return allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM apply_run_events WHERE run_id = ? ORDER BY rowid ASC",
    [runId],
  );
}

function rebuildDashboardProjection(db: SqliteDatabase, tenantId: string): void {
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
     FROM job_list_projections WHERE tenant_id = ?`,
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
  if (tableExists(db, "apply_runs")) {
    if (tableExists(db, "jobhunter_deleted_jobs")) {
      const dryRunsRow = getRow<{ c: number }>(
        db,
        `SELECT COUNT(*) AS c FROM apply_runs ar
         LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = ar.job_url AND d.restored_at IS NULL
         WHERE ar.dry_run = 1 AND d.job_url IS NULL`,
      );
      dryRuns = dryRunsRow ? Number(dryRunsRow.c) : 0;
    } else {
      const dryRunsRow = getRow<{ c: number }>(
        db,
        "SELECT COUNT(*) AS c FROM apply_runs WHERE dry_run = 1",
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

// =============================================================== helpers

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
