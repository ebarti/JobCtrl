/**
 * TS read-model projection refresher (Phase 9 / S-32, S-33).
 *
 * Mirror of ``workers/automation/src/jobctrl/infrastructure/projections/
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
 * jobctrl_deleted_jobs, job_artifacts, job_materials_artifacts).
 *
 * PR 4 of the Temporal stack collapsed the bespoke ``apply_runs``
 * table; the Python projection builder now sources
 * ``apply_run_projections`` from the ``job_events`` stream. This TS
 * refresher reads the projection table directly and no longer
 * materialises it.
 */
import { PROJECTION_WATERMARK_NAME, STAGES } from "./contracts.js";
import {
  allRows,
  getRow,
  hasCompositeJobIdForeignKey,
  jobReferenceColumn,
  jobReferenceForUrl,
  jobReferenceJoinToJobs,
  jobReferencePredicateForUrl,
  tableColumnSet,
  tableExists,
  type SqliteDatabase,
  type SqliteValue,
} from "./db.js";
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
const CONTACT_EVENT_TYPES = new Set([
  "ContactCreated",
  "ContactUpdated",
  "ContactAttributeRecorded",
  "ContactDeleted",
  "WarmIntroIdentified",
]);
const CONTACT_RESEARCH_EVENT_TYPES = new Set([
  "ContactResearchTaskStarted",
  "ContactCandidateProposed",
  "ContactResearchTaskNeedsReview",
  "ContactResearchTaskCompleted",
  "ContactResearchTaskFailed",
]);
const OUTREACH_EVENT_TYPES = new Set([
  "OutreachDraftGenerated",
  "OutreachDraftRevised",
  "OutreachDraftApproved",
  "OutreachDraftRejected",
  "OutreachSendLogged",
  "FollowUpScheduled",
  "FollowUpCompleted",
  "FollowUpDismissed",
]);
const PIPELINE_STEP_EVENT_TYPES = new Set([
  "PipelineStepQueued",
  "PipelineStepStarted",
  "PipelineStepCompleted",
  "PipelineStepFailed",
]);
const PIPELINE_STEP_EVENT_STATES = {
  PipelineStepQueued: "queued",
  PipelineStepStarted: "running",
  PipelineStepCompleted: "succeeded",
  PipelineStepFailed: "failed",
} as const;
const PIPELINE_STEP_KINDS = new Set([
  "source_planning",
  "source_family",
  "enrichment_pass",
  "preparation_fanout",
  "existing_backlog_sweep",
  "pdf_render",
]);
const PIPELINE_STEP_DETAIL_CODES = new Set([
  "source_plan",
  "source_family",
  "streaming_pass",
  "terminal_reconciliation",
  "existing_backlog",
  "pdf_render",
]);
const SAFE_PIPELINE_ITEM_KEY = /^[a-z0-9][a-z0-9_.:-]{0,159}$/;
const SAFE_PIPELINE_ERROR_CODE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;

type PipelineStepProjectionState = "queued" | "running" | "succeeded" | "failed";

interface PipelineStepProjectionEvent {
  eventId: number;
  occurredAt: string;
  tenantId: string;
  workflowId: string;
  temporalRunId: string;
  stepKind: string;
  itemKey: string;
  state: PipelineStepProjectionState;
  attempt: number;
  lifecycleAt: string;
  durationMs: number | null;
  errorCode: string | null;
  retryable: boolean;
  detailCode: string | null;
  detailCount: number | null;
}

interface PipelineStepProjectionFold extends PipelineStepProjectionEvent {
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastEventId: number;
  lastUpdatedAt: string;
}
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
  tenantId?: string;
  jobId?: string;
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
  const stageJoin = jobReferenceJoinToJobs(
    db,
    "job_stage_states",
    "jss",
    "j",
  );
  const stableStageReferences = jobReferenceColumn(
    db,
    "job_stage_states",
  ) === "job_id";
  const legacyJobs = allRows<{
    tenant_id: string;
    job_id: string;
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
    `SELECT ${stableStageReferences ? "j.tenant_id" : "'local'"} AS tenant_id,
            ${stableStageReferences ? "j.job_id" : "j.url"} AS job_id,
            j.url, j.discovered_at,
            j.full_description, j.detail_scraped_at,
            j.detail_error, j.fit_score,
            j.tailored_resume_path, j.tailor_attempts,
            j.cover_letter_path, j.cover_attempts,
            j.applied_at, j.apply_status, j.apply_error
     FROM jobs j
     LEFT JOIN job_stage_states jss ON ${stageJoin}
     GROUP BY ${stableStageReferences ? "j.tenant_id, j.job_id, " : ""}j.url
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
    ["tenant_id", (_s, o) => o.tenantId ?? "local"],
    ["job_id", (_s, o) => o.jobId ?? ""],
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
    const tenantId = opts.tenantId ?? "local";
    const fullOpts: BackfillOpts = {
      ...opts,
      jobUrl,
      tenantId,
      jobId: opts.jobId ?? jobReferenceForUrl(
        db,
        "job_stage_states",
        jobUrl,
        tenantId,
      ),
      stage,
    };
    const values = presentColumns.map(([, fn]) => fn(state, fullOpts));
    insert.run(...values);
  };

  for (const row of legacyJobs) {
    if (!row.url) continue;
    insertStage(row.url, "discover", "succeeded", {
      tenantId: row.tenant_id,
      jobId: row.job_id,
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
  const stableReferences = jobReferenceColumn(
    db,
    "job_stage_states",
  ) === "job_id";
  const updateIdentity = stableReferences
    ? "tenant_id = ? AND job_id = ?"
    : "job_url = ?";
  const updateSql = `UPDATE job_stage_states SET ${assignments.join(", ")} WHERE ${updateIdentity} AND stage = ?`;
  const update = db.prepare(updateSql);
  const now = new Date().toISOString();

  for (const [upstream, downstreams] of Object.entries(DEPENDENCY_BLOCKER_MESSAGES)) {
    for (const { downstream, messages } of downstreams) {
      const placeholders = messages.map(() => "?").join(", ");
      const rows = allRows<{
        job_url: string;
        tenant_id: string | null;
        job_id: string | null;
        stage: string;
      }>(
        db,
        `SELECT ${stableReferences ? "jobs.url" : "downstream.job_url"} AS job_url,
                ${stableReferences ? "downstream.tenant_id" : "NULL"} AS tenant_id,
                ${stableReferences ? "downstream.job_id" : "NULL"} AS job_id,
                downstream.stage
           FROM job_stage_states AS downstream
           ${stableReferences
             ? `JOIN jobs
                  ON jobs.tenant_id = downstream.tenant_id
                 AND jobs.job_id = downstream.job_id`
             : ""}
          WHERE downstream.stage = ?
            AND downstream.state = 'blocked'
            AND downstream.error_code = 'BLOCKED'
            AND downstream.error_message IN (${placeholders})
            AND EXISTS (
              SELECT 1
                FROM job_stage_states AS upstream
               WHERE ${stableReferences
                 ? "upstream.tenant_id = downstream.tenant_id AND upstream.job_id = downstream.job_id"
                 : "upstream.job_url = downstream.job_url"}
                 AND upstream.stage = ?
                 AND upstream.state = 'succeeded'
            )`,
        [downstream, ...messages, upstream],
      );
      for (const row of rows) {
        const identityParams: SqliteValue[] = stableReferences
          ? [row.tenant_id, row.job_id]
          : [row.job_url];
        update.run(
          ...(columns.has("updated_at") ? [now] : []),
          ...identityParams,
          row.stage,
        );
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
  const stableReferences = jobReferenceColumn(
    db,
    "job_stage_states",
  ) === "job_id";
  const stableMaterialReferences = jobReferenceColumn(
    db,
    "job_materials_artifacts",
  ) === "job_id";
  if (stableMaterialReferences && !stableReferences) {
    throw new Error(
      "Stable material references require stable job_stage_states references.",
    );
  }
  const stageJobUrl = stableReferences ? "stage_jobs.url" : "s.job_url";
  const materialStageMatch = stableMaterialReferences
    ? "tr.tenant_id = s.tenant_id AND tr.job_id = s.job_id"
    : `tr.job_url = ${stageJobUrl}`;
  const materialArtifactJoin = stableMaterialReferences
    ? "pdf.tenant_id = tr.tenant_id AND pdf.job_id = tr.job_id"
    : "pdf.job_url = tr.job_url";
  const materialCoverJoin = stableMaterialReferences
    ? "cover.tenant_id = tr.tenant_id AND cover.job_id = tr.job_id"
    : "cover.job_url = tr.job_url";
  const rows = allRows<{
    job_url: string;
    tenant_id: string | null;
    job_id: string | null;
    error_message: string | null;
    has_cover_letter: number | string | null;
  }>(
    db,
    `
    SELECT ${stageJobUrl} AS job_url,
           ${stableReferences ? "s.tenant_id" : "NULL"} AS tenant_id,
           ${stableReferences ? "s.job_id" : "NULL"} AS job_id,
           s.error_message,
           EXISTS (
             SELECT 1
               FROM job_materials_artifacts tr
               JOIN job_materials_artifacts pdf
                 ON ${materialArtifactJoin}
                AND pdf.generation = tr.generation
                AND pdf.artifact_type = 'resume_pdf'
                AND pdf.status = 'approved'
                AND COALESCE(TRIM(pdf.path), '') != ''
               JOIN job_materials_artifacts cover
                 ON ${materialCoverJoin}
                AND cover.generation = tr.generation
                AND cover.artifact_type = 'cover_letter'
                AND cover.status = 'approved'
                AND COALESCE(TRIM(cover.path), '') != ''
              WHERE ${materialStageMatch}
                AND tr.artifact_type = 'tailored_resume'
                AND tr.status = 'approved'
                AND COALESCE(TRIM(tr.path), '') != ''
           ) AS has_cover_letter
      FROM job_stage_states s
      ${stableReferences
        ? `JOIN jobs stage_jobs
             ON stage_jobs.tenant_id = s.tenant_id
            AND stage_jobs.job_id = s.job_id`
        : ""}
     WHERE s.stage = 'cover'
       AND s.state = 'failed'
       AND s.error_code = 'COVER_FAILED'
       AND s.error_message LIKE 'MaterialsSet generation conflict%'
       AND s.error_message LIKE '%(or current==%'
       AND EXISTS (
             SELECT 1
               FROM job_materials_artifacts tr
               JOIN job_materials_artifacts pdf
                 ON ${materialArtifactJoin}
                AND pdf.generation = tr.generation
                AND pdf.artifact_type = 'resume_pdf'
                AND pdf.status = 'approved'
                AND COALESCE(TRIM(pdf.path), '') != ''
              WHERE ${materialStageMatch}
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
      WHERE ${stableReferences
        ? "tenant_id = ? AND job_id = ?"
        : "job_url = ?"}
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
    update.run(
      ...values,
      ...(stableReferences
        ? [row.tenant_id, row.job_id]
        : [row.job_url]),
    );
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
    CREATE TABLE IF NOT EXISTS digest_state (
      tenant_id              TEXT PRIMARY KEY DEFAULT 'local',
      last_acknowledged_at   TEXT,
      updated_at             TEXT NOT NULL
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
      fit_band               TEXT,
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
      apply_mode             TEXT,
      resume_template_id     TEXT,
      resume_template_name   TEXT,
      tailoring_policy_version INTEGER,
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
    CREATE TABLE IF NOT EXISTS pipeline_step_projections (
      tenant_id              TEXT NOT NULL,
      discover_workflow_id   TEXT NOT NULL,
      discover_run_id        TEXT NOT NULL,
      step_kind              TEXT NOT NULL CHECK (step_kind IN (
        'source_planning', 'source_family', 'enrichment_pass',
        'preparation_fanout', 'existing_backlog_sweep', 'pdf_render'
      )),
      item_key               TEXT NOT NULL,
      state                  TEXT NOT NULL CHECK (state IN (
        'queued', 'running', 'succeeded', 'failed'
      )),
      attempt                INTEGER NOT NULL CHECK (attempt >= 1),
      queued_at              TEXT,
      started_at             TEXT,
      finished_at            TEXT,
      duration_ms            INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
      error_code             TEXT,
      retryable              INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
      detail_code            TEXT,
      detail_count           INTEGER CHECK (detail_count IS NULL OR detail_count >= 0),
      last_event_id          INTEGER NOT NULL,
      last_updated_at        TEXT NOT NULL,
      PRIMARY KEY (
        tenant_id, discover_workflow_id, discover_run_id, step_kind, item_key
      )
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_step_projections_execution
      ON pipeline_step_projections(
        tenant_id, discover_workflow_id, discover_run_id, step_kind, state
      );
    CREATE INDEX IF NOT EXISTS idx_pipeline_step_projections_updated
      ON pipeline_step_projections(tenant_id, last_updated_at DESC, last_event_id DESC);
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
    CREATE TABLE IF NOT EXISTS contact_projections (
      tenant_id          TEXT NOT NULL DEFAULT 'local',
      contact_id         TEXT NOT NULL,
      employer           TEXT,
      job_id             TEXT,
      role               TEXT NOT NULL DEFAULT 'other',
      attribute_count    INTEGER NOT NULL DEFAULT 0,
      confirmed_count    INTEGER NOT NULL DEFAULT 0,
      source_kinds_json  TEXT NOT NULL DEFAULT '[]',
      provenance_json    TEXT NOT NULL DEFAULT '[]',
      created_at         TEXT,
      updated_at         TEXT,
      last_updated_at    TEXT,
      PRIMARY KEY (tenant_id, contact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_projections_lookup
      ON contact_projections(tenant_id, employer, job_id);
    CREATE TABLE IF NOT EXISTS contact_research_task_projections (
      tenant_id            TEXT NOT NULL DEFAULT 'local',
      task_id              TEXT NOT NULL,
      employer             TEXT,
      job_id               TEXT,
      status               TEXT NOT NULL DEFAULT 'queued',
      candidate_count      INTEGER NOT NULL DEFAULT 0,
      needs_review_count   INTEGER NOT NULL DEFAULT 0,
      confirmed_count      INTEGER NOT NULL DEFAULT 0,
      source_attempts_json TEXT NOT NULL DEFAULT '[]',
      candidates_json      TEXT NOT NULL DEFAULT '[]',
      started_at           TEXT,
      updated_at           TEXT,
      needs_review_at      TEXT,
      completed_at         TEXT,
      failed_at            TEXT,
      error_class          TEXT,
      last_updated_at      TEXT,
      PRIMARY KEY (tenant_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_research_task_projections_lookup
      ON contact_research_task_projections(tenant_id, employer, job_id);
    CREATE TABLE IF NOT EXISTS outreach_thread_projections (
      tenant_id           TEXT NOT NULL DEFAULT 'local',
      thread_id           TEXT NOT NULL,
      contact_id          TEXT NOT NULL,
      job_id              TEXT,
      draft_count         INTEGER NOT NULL DEFAULT 0,
      latest_generation   INTEGER NOT NULL DEFAULT 0,
      has_approved_draft  INTEGER NOT NULL DEFAULT 0,
      approved_draft_id   TEXT,
      latest_status       TEXT,
      drafts_json         TEXT NOT NULL DEFAULT '[]',
      created_at          TEXT,
      updated_at          TEXT,
      last_updated_at     TEXT,
      PRIMARY KEY (tenant_id, thread_id)
    );
    CREATE INDEX IF NOT EXISTS idx_outreach_thread_projections_lookup
      ON outreach_thread_projections(tenant_id, contact_id, job_id);
    CREATE TABLE IF NOT EXISTS due_follow_up_projections (
      tenant_id           TEXT NOT NULL DEFAULT 'local',
      thread_id           TEXT NOT NULL,
      contact_id          TEXT NOT NULL,
      job_id              TEXT,
      due_at              TEXT,
      basis               TEXT,
      state               TEXT NOT NULL DEFAULT 'scheduled',
      created_at          TEXT,
      updated_at          TEXT,
      last_updated_at     TEXT,
      PRIMARY KEY (tenant_id, thread_id)
    );
    CREATE INDEX IF NOT EXISTS idx_due_follow_up_projections_due
      ON due_follow_up_projections(tenant_id, due_at);
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
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "fit_band", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "apply_mode", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "resume_template_id", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "resume_template_name", "TEXT") || schemaChanged;
  schemaChanged = ensureProjectionColumn(db, "job_list_projections", "tailoring_policy_version", "INTEGER") || schemaChanged;
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
/**
 * Force-rebuild the research-task read model from canonical rows. Confirming a
 * candidate that leaves other candidates awaiting review advances no research
 * lifecycle event, so the event-watermark path would not mark the read model
 * dirty; the confirm route calls this directly to keep the projection honest.
 */
export function refreshContactResearchProjections(db: SqliteDatabase, tenantId = "local"): void {
  ensureProjectionTables(db);
  rebuildContactResearchProjections(db, tenantId);
}

/**
 * Force-rebuild the outreach-thread read model from canonical rows. Approve /
 * reject transitions and worker-side draft generation each emit an outreach
 * event, but callers rebuild directly so the projection is honest the instant a
 * write returns (mirrors `refreshContactResearchProjections`).
 */
export function refreshOutreachProjections(db: SqliteDatabase, tenantId = "local"): void {
  ensureProjectionTables(db);
  rebuildOutreachProjections(db, tenantId);
  rebuildDueFollowUpProjections(db, tenantId);
}

function pipelineStepsBackfillPending(db: SqliteDatabase, tenantId: string): boolean {
  if (!tableExists(db, "job_events") || !tableExists(db, "pipeline_step_projections")) {
    return false;
  }
  const placeholders = [...PIPELINE_STEP_EVENT_TYPES].map(() => "?").join(", ");
  const eventCount =
    getRow<{ c: number }>(
      db,
      `SELECT COUNT(DISTINCT
          JSON_EXTRACT(payload_json, '$.execution.workflowId') || char(31) ||
          JSON_EXTRACT(payload_json, '$.execution.temporalRunId') || char(31) ||
          JSON_EXTRACT(payload_json, '$.stepKind') || char(31) ||
          JSON_EXTRACT(payload_json, '$.itemKey')
        ) AS c
         FROM job_events
        WHERE event_type IN (${placeholders})
          AND payload_json IS NOT NULL
          AND json_valid(payload_json)
          AND JSON_EXTRACT(payload_json, '$.execution.tenantId') = ?`,
      [...PIPELINE_STEP_EVENT_TYPES].sort().concat(tenantId),
    )?.c ?? 0;
  const projectionCount =
    getRow<{ c: number }>(
      db,
      "SELECT COUNT(*) AS c FROM pipeline_step_projections WHERE tenant_id = ?",
      [tenantId],
    )?.c ?? 0;
  return Number(eventCount) > Number(projectionCount);
}

function parsePipelineStepProjectionEvent(
  row: { event_id: number; event_type: string; occurred_at: string | null; payload_json: string | null },
  tenantId: string,
): PipelineStepProjectionEvent | null {
  if (!PIPELINE_STEP_EVENT_TYPES.has(row.event_type)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json ?? "{}");
  } catch {
    return null;
  }
  if (!isRecord(payload) || !isRecord(payload.execution)) return null;
  const execution = payload.execution;
  if (
    execution.tenantId !== tenantId ||
    typeof execution.workflowId !== "string" ||
    execution.workflowId.trim() === "" ||
    typeof execution.temporalRunId !== "string" ||
    execution.temporalRunId.trim() === ""
  ) {
    return null;
  }
  if (
    typeof payload.stepKind !== "string" ||
    !PIPELINE_STEP_KINDS.has(payload.stepKind) ||
    typeof payload.itemKey !== "string" ||
    !SAFE_PIPELINE_ITEM_KEY.test(payload.itemKey) ||
    typeof payload.attempt !== "number" ||
    !Number.isSafeInteger(payload.attempt) ||
    payload.attempt < 1
  ) {
    return null;
  }

  let detailCode: string | null = null;
  let detailCount: number | null = null;
  if (payload.detail !== null && payload.detail !== undefined) {
    if (
      !isRecord(payload.detail) ||
      typeof payload.detail.code !== "string" ||
      !PIPELINE_STEP_DETAIL_CODES.has(payload.detail.code)
    ) {
      return null;
    }
    if (
      payload.detail.itemCount !== null &&
      payload.detail.itemCount !== undefined &&
      (typeof payload.detail.itemCount !== "number" ||
        !Number.isSafeInteger(payload.detail.itemCount) ||
        payload.detail.itemCount < 0)
    ) {
      return null;
    }
    detailCode = payload.detail.code;
    detailCount =
      payload.detail.itemCount === null || payload.detail.itemCount === undefined
        ? null
        : Number(payload.detail.itemCount);
  }

  const eventType = row.event_type as keyof typeof PIPELINE_STEP_EVENT_STATES;
  const state = PIPELINE_STEP_EVENT_STATES[eventType];
  const timeField = {
    queued: "queuedAt",
    running: "startedAt",
    succeeded: "completedAt",
    failed: "failedAt",
  }[state];
  const lifecycleAt = payload[timeField];
  if (typeof lifecycleAt !== "string" || lifecycleAt.trim() === "") return null;

  let durationMs: number | null = null;
  if (state === "succeeded" || state === "failed") {
    if (
      payload.durationMs !== null &&
      payload.durationMs !== undefined &&
      (typeof payload.durationMs !== "number" ||
        !Number.isSafeInteger(payload.durationMs) ||
        payload.durationMs < 0)
    ) {
      return null;
    }
    durationMs =
      payload.durationMs === null || payload.durationMs === undefined
        ? null
        : Number(payload.durationMs);
  }

  let errorCode: string | null = null;
  let retryable = false;
  if (state === "failed") {
    if (
      typeof payload.errorCode !== "string" ||
      !SAFE_PIPELINE_ERROR_CODE.test(payload.errorCode) ||
      typeof payload.retryable !== "boolean"
    ) {
      return null;
    }
    errorCode = payload.errorCode;
    retryable = payload.retryable;
  }

  const eventId = Number(row.event_id);
  if (!Number.isSafeInteger(eventId) || eventId < 1) return null;
  return {
    eventId,
    occurredAt: row.occurred_at || lifecycleAt,
    tenantId,
    workflowId: execution.workflowId,
    temporalRunId: execution.temporalRunId,
    stepKind: payload.stepKind,
    itemKey: payload.itemKey,
    state,
    attempt: payload.attempt,
    lifecycleAt,
    durationMs,
    errorCode,
    retryable,
    detailCode,
    detailCount,
  };
}

function newPipelineStepProjectionFold(
  event: PipelineStepProjectionEvent,
): PipelineStepProjectionFold {
  return {
    ...event,
    queuedAt: event.state === "queued" ? event.lifecycleAt : null,
    startedAt: event.state === "running" ? event.lifecycleAt : null,
    finishedAt:
      event.state === "succeeded" || event.state === "failed" ? event.lifecycleAt : null,
    lastEventId: event.eventId,
    lastUpdatedAt: event.occurredAt,
  };
}

function rebuildPipelineStepProjections(db: SqliteDatabase, tenantId: string): void {
  if (!tableExists(db, "job_events")) return;
  const placeholders = [...PIPELINE_STEP_EVENT_TYPES].map(() => "?").join(", ");
  const rows = allRows<{
    event_id: number;
    event_type: string;
    occurred_at: string | null;
    payload_json: string | null;
  }>(
    db,
    `SELECT event_id, event_type, occurred_at, payload_json
       FROM job_events
      WHERE event_type IN (${placeholders})
      ORDER BY event_id ASC`,
    [...PIPELINE_STEP_EVENT_TYPES].sort(),
  );
  const folded = new Map<string, PipelineStepProjectionFold>();
  for (const row of rows) {
    const event = parsePipelineStepProjectionEvent(row, tenantId);
    if (!event) continue;
    const key = [event.workflowId, event.temporalRunId, event.stepKind, event.itemKey].join("\u001f");
    const current = folded.get(key);
    if (!current || event.attempt > current.attempt) {
      folded.set(key, newPipelineStepProjectionFold(event));
      continue;
    }
    if (event.attempt < current.attempt) continue;
    if (current.state === "succeeded" || current.state === "failed") continue;
    if (event.state === "queued") continue;
    if (event.state === "running" && current.state === "running") continue;

    const detailCode = event.detailCode ?? current.detailCode;
    const detailCount = event.detailCode === null ? current.detailCount : event.detailCount;
    if (event.state === "running") {
      folded.set(key, {
        ...current,
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        lifecycleAt: event.lifecycleAt,
        state: "running",
        startedAt: event.lifecycleAt,
        finishedAt: null,
        durationMs: null,
        errorCode: null,
        retryable: false,
        detailCode,
        detailCount,
        lastEventId: event.eventId,
        lastUpdatedAt: event.occurredAt,
      });
      continue;
    }
    folded.set(key, {
      ...current,
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      lifecycleAt: event.lifecycleAt,
      state: event.state,
      finishedAt: event.lifecycleAt,
      durationMs: event.durationMs,
      errorCode: event.errorCode,
      retryable: event.retryable,
      detailCode,
      detailCount,
      lastEventId: event.eventId,
      lastUpdatedAt: event.occurredAt,
    });
  }

  const replace = db.transaction(() => {
    db.prepare("DELETE FROM pipeline_step_projections WHERE tenant_id = ?").run(tenantId);
    const insert = db.prepare(`
      INSERT INTO pipeline_step_projections (
        tenant_id, discover_workflow_id, discover_run_id, step_kind, item_key,
        state, attempt, queued_at, started_at, finished_at, duration_ms,
        error_code, retryable, detail_code, detail_count, last_event_id,
        last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const projections = [...folded.values()].sort((left, right) =>
      [left.workflowId, left.temporalRunId, left.stepKind, left.itemKey]
        .join("\u001f")
        .localeCompare(
          [right.workflowId, right.temporalRunId, right.stepKind, right.itemKey].join(
            "\u001f",
          ),
        ),
    );
    for (const projection of projections) {
      insert.run(
        projection.tenantId,
        projection.workflowId,
        projection.temporalRunId,
        projection.stepKind,
        projection.itemKey,
        projection.state,
        projection.attempt,
        projection.queuedAt,
        projection.startedAt,
        projection.finishedAt,
        projection.durationMs,
        projection.errorCode,
        projection.retryable ? 1 : 0,
        projection.detailCode,
        projection.detailCount,
        projection.lastEventId,
        projection.lastUpdatedAt,
      );
    }
  });
  replace();
}

export function refreshProjections(db: SqliteDatabase, tenantId = "local"): void {
  const projectionSchemaChanged = ensureProjectionTables(db);
  backfillLegacyStageStates(db);
  const repairedDependencyJobs = reconcileDependencyBlockers(db);
  const repairedCoverConflictJobs = reconcileObsoleteCoverGenerationConflicts(db);

  const watermark = readWatermark(db, PROJECTION_WATERMARK_NAME);

  let dirtyJobs = new Set<string>([...repairedDependencyJobs, ...repairedCoverConflictJobs]);
  let sourceQualityDirty = false;
  let pipelineStepsDirty = false;
  let evidenceUsageDirty = projectionSchemaChanged;
  let contactsDirty = projectionSchemaChanged;
  let contactResearchDirty = projectionSchemaChanged;
  let outreachDirty = projectionSchemaChanged;
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
      if (PIPELINE_STEP_EVENT_TYPES.has(String(row.event_type))) {
        pipelineStepsDirty = true;
      }
      if (CONTACT_EVENT_TYPES.has(String(row.event_type))) {
        contactsDirty = true;
      }
      if (CONTACT_RESEARCH_EVENT_TYPES.has(String(row.event_type))) {
        contactResearchDirty = true;
      }
      if (OUTREACH_EVENT_TYPES.has(String(row.event_type))) {
        outreachDirty = true;
      }
      evidenceUsageDirty = true;
    }
  }
  // First-run backfill for contacts: canonical rows exist but the read model is
  // empty (e.g. tables recreated). Mirrors the Python builder's backfill.
  if (!contactsDirty && contactsBackfillPending(db, tenantId)) {
    contactsDirty = true;
  }
  if (!contactResearchDirty && contactResearchBackfillPending(db, tenantId)) {
    contactResearchDirty = true;
  }
  if (!outreachDirty && outreachBackfillPending(db, tenantId)) {
    outreachDirty = true;
  }
  if (!pipelineStepsDirty && pipelineStepsBackfillPending(db, tenantId)) {
    pipelineStepsDirty = true;
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
  for (const jobUrl of staleStageProjectionJobs(db, tenantId)) {
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
    !pipelineStepsDirty &&
    !evidenceUsageDirty &&
    !contactsDirty &&
    !contactResearchDirty &&
    !outreachDirty &&
    (sourceQualityExists > 0 || !sourceQualityHistory) &&
    maxEventId === watermark
  ) {
    return;
  }

  if (sourceQualityDirty || (sourceQualityExists === 0 && sourceQualityHistory)) {
    rebuildSourceQualityProjections(db, tenantId);
  }
  if (pipelineStepsDirty) {
    rebuildPipelineStepProjections(db, tenantId);
  }
  if (contactsDirty) {
    rebuildContactProjections(db, tenantId);
  }
  if (contactResearchDirty) {
    rebuildContactResearchProjections(db, tenantId);
  }
  if (outreachDirty) {
    rebuildOutreachProjections(db, tenantId);
    rebuildDueFollowUpProjections(db, tenantId);
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
  const artifactReference = jobReferencePredicateForUrl(
    db,
    "job_materials_artifacts",
    jobUrl,
  );
  const hasCanonicalHistory = Boolean(
    getRow<{ c: number }>(
      db,
      `SELECT COUNT(*) AS c
         FROM job_materials_artifacts
        WHERE ${artifactReference.sql}
          AND artifact_type IN ('tailored_resume', 'cover_letter', 'resume_pdf', 'cover_letter_pdf')`,
      artifactReference.params,
    )?.c,
  );
  const generationRow = getRow<{ max_generation: number }>(
    db,
    `SELECT MAX(generation) AS max_generation
       FROM job_materials_artifacts
      WHERE ${artifactReference.sql}
        AND status = 'approved'
        AND artifact_type IN ('tailored_resume', 'cover_letter', 'resume_pdf', 'cover_letter_pdf')`,
    artifactReference.params,
  );
  const generation = generationRow ? generationRow.max_generation : null;
  if (generation === null || generation === undefined) {
    return { ...empty, hasCanonicalHistory };
  }
  const artifacts = allRows<{ artifact_type: string; path: string; created_at: string | null }>(
    db,
    `SELECT artifact_type, path, created_at FROM job_materials_artifacts
     WHERE ${artifactReference.sql} AND generation = ? AND status = 'approved'`,
    [...artifactReference.params, Number(generation)],
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

interface MaterialAnalytics {
  resumeTemplateId: string | null;
  resumeTemplateName: string | null;
  tailoringPolicyVersion: number | null;
}

const EMPTY_MATERIAL_ANALYTICS: MaterialAnalytics = {
  resumeTemplateId: null,
  resumeTemplateName: null,
  tailoringPolicyVersion: null,
};

function loadMaterialAnalytics(db: SqliteDatabase, jobUrl: string): MaterialAnalytics {
  if (!tableExists(db, "job_materials_artifacts") || !hasColumn(db, "job_materials_artifacts", "metadata_json")) {
    return { ...EMPTY_MATERIAL_ANALYTICS };
  }
  const hasMaterialMetadata = tableExists(db, "job_materials") && hasColumn(db, "job_materials", "metadata_json");
  const materialMetadataSelect = hasMaterialMetadata ? "m.metadata_json AS material_metadata_json" : "NULL AS material_metadata_json";
  const stableReferences = jobReferenceColumn(
    db,
    "job_materials_artifacts",
  ) === "job_id";
  const materialMetadataJoin = hasMaterialMetadata
    ? `LEFT JOIN job_materials m
             ON ${stableReferences
               ? "m.tenant_id = a.tenant_id AND m.job_id = a.job_id"
               : "m.job_url = a.job_url"}
            AND m.generation = a.generation`
    : "";
  const artifactReference = jobReferencePredicateForUrl(
    db,
    "job_materials_artifacts",
    jobUrl,
    "local",
    "a",
  );
  const row = getRow<{
    artifact_id: string | null;
    generation: number | null;
    metadata_json: string | null;
    material_metadata_json: string | null;
  }>(
    db,
    `SELECT a.artifact_id, a.generation, a.metadata_json, ${materialMetadataSelect}
       FROM job_materials_artifacts a
       ${materialMetadataJoin}
      WHERE ${artifactReference.sql}
        AND a.status = 'approved'
        AND a.artifact_type IN ('tailored_resume', 'tailored_resume_txt', 'resume_pdf')
      ORDER BY COALESCE(a.generation, -1) DESC,
               CASE a.artifact_type
                 WHEN 'tailored_resume' THEN 0
                 WHEN 'tailored_resume_txt' THEN 1
                 WHEN 'resume_pdf' THEN 2
                 ELSE 3
               END,
               a.created_at DESC,
               a.rowid DESC
      LIMIT 1`,
    artifactReference.params,
  );
  const metadataJsons = [row?.metadata_json ?? null, row?.material_metadata_json ?? null];
  const current = mergeMaterialAnalytics(metadataJsons);
  if (materialAnalyticsComplete(current)) return current;
  return mergeMaterialAnalytics([...metadataJsons, ...loadBaseMaterialMetadata(db, jobUrl, metadataJsons)]);
}

function materialAnalyticsFromMetadata(metadataJson: string | null): MaterialAnalytics {
  const metadata = parseProjectionJsonRecord(metadataJson);
  if (!metadata) return { ...EMPTY_MATERIAL_ANALYTICS };
  const template = isRecord(metadata.resume_template) ? metadata.resume_template : {};
  return {
    resumeTemplateId: projectionText(template.templateId ?? template.template_id),
    resumeTemplateName: projectionText(template.templateName ?? template.template_name ?? template.displayName),
    tailoringPolicyVersion: projectionInteger(metadata.tailoring_policy_version ?? metadata.tailoringPolicyVersion),
  };
}

function mergeMaterialAnalytics(metadataJsons: Array<string | null>): MaterialAnalytics {
  const merged = { ...EMPTY_MATERIAL_ANALYTICS };
  for (const metadataJson of metadataJsons) {
    const next = materialAnalyticsFromMetadata(metadataJson);
    merged.resumeTemplateId ??= next.resumeTemplateId;
    merged.resumeTemplateName ??= next.resumeTemplateName;
    merged.tailoringPolicyVersion ??= next.tailoringPolicyVersion;
  }
  return merged;
}

function materialAnalyticsComplete(value: MaterialAnalytics): boolean {
  return value.resumeTemplateId !== null && value.resumeTemplateName !== null && value.tailoringPolicyVersion !== null;
}

function loadBaseMaterialMetadata(db: SqliteDatabase, jobUrl: string, metadataJsons: Array<string | null>): Array<string | null> {
  const references = materialMetadataReferences(metadataJsons);
  const metadata: Array<string | null> = [];
  if (
    references.baseGeneration !== null &&
    tableExists(db, "job_materials") &&
    hasColumn(db, "job_materials", "metadata_json")
  ) {
    const materialReference = jobReferencePredicateForUrl(
      db,
      "job_materials",
      jobUrl,
    );
    const row = getRow<{ metadata_json: string | null }>(
      db,
      `SELECT metadata_json
         FROM job_materials
        WHERE ${materialReference.sql} AND generation = ?
        LIMIT 1`,
      [...materialReference.params, references.baseGeneration],
    );
    metadata.push(row?.metadata_json ?? null);
  }
  if (references.baseGeneration !== null) {
    const artifactReference = jobReferencePredicateForUrl(
      db,
      "job_materials_artifacts",
      jobUrl,
    );
    metadata.push(
      ...allRows<{ metadata_json: string | null }>(
        db,
        `SELECT metadata_json
           FROM job_materials_artifacts
          WHERE ${artifactReference.sql}
            AND generation = ?
            AND artifact_type IN ('tailored_resume', 'tailored_resume_txt', 'resume_pdf')
          ORDER BY CASE artifact_type
                     WHEN 'tailored_resume' THEN 0
                     WHEN 'tailored_resume_txt' THEN 1
                     WHEN 'resume_pdf' THEN 2
                     ELSE 3
                   END,
                   rowid DESC`,
        [...artifactReference.params, references.baseGeneration],
      ).map((row) => row.metadata_json),
    );
  }
  if (references.baseArtifactIds.length > 0) {
    const artifactReference = jobReferencePredicateForUrl(
      db,
      "job_materials_artifacts",
      jobUrl,
    );
    const placeholders = references.baseArtifactIds.map(() => "?").join(", ");
    metadata.push(
      ...allRows<{ metadata_json: string | null }>(
        db,
        `SELECT metadata_json
           FROM job_materials_artifacts
          WHERE ${artifactReference.sql}
            AND artifact_id IN (${placeholders})
          ORDER BY COALESCE(generation, -1) DESC,
                   CASE artifact_type
                     WHEN 'tailored_resume' THEN 0
                     WHEN 'tailored_resume_txt' THEN 1
                     WHEN 'resume_pdf' THEN 2
                     ELSE 3
                   END,
                   rowid DESC`,
        [...artifactReference.params, ...references.baseArtifactIds],
      ).map((row) => row.metadata_json),
    );
  }
  return metadata;
}

function materialMetadataReferences(metadataJsons: Array<string | null>): {
  baseGeneration: number | null;
  baseArtifactIds: string[];
} {
  let baseGeneration: number | null = null;
  const baseArtifactIds = new Set<string>();
  for (const metadataJson of metadataJsons) {
    const metadata = parseProjectionJsonRecord(metadataJson);
    if (!metadata) continue;
    baseGeneration ??= projectionInteger(metadata.base_generation ?? metadata.baseGeneration);
    for (const key of [
      "base_resume_text_artifact_id",
      "baseResumeTextArtifactId",
      "base_resume_pdf_artifact_id",
      "baseResumePdfArtifactId",
    ]) {
      const id = projectionText(metadata[key]);
      if (id) baseArtifactIds.add(id);
    }
  }
  return { baseGeneration, baseArtifactIds: [...baseArtifactIds] };
}

function parseProjectionJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function projectionText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function projectionInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.trunc(number);
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

const FIT_BAND_ORDER = ["excellent", "strong", "plausible", "stretch", "poor", "unreported"] as const;
const APPLY_MODE_ORDER = ["automated_live", "manual_marked", "external_confirmed"] as const;

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
function loadEmployerAnalysisJson(
  db: SqliteDatabase,
  tenantId: string,
  jobUrl: string,
): string | null {
  if (!tableExists(db, "job_employer_analysis")) return null;
  const referenceColumn = jobReferenceColumn(
    db,
    "job_employer_analysis",
  );
  const predicate = jobReferencePredicateForUrl(
    db,
    "job_employer_analysis",
    jobUrl,
    tenantId,
    "analysis",
  );
  const row = getRow<EmployerAnalysisRow>(
    db,
    `SELECT * FROM job_employer_analysis AS analysis
      WHERE ${predicate.sql}
      ORDER BY generation DESC LIMIT 1`,
    predicate.params,
  );
  if (!row) return null;
  const reference = String(row[referenceColumn]);
  const generation = Number(row.generation);
  const legsAttempted = Number(row.legs_attempted);
  const legsSucceeded = Number(row.legs_succeeded);
  const agreement = parseAnalysisAgreement(row.agreement_json);
  const subAnalysisHasTenant = tableColumnSet(
    db,
    "job_employer_analysis_sub_analyses",
  ).has("tenant_id");
  const failureHasTenant = tableColumnSet(
    db,
    "job_employer_analysis_failures",
  ).has("tenant_id");

  const subRows = allRows<{ model_id: string; analysis_json: string }>(
    db,
    `SELECT model_id, analysis_json FROM job_employer_analysis_sub_analyses
      WHERE ${subAnalysisHasTenant ? "tenant_id = ? AND " : ""}${referenceColumn} = ?
        AND generation = ? ORDER BY model_id`,
    [
      ...(subAnalysisHasTenant ? [tenantId] : []),
      reference,
      generation,
    ],
  );
  const failureRows = allRows<{ model_id: string; error: string; raw_output: string | null }>(
    db,
    `SELECT model_id, error, raw_output FROM job_employer_analysis_failures
      WHERE ${failureHasTenant ? "tenant_id = ? AND " : ""}${referenceColumn} = ?
        AND generation = ? ORDER BY model_id`,
    [
      ...(failureHasTenant ? [tenantId] : []),
      reference,
      generation,
    ],
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
  const reportReference = jobReferenceColumn(db, "job_requirement_fit_reports");
  const itemReference = jobReferenceColumn(db, "job_requirement_fit_items");
  const referenceValue = jobReferenceForUrl(
    db,
    "job_requirement_fit_reports",
    jobUrl,
    tenantId,
  );
  const itemReferenceValue = jobReferenceForUrl(
    db,
    "job_requirement_fit_items",
    jobUrl,
    tenantId,
  );
  const row = getRow<RequirementFitReportRow>(
    db,
    `SELECT ${reportReference} AS job_reference,
            score_version, tenant_id, employer_analysis_generation,
            profile_snapshot_version, scoring_policy_version, formula_version,
            resolved_fit_score, fit_band, confidence, summary_json
       FROM job_requirement_fit_reports
      WHERE tenant_id = ? AND ${reportReference} = ?
      ORDER BY score_version DESC
      LIMIT 1`,
    [tenantId, referenceValue],
  );
  if (!row) return null;
  const scoreVersion = Number(row.score_version);
  const items = allRows<RequirementFitItemRow>(
    db,
    `SELECT requirement_id, requirement_text, tier, weight, job_evidence_span,
            fit_json, contribution_json, tailoring_json, artifact_coverage_json
       FROM job_requirement_fit_items
      WHERE tenant_id = ? AND ${itemReference} = ? AND score_version = ?
      ORDER BY position ASC, requirement_id ASC`,
    [tenantId, itemReferenceValue, scoreVersion],
  );
  const readModel = {
    jobKey: jobUrl,
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

function loadLatestRequirementFitBand(
  db: SqliteDatabase,
  tenantId: string,
  jobUrl: string,
): string | null {
  if (!tableExists(db, "job_requirement_fit_reports")) return null;
  const referenceColumn = jobReferenceColumn(
    db,
    "job_requirement_fit_reports",
  );
  const referenceValue = jobReferenceForUrl(
    db,
    "job_requirement_fit_reports",
    jobUrl,
    tenantId,
  );
  const row = getRow<{ fit_band: string | null }>(
    db,
    `SELECT fit_band
       FROM job_requirement_fit_reports
      WHERE tenant_id = ? AND ${referenceColumn} = ?
      ORDER BY score_version DESC
      LIMIT 1`,
    [tenantId, referenceValue],
  );
  return nullableString(row?.fit_band);
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
 * Phase 2 — load per-bullet provenance read shapes keyed by artifact.
 *
 * Mirrors the Python ``BulletProvenanceSet.to_read_model()`` projection so the
 * TS API and Python builder materialise the SAME read shape — the cross-runtime
 * parity test asserts both agree. Returns an empty map when no provenance exists.
 * Artifact detail pages can inspect historical generations, so project every
 * artifact_id row set instead of only the latest job generation.
 */
function loadBulletProvenanceByArtifact(
  db: SqliteDatabase,
  tenantId: string,
  jobUrl: string,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!tableExists(db, "job_bullet_provenance")) return result;
  const provenanceReference = jobReferencePredicateForUrl(
    db,
    "job_bullet_provenance",
    jobUrl,
    tenantId,
  );
  const rows = allRows<BulletProvenanceRow>(
    db,
    `SELECT * FROM job_bullet_provenance
      WHERE tenant_id = ? AND ${provenanceReference.sql}
      ORDER BY generation, position, bullet_id`,
    [tenantId, ...provenanceReference.params],
  );
  if (rows.length === 0) return result;
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
 * Phase 3 — load set-level coverage + voice read shapes,
 * keyed by artifact.
 *
 * Coverage (GROUND-06) and the voice-pass audit (VOICE-02) are set-level facts
 * denormalised onto every ``job_bullet_provenance`` row (the Python repo writes
 * the same value on every row of a generation), so we read the first non-empty
 * row for each artifact_id. Returns ``{ coverage, voice }`` maps mirroring the
 * Python projection builder so the cross-runtime parity test asserts both agree.
 * Empty maps when no provenance exists or the columns predate Phase 3.
 */
function loadProvenanceAuxByArtifact(
  db: SqliteDatabase,
  tenantId: string,
  jobUrl: string,
): { coverage: Map<string, string>; voice: Map<string, string> } {
  const coverage = new Map<string, string>();
  const voice = new Map<string, string>();
  if (!tableExists(db, "job_bullet_provenance")) return { coverage, voice };
  const provenanceReference = jobReferencePredicateForUrl(
    db,
    "job_bullet_provenance",
    jobUrl,
    tenantId,
  );
  let rows: Array<{ artifact_id: string; coverage_json: string | null; voice_json: string | null }> = [];
  try {
    rows = allRows<{ artifact_id: string; coverage_json: string | null; voice_json: string | null }>(
      db,
      `SELECT artifact_id, coverage_json, voice_json FROM job_bullet_provenance
        WHERE tenant_id = ? AND ${provenanceReference.sql}
        ORDER BY generation, position, bullet_id`,
      [tenantId, ...provenanceReference.params],
    );
  } catch {
    // Columns predate Phase 3 (a DB written before this migration ran) — no aux data.
    return { coverage, voice };
  }
  for (const row of rows) {
    if (!coverage.has(row.artifact_id) && row.coverage_json && row.coverage_json.trim()) {
      coverage.set(row.artifact_id, row.coverage_json);
    }
    if (!voice.has(row.artifact_id) && row.voice_json && row.voice_json.trim()) {
      voice.set(row.artifact_id, row.voice_json);
    }
  }
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
  const stableReferences = jobReferenceColumn(
    db,
    "job_bullet_provenance",
  ) === "job_id";
  const jobUrlExpression = stableReferences
    ? "provenance_jobs.url"
    : "provenance.job_url";
  const identityJoin = stableReferences
    ? ` JOIN jobs AS provenance_jobs
           ON provenance_jobs.tenant_id = provenance.tenant_id
          AND provenance_jobs.job_id = provenance.job_id`
    : "";
  const jobMetadata = jobMetadataJoinSql(db, jobUrlExpression);
  const lifecycle = jobLifecycleExclusionSql(db, jobUrlExpression);
  const latestIdentityMatch = stableReferences
    ? "latest.job_id = provenance.job_id"
    : "latest.job_url = provenance.job_url";
  const rows = allRows<BulletProvenanceRow & { job_title: string | null; employer: string | null }>(
    db,
    `SELECT ${jobUrlExpression} AS job_url, provenance.artifact_id, provenance.generation,
            provenance.bullet_id, provenance.section, provenance.source_id,
            provenance.evidence_ids_json, provenance.requirement_ids_json,
            provenance.matched_keywords_json, provenance.transform_type,
            provenance.control, provenance.rationale, provenance.generated_text,
            provenance.position, provenance.created_at,
            ${jobMetadata.selectSql}
       FROM job_bullet_provenance AS provenance
       ${identityJoin}
       ${jobMetadata.joinSql}${lifecycle.joinSql}
      WHERE provenance.tenant_id = ?${lifecycle.whereSql}
        AND provenance.generation = (
          SELECT MAX(latest.generation)
            FROM job_bullet_provenance AS latest
           WHERE latest.tenant_id = provenance.tenant_id
             AND ${latestIdentityMatch}
        )
      ORDER BY ${jobUrlExpression}, provenance.position, provenance.bullet_id`,
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
  const itemReference = jobReferenceColumn(db, "job_requirement_fit_items");
  const reportReference = jobReferenceColumn(db, "job_requirement_fit_reports");
  const stableReferences = itemReference === "job_id";
  const jobUrlExpression = stableReferences ? "score_jobs.url" : "items.job_url";
  const stableJobJoin = stableReferences
    ? `JOIN jobs AS score_jobs
         ON score_jobs.tenant_id = items.tenant_id
        AND score_jobs.job_id = items.job_id`
    : "";
  const jobMetadata = jobMetadataJoinSql(db, jobUrlExpression);
  const lifecycle = jobLifecycleExclusionSql(db, jobUrlExpression);
  const rows = allRows<RequirementFitItemRow & {
    job_url: string;
    score_version: number;
    job_title: string | null;
    employer: string | null;
  }>(
    db,
    `SELECT ${jobUrlExpression} AS job_url,
            items.score_version, items.requirement_id,
            items.requirement_text, items.tier, items.weight, items.job_evidence_span,
            items.fit_json, items.contribution_json, items.tailoring_json,
            items.artifact_coverage_json,
            ${jobMetadata.selectSql}
       FROM job_requirement_fit_items AS items
       ${stableJobJoin}
       ${jobMetadata.joinSql}${lifecycle.joinSql}
      WHERE items.tenant_id = ?${lifecycle.whereSql}
        AND items.score_version = (
          SELECT MAX(report.score_version)
           FROM job_requirement_fit_reports AS report
           WHERE report.tenant_id = items.tenant_id
             AND report.${reportReference} = items.${itemReference}
        )
      ORDER BY ${jobUrlExpression}, items.position, items.requirement_id`,
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
  const lifecycle = jobLifecycleExclusionSql(db, "alp.job_id");
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
    `SELECT alp.job_id, alp.job_title, alp.job_employer, alp.artifact_id, alp.generation,
            alp.coverage_audit_json, alp.created_at
       FROM artifact_list_projections alp${lifecycle.joinSql}
      WHERE alp.tenant_id = ?${lifecycle.whereSql}
        AND alp.coverage_audit_json IS NOT NULL
        AND TRIM(alp.coverage_audit_json) != ''`,
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
  const referenceColumn = jobReferenceColumn(db, "job_scores");
  const referenceValue = jobReferenceForUrl(db, "job_scores", jobUrl);
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
     FROM job_scores
     WHERE tenant_id = 'local'
       AND ${referenceColumn} = ?
     ORDER BY version DESC LIMIT 1`,
    [referenceValue],
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

function loadEnrichment(
  db: SqliteDatabase,
  tenantId: string,
  jobUrl: string,
): EnrichmentLatest {
  const empty: EnrichmentLatest = {
    fullDescription: null,
    applicationUrl: null,
    enrichedAt: null,
    currentStatus: null,
  };
  if (!tableExists(db, "job_enrichments")) {
    return empty;
  }
  const stableReference = hasCompositeJobIdForeignKey(
    db,
    "job_enrichments",
  );
  const row = getRow<{
    full_description: string | null;
    application_url: string | null;
    enriched_at: string | null;
    current_status: string | null;
  }>(
    db,
    `SELECT je.full_description, je.application_url,
            je.enriched_at, je.current_status
       FROM job_enrichments je
       ${stableReference
         ? `JOIN jobs j
              ON j.tenant_id = je.tenant_id
             AND j.job_id = je.job_id`
         : ""}
      WHERE ${stableReference
        ? "je.tenant_id = ? AND j.url = ?"
        : "je.tenant_id = ? AND je.job_url = ?"}`,
    [tenantId, jobUrl],
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
  if (!tableExists(db, "jobctrl_deleted_jobs")) return null;
  const row = getRow<{ deleted_at: string | null }>(
    db,
    "SELECT deleted_at FROM jobctrl_deleted_jobs WHERE job_url = ? AND (restored_at IS NULL OR julianday(restored_at) <= julianday(deleted_at))",
    [jobUrl],
  );
  return row ? nullableString(row.deleted_at) : null;
}

function staleDeletedProjectionJobs(db: SqliteDatabase, tenantId: string): string[] {
  if (!tableExists(db, "jobctrl_deleted_jobs")) return [];
  const rows = allRows<{ job_id: string }>(
    db,
    `SELECT p.job_id
     FROM job_list_projections p
     JOIN jobctrl_deleted_jobs d
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

  const materialJoin = jobReferenceJoinToJobs(
    db,
    "job_materials_artifacts",
    "a",
    "j",
  );
  const stableMaterialReferences = jobReferenceColumn(
    db,
    "job_materials_artifacts",
  ) === "job_id";
  const rows = allRows<{ job_id: string }>(
    db,
    `SELECT DISTINCT j.url AS job_id
       FROM job_materials_artifacts a
       JOIN jobs j
         ON ${materialJoin}
       LEFT JOIN artifact_list_projections p
         ON p.tenant_id = ?
        AND p.job_id = j.url
        AND p.artifact_id = COALESCE(NULLIF(a.artifact_id, ''), a.artifact_type || ':' || a.path)
      WHERE ${stableMaterialReferences ? "a.tenant_id = ? AND" : ""}
        a.artifact_type IN ('tailored_resume', 'tailored_resume_txt')
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
    stableMaterialReferences ? [tenantId, tenantId] : [tenantId],
  );
  return rows.map((row) => row.job_id).filter(Boolean);
}

function staleStageProjectionJobs(db: SqliteDatabase, tenantId: string): string[] {
  if (!tableExists(db, "jobs") || !tableExists(db, "job_stage_states") || !tableExists(db, "job_list_projections")) {
    return [];
  }
  const stageReference = jobReferenceColumn(db, "job_stage_states");
  const stageJoin = jobReferenceJoinToJobs(
    db,
    "job_stage_states",
    "s",
    "j",
  );
  const stageIdentity = stageReference === "job_id"
    ? "s.job_id"
    : "s.job_url";

  const rows = allRows<{ job_id: string }>(
    db,
    `SELECT DISTINCT j.url AS job_id
       FROM job_stage_states s
       JOIN jobs j
         ON ${stageJoin}
       LEFT JOIN job_list_projections p
         ON p.tenant_id = ?
        AND p.job_id = j.url
      WHERE ${stageIdentity} IS NOT NULL
        AND TRIM(${stageIdentity}) != ''
        AND (
          p.job_id IS NULL
          OR (
            s.updated_at IS NOT NULL
            AND TRIM(s.updated_at) != ''
            AND (
              p.last_updated_at IS NULL
              OR TRIM(p.last_updated_at) = ''
              OR julianday(s.updated_at) > COALESCE(julianday(p.last_updated_at), -1)
            )
          )
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
    const reference = jobReferencePredicateForUrl(
      db,
      "job_stage_states",
      jobUrl,
    );
    for (const row of allRows<StageRow>(
      db,
      `SELECT * FROM job_stage_states WHERE ${reference.sql}`,
      reference.params,
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
  const materialAnalytics = loadMaterialAnalytics(db, jobUrl);
  const employerAnalysisJson = loadEmployerAnalysisJson(
    db,
    tenantId,
    jobUrl,
  );
  const requirementFitReportJson = loadRequirementFitReportJson(db, tenantId, jobUrl);
  const requirementFitBand = fitBand(loadLatestRequirementFitBand(db, tenantId, jobUrl));
  const interviewPrepJson = loadInterviewPrepJson(db, tenantId, jobUrl);
  const enrichment = loadEnrichment(db, tenantId, jobUrl);
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
  const applyMode = deriveApplyMode(db, tenantId, jobUrl, apply, nullableString(job.apply_status), nullableString(job.applied_at));

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
     fit_score, fit_band, compensation_summary_json,
     score_breakdown_json, score_keywords_json, score_reasoning,
     score_version, scored_at, score_criteria_json, score_trace_json,
     score_correction_json, current_stage, current_substage, current_state,
     current_error_code, current_error_message, current_next_action,
     has_resume, has_cover_letter, has_pdf, apply_status, applied_at,
     apply_mode, resume_template_id, resume_template_name,
     tailoring_policy_version, artifact_count, deleted_at, last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       fit_band              = excluded.fit_band,
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
       apply_mode            = excluded.apply_mode,
       resume_template_id    = excluded.resume_template_id,
       resume_template_name  = excluded.resume_template_name,
       tailoring_policy_version = excluded.tailoring_policy_version,
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
    requirementFitBand,
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
    applyMode,
    materialAnalytics.resumeTemplateId,
    materialAnalytics.resumeTemplateName,
    materialAnalytics.tailoringPolicyVersion,
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
  const layoutReference = jobReferencePredicateForUrl(
    db,
    "job_material_layout_boxes",
    jobUrl,
    tenantId,
  );
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
      WHERE tenant_id = ? AND ${layoutReference.sql}
      ORDER BY artifact_id, page_number, box_index`,
    [tenantId, ...layoutReference.params],
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
    const materialArtifactReference = jobReferencePredicateForUrl(
      db,
      "job_materials_artifacts",
      jobUrl,
    );
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
       FROM job_materials_artifacts WHERE ${materialArtifactReference.sql}`,
      materialArtifactReference.params,
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
    const artifactReference = jobReferencePredicateForUrl(
      db,
      "job_artifacts",
      jobUrl,
    );
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
       FROM job_artifacts WHERE ${artifactReference.sql}`,
      artifactReference.params,
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
  byFitBand: Array<{ fitBand: string } & ConversionCounts>;
  byApplyMode: Array<{ applyMode: string } & ConversionCounts>;
  byTemplate: Array<{ templateId: string; templateName: string | null } & ConversionCounts>;
  byPolicy: Array<{ tailoringPolicyVersion: number | null; policyLabel: string } & ConversionCounts>;
  timeToResponseMinutes: number[];
  suggestionAccuracy: SuggestionAccuracyCounts;
}

interface OutcomeFact {
  kind: string;
  occurredAt: string | null;
}

interface SuggestionAccuracyCounts {
  decided: number;
  accepted: number;
  corrected: number;
  ignored: number;
}

function scoreBand(fitScore: number | null | undefined): string {
  if (fitScore === null || fitScore === undefined) return "unscored";
  if (fitScore >= 9) return "perfect";
  if (fitScore >= 7) return "strong";
  if (fitScore >= 5) return "moderate";
  if (fitScore >= 3) return "weak";
  return "poor";
}

function fitBand(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return FIT_BAND_ORDER.includes(normalized as (typeof FIT_BAND_ORDER)[number]) ? normalized : "unreported";
}

function applyMode(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return APPLY_MODE_ORDER.includes(normalized as (typeof APPLY_MODE_ORDER)[number]) ? normalized : "manual_marked";
}

function hasAnyKind(outcomes: readonly OutcomeFact[], target: Set<string>): boolean {
  for (const outcome of outcomes) if (target.has(outcome.kind)) return true;
  return false;
}

function loadOutcomesByJob(db: SqliteDatabase, tenantId: string): Map<string, OutcomeFact[]> {
  const result = new Map<string, OutcomeFact[]>();
  if (!tableExists(db, "application_outcomes")) return result;
  const rows = allRows<{ job_key: string; kind: string; occurred_at: string | null }>(
    db,
    "SELECT job_key, kind, occurred_at FROM application_outcomes WHERE tenant_id = ?",
    [tenantId],
  );
  for (const row of rows) {
    if (!row.job_key || !row.kind) continue;
    const list = result.get(row.job_key) ?? [];
    list.push({ kind: row.kind, occurredAt: nullableString(row.occurred_at) });
    result.set(row.job_key, list);
  }
  return result;
}

function loadSuggestionAccuracy(db: SqliteDatabase, tenantId: string): SuggestionAccuracyCounts {
  const counts: SuggestionAccuracyCounts = { decided: 0, accepted: 0, corrected: 0, ignored: 0 };
  if (!tableExists(db, "application_outcome_suggestions")) return counts;
  const rows = allRows<{ status: string }>(
    db,
    `SELECT status
       FROM application_outcome_suggestions
      WHERE tenant_id = ?
        AND status IN ('accepted', 'corrected', 'ignored')`,
    [tenantId],
  );
  for (const row of rows) {
    const status = String(row.status ?? "").trim().toLowerCase();
    switch (status) {
      case "accepted":
        counts.decided += 1;
        counts.accepted += 1;
        break;
      case "corrected":
        counts.decided += 1;
        counts.corrected += 1;
        break;
      case "ignored":
        counts.decided += 1;
        counts.ignored += 1;
        break;
    }
  }
  return counts;
}

function firstResponseMinutes(appliedAt: string | null, outcomes: readonly OutcomeFact[]): number | null {
  const appliedTime = Date.parse(appliedAt ?? "");
  if (!Number.isFinite(appliedTime)) return null;
  let earliest: number | null = null;
  for (const outcome of outcomes) {
    if (!REPLY_OUTCOME_KINDS.has(outcome.kind)) continue;
    const occurredTime = Date.parse(outcome.occurredAt ?? "");
    if (!Number.isFinite(occurredTime) || occurredTime < appliedTime) continue;
    earliest = earliest === null ? occurredTime : Math.min(earliest, occurredTime);
  }
  if (earliest === null) return null;
  return Math.floor((earliest - appliedTime) / 60_000);
}

function templateKey(value: string | null | undefined): string {
  return projectionText(value) ?? "unreported";
}

function policyKey(value: number | null | undefined): string {
  return value === null || value === undefined ? "unreported" : String(Math.trunc(Number(value)));
}

function policyVersionFromKey(value: string): number | null {
  if (value === "unreported") return null;
  const version = Number(value);
  return Number.isFinite(version) ? Math.trunc(version) : null;
}

function policyLabel(version: number | null): string {
  return version === null ? "Unreported" : `Policy v${version}`;
}

function buildOutcomeConversion(
  db: SqliteDatabase,
  tenantId: string,
  active: Array<{
    job_id: string;
    apply_status: string | null;
    applied_at: string | null;
    fit_score: number | null;
    fit_band: string | null;
    apply_mode: string | null;
    resume_template_id: string | null;
    resume_template_name: string | null;
    tailoring_policy_version: number | null;
    source: string;
  }>,
): OutcomeConversion {
  const appliedRows = active.filter((row) => row.applied_at || row.apply_status === "applied");
  const outcomesByJob = loadOutcomesByJob(db, tenantId);
  const suggestionAccuracy = loadSuggestionAccuracy(db, tenantId);
  const blank = (): ConversionCounts => ({ applied: 0, reply: 0, interview: 0, offer: 0, rejection: 0 });
  const totals = blank();
  const bySource = new Map<string, ConversionCounts>();
  const byBand = new Map<string, ConversionCounts>();
  const byFitBand = new Map<string, ConversionCounts>();
  const byApplyMode = new Map<string, ConversionCounts>();
  const byTemplate = new Map<string, { templateName: string | null; counts: ConversionCounts }>();
  const byPolicy = new Map<string, ConversionCounts>();
  const timeToResponseMinutes: number[] = [];
  for (const row of appliedRows) {
    const source = row.source || "unknown";
    const band = scoreBand(row.fit_score === null || row.fit_score === undefined ? null : Number(row.fit_score));
    const canonicalFitBand = fitBand(row.fit_band);
    const mode = applyMode(row.apply_mode);
    const templateId = templateKey(row.resume_template_id);
    const templateName = templateId === "unreported" ? null : projectionText(row.resume_template_name);
    const policy = policyKey(row.tailoring_policy_version);
    const outcomes = outcomesByJob.get(row.job_id) ?? [];
    const responseMinutes = firstResponseMinutes(row.applied_at, outcomes);
    if (responseMinutes !== null) timeToResponseMinutes.push(responseMinutes);
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
    let fitBandBucket = byFitBand.get(canonicalFitBand);
    if (!fitBandBucket) {
      fitBandBucket = blank();
      byFitBand.set(canonicalFitBand, fitBandBucket);
    }
    let applyModeBucket = byApplyMode.get(mode);
    if (!applyModeBucket) {
      applyModeBucket = blank();
      byApplyMode.set(mode, applyModeBucket);
    }
    let templateBucket = byTemplate.get(templateId);
    if (!templateBucket) {
      templateBucket = { templateName, counts: blank() };
      byTemplate.set(templateId, templateBucket);
    } else if (!templateBucket.templateName && templateName) {
      templateBucket.templateName = templateName;
    }
    let policyBucket = byPolicy.get(policy);
    if (!policyBucket) {
      policyBucket = blank();
      byPolicy.set(policy, policyBucket);
    }
    for (const bucket of [totals, sourceBucket, bandBucket, fitBandBucket, applyModeBucket, templateBucket.counts, policyBucket]) {
      bucket.applied += 1;
      if (hasAnyKind(outcomes, REPLY_OUTCOME_KINDS)) bucket.reply += 1;
      if (hasAnyKind(outcomes, INTERVIEW_OUTCOME_KINDS)) bucket.interview += 1;
      if (hasAnyKind(outcomes, OFFER_OUTCOME_KINDS)) bucket.offer += 1;
      if (hasAnyKind(outcomes, REJECTION_OUTCOME_KINDS)) bucket.rejection += 1;
    }
  }
  const bySourceList = [...bySource.entries()]
    .map(([source, counts]) => ({ source, ...counts }))
    .sort((a, b) => b.applied - a.applied || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const byBandList = SCORE_BAND_ORDER.filter((band) => byBand.has(band)).map((band) => ({
    band,
    ...byBand.get(band)!,
  }));
  const byFitBandList = FIT_BAND_ORDER.filter((band) => byFitBand.has(band)).map((band) => ({
    fitBand: band,
    ...byFitBand.get(band)!,
  }));
  const byApplyModeList = APPLY_MODE_ORDER.filter((mode) => byApplyMode.has(mode)).map((mode) => ({
    applyMode: mode,
    ...byApplyMode.get(mode)!,
  }));
  const byTemplateList = [...byTemplate.entries()]
    .map(([templateId, bucket]) => ({ templateId, templateName: bucket.templateName, ...bucket.counts }))
    .sort((a, b) => b.applied - a.applied || (a.templateName ?? a.templateId).localeCompare(b.templateName ?? b.templateId));
  const byPolicyList = [...byPolicy.entries()]
    .map((entry) => {
      const [key, counts] = entry;
      const version = policyVersionFromKey(key);
      return { tailoringPolicyVersion: version, policyLabel: policyLabel(version), ...counts };
    })
    .sort((a, b) => b.applied - a.applied || (a.tailoringPolicyVersion ?? Number.MAX_SAFE_INTEGER) - (b.tailoringPolicyVersion ?? Number.MAX_SAFE_INTEGER));
  return {
    version: 2,
    totals,
    bySource: bySourceList,
    byBand: byBandList,
    byFitBand: byFitBandList,
    byApplyMode: byApplyModeList,
    byTemplate: byTemplateList,
    byPolicy: byPolicyList,
    timeToResponseMinutes: timeToResponseMinutes.sort((a, b) => a - b),
    suggestionAccuracy,
  };
}

function rebuildDashboardProjection(db: SqliteDatabase, tenantId: string): void {
  const hiddenWhere = tableExists(db, "jobctrl_hidden_jobs")
    ? `AND NOT EXISTS (
         SELECT 1 FROM jobctrl_hidden_jobs h
         WHERE h.job_url = jlp.job_id AND h.unhidden_at IS NULL
       )`
    : "";
  const stableSnapshotReference = hasCompositeJobIdForeignKey(
    db,
    "posting_snapshot_sets",
  );
  const closedWhere = tableExists(db, "posting_snapshot_sets")
    ? `AND NOT EXISTS (
         SELECT 1 FROM posting_snapshot_sets pss
         WHERE pss.tenant_id = jlp.tenant_id
           AND pss.${stableSnapshotReference ? "job_id" : "job_url"} = ${
             stableSnapshotReference
               ? `(SELECT j.job_id
                     FROM jobs j
                    WHERE j.tenant_id = jlp.tenant_id
                      AND j.url = jlp.job_id
                    LIMIT 1)`
               : "jlp.job_id"
           }
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
    fit_band: string | null;
    apply_mode: string | null;
    resume_template_id: string | null;
    resume_template_name: string | null;
    tailoring_policy_version: number | null;
    source: string;
  }>(
    db,
    `SELECT job_id, current_stage, current_state, apply_status, applied_at,
            deleted_at, has_resume, fit_score, fit_band, apply_mode,
            resume_template_id, resume_template_name, tailoring_policy_version,
            source
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
      tableExists(db, "jobctrl_deleted_jobs") ||
      tableExists(db, "jobctrl_hidden_jobs") ||
      tableExists(db, "posting_snapshot_sets")
    ) {
      const hasDeleted = tableExists(db, "jobctrl_deleted_jobs");
      const hasHidden = tableExists(db, "jobctrl_hidden_jobs");
      const hasSnapshots = tableExists(db, "posting_snapshot_sets");
      const deletedJoin = hasDeleted
        ? " LEFT JOIN jobctrl_deleted_jobs d ON d.job_url = arp.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
        : "";
      const hiddenJoin = hasHidden
        ? " LEFT JOIN jobctrl_hidden_jobs h ON h.job_url = arp.job_id AND h.unhidden_at IS NULL"
        : "";
      const snapshotJoin = hasSnapshots
        ? stableSnapshotReference
          ? " LEFT JOIN jobs snapshot_job ON snapshot_job.tenant_id = arp.tenant_id AND snapshot_job.url = arp.job_id LEFT JOIN posting_snapshot_sets pss ON pss.tenant_id = arp.tenant_id AND pss.job_id = snapshot_job.job_id"
          : " LEFT JOIN posting_snapshot_sets pss ON pss.tenant_id = arp.tenant_id AND pss.job_url = arp.job_id"
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

function contactsBackfillPending(db: SqliteDatabase, tenantId: string): boolean {
  if (!tableExists(db, "contacts") || !tableExists(db, "contact_projections")) {
    return false;
  }
  const projected =
    getRow<{ c: number }>(db, "SELECT COUNT(*) AS c FROM contact_projections WHERE tenant_id = ?", [
      tenantId,
    ])?.c ?? 0;
  if (projected > 0) {
    return false;
  }
  const canonical =
    getRow<{ c: number }>(
      db,
      "SELECT COUNT(*) AS c FROM contacts WHERE tenant_id = ? AND deleted_at IS NULL",
      [tenantId],
    )?.c ?? 0;
  return canonical > 0;
}

/**
 * Rematerialise every ``contact_projections`` row from canonical contact rows
 * (Contact & Outreach, ninth context). Idempotent full rebuild for the tenant.
 * Attribute VALUES are never read into the projection — only the link, role,
 * counts, distinct source kinds, and per-attribute provenance (INV-2). Mirrors
 * the Python ``ProjectionBuilder._rebuild_contacts`` for cross-runtime parity.
 */
function rebuildContactProjections(db: SqliteDatabase, tenantId: string): void {
  if (!tableExists(db, "contacts") || !tableExists(db, "contact_attributes")) {
    return;
  }
  const contacts = allRows<{
    contact_id: string;
    employer: string | null;
    job_url: string | null;
    role: string | null;
    created_at: string | null;
    updated_at: string | null;
  }>(
    db,
    `SELECT contact_id, employer, job_url, role, created_at, updated_at
     FROM contacts
     WHERE tenant_id = ? AND deleted_at IS NULL`,
    [tenantId],
  );
  const liveIds = new Set<string>();
  const upsert = db.prepare(
    `INSERT INTO contact_projections (
       tenant_id, contact_id, employer, job_id, role,
       attribute_count, confirmed_count, source_kinds_json,
       provenance_json, created_at, updated_at, last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, contact_id) DO UPDATE SET
       employer          = excluded.employer,
       job_id            = excluded.job_id,
       role              = excluded.role,
       attribute_count   = excluded.attribute_count,
       confirmed_count   = excluded.confirmed_count,
       source_kinds_json = excluded.source_kinds_json,
       provenance_json   = excluded.provenance_json,
       created_at        = excluded.created_at,
       updated_at        = excluded.updated_at,
       last_updated_at   = excluded.last_updated_at`,
  );
  for (const contact of contacts) {
    const contactId = String(contact.contact_id);
    liveIds.add(contactId);
    const attributes = allRows<{
      attribute_id: string;
      attribute_kind: string;
      source_kind: string;
      source_ref: string;
      capture_method: string | null;
      confidence: number | null;
      user_confirmed: number | null;
      recorded_at: string | null;
    }>(
      db,
      `SELECT attribute_id, attribute_kind, source_kind, source_ref,
              capture_method, confidence, user_confirmed, recorded_at
       FROM contact_attributes
       WHERE tenant_id = ? AND contact_id = ?
       ORDER BY recorded_at ASC, attribute_id ASC`,
      [tenantId, contactId],
    );
    const sourceKinds: string[] = [];
    let confirmed = 0;
    const provenance = attributes.map((attr) => {
      const sourceKind = String(attr.source_kind);
      if (!sourceKinds.includes(sourceKind)) {
        sourceKinds.push(sourceKind);
      }
      const userConfirmed = Boolean(Number(attr.user_confirmed ?? 0));
      if (userConfirmed) {
        confirmed += 1;
      }
      return {
        attributeId: String(attr.attribute_id),
        attributeKind: String(attr.attribute_kind),
        sourceKind,
        sourceRef: String(attr.source_ref),
        captureMethod: String(attr.capture_method ?? "manual"),
        confidence: Number(attr.confidence ?? 0),
        userConfirmed,
        recordedAt: String(attr.recorded_at ?? ""),
      };
    });
    upsert.run(
      tenantId,
      contactId,
      contact.employer,
      contact.job_url,
      String(contact.role ?? "other"),
      attributes.length,
      confirmed,
      JSON.stringify(sourceKinds),
      JSON.stringify(provenance),
      contact.created_at,
      contact.updated_at,
      contact.updated_at,
    );
  }
  const existing = allRows<{ contact_id: string }>(
    db,
    "SELECT contact_id FROM contact_projections WHERE tenant_id = ?",
    [tenantId],
  );
  const drop = db.prepare("DELETE FROM contact_projections WHERE tenant_id = ? AND contact_id = ?");
  for (const row of existing) {
    if (!liveIds.has(String(row.contact_id))) {
      drop.run(tenantId, String(row.contact_id));
    }
  }
}

function contactResearchBackfillPending(db: SqliteDatabase, tenantId: string): boolean {
  if (
    !tableExists(db, "contact_research_tasks") ||
    !tableExists(db, "contact_research_task_projections")
  ) {
    return false;
  }
  const projected =
    getRow<{ c: number }>(
      db,
      "SELECT COUNT(*) AS c FROM contact_research_task_projections WHERE tenant_id = ?",
      [tenantId],
    )?.c ?? 0;
  if (projected > 0) {
    return false;
  }
  const canonical =
    getRow<{ c: number }>(db, "SELECT COUNT(*) AS c FROM contact_research_tasks WHERE tenant_id = ?", [
      tenantId,
    ])?.c ?? 0;
  return canonical > 0;
}

/**
 * Rematerialise every ``contact_research_task_projections`` row from canonical
 * research rows (ninth context). Candidate VALUES are never read into the
 * projection — only the task lifecycle, counts, source-attempt outcomes
 * (provenance of the search), and per-candidate provenance metadata +
 * attribute kinds (INV-2). Mirrors the Python
 * ``ProjectionBuilder._rebuild_contact_research`` for cross-runtime parity.
 */
function rebuildContactResearchProjections(db: SqliteDatabase, tenantId: string): void {
  if (!tableExists(db, "contact_research_tasks") || !tableExists(db, "contact_candidates")) {
    return;
  }
  const tasks = allRows<{
    task_id: string;
    employer: string | null;
    job_url: string | null;
    status: string | null;
    source_attempts_json: string | null;
    started_at: string | null;
    updated_at: string | null;
    needs_review_at: string | null;
    completed_at: string | null;
    failed_at: string | null;
    error_class: string | null;
  }>(
    db,
    `SELECT task_id, employer, job_url, status, source_attempts_json,
            started_at, updated_at, needs_review_at, completed_at, failed_at, error_class
     FROM contact_research_tasks
     WHERE tenant_id = ?`,
    [tenantId],
  );
  const liveIds = new Set<string>();
  const upsert = db.prepare(
    `INSERT INTO contact_research_task_projections (
       tenant_id, task_id, employer, job_id, status,
       candidate_count, needs_review_count, confirmed_count,
       source_attempts_json, candidates_json, started_at, updated_at,
       needs_review_at, completed_at, failed_at, error_class, last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, task_id) DO UPDATE SET
       employer             = excluded.employer,
       job_id               = excluded.job_id,
       status               = excluded.status,
       candidate_count      = excluded.candidate_count,
       needs_review_count   = excluded.needs_review_count,
       confirmed_count      = excluded.confirmed_count,
       source_attempts_json = excluded.source_attempts_json,
       candidates_json      = excluded.candidates_json,
       started_at           = excluded.started_at,
       updated_at           = excluded.updated_at,
       needs_review_at      = excluded.needs_review_at,
       completed_at         = excluded.completed_at,
       failed_at            = excluded.failed_at,
       error_class          = excluded.error_class,
       last_updated_at      = excluded.last_updated_at`,
  );
  for (const task of tasks) {
    const taskId = String(task.task_id);
    liveIds.add(taskId);
    const candidateRows = allRows<{
      candidate_id: string;
      role: string | null;
      source_kind: string;
      source_ref: string;
      capture_method: string | null;
      confidence: number | null;
      status: string | null;
      proposed_at: string | null;
      confirmed_contact_id: string | null;
      confirmed_at: string | null;
      attributes_json: string | null;
    }>(
      db,
      `SELECT candidate_id, role, source_kind, source_ref, capture_method,
              confidence, status, proposed_at, confirmed_contact_id, confirmed_at, attributes_json
       FROM contact_candidates
       WHERE tenant_id = ? AND task_id = ?
       ORDER BY proposed_at ASC, candidate_id ASC`,
      [tenantId, taskId],
    );
    let needsReview = 0;
    let confirmed = 0;
    const candidates = candidateRows.map((candidate) => {
      const status = String(candidate.status ?? "needs_review");
      if (status === "needs_review") {
        needsReview += 1;
      } else if (status === "confirmed") {
        confirmed += 1;
      }
      return {
        candidateId: String(candidate.candidate_id),
        role: String(candidate.role ?? "other"),
        sourceKind: String(candidate.source_kind),
        sourceRef: String(candidate.source_ref),
        captureMethod: String(candidate.capture_method ?? "llm_assisted"),
        confidence: Number(candidate.confidence ?? 0),
        status,
        proposedAt: String(candidate.proposed_at ?? ""),
        confirmedContactId: candidate.confirmed_contact_id ?? null,
        confirmedAt: candidate.confirmed_at ?? null,
        attributeKinds: researchAttributeKinds(candidate.attributes_json),
      };
    });
    upsert.run(
      tenantId,
      taskId,
      task.employer,
      task.job_url,
      String(task.status ?? "queued"),
      candidateRows.length,
      needsReview,
      confirmed,
      JSON.stringify(parseJsonArray(task.source_attempts_json)),
      JSON.stringify(candidates),
      task.started_at,
      task.updated_at,
      task.needs_review_at,
      task.completed_at,
      task.failed_at,
      task.error_class,
      task.updated_at,
    );
  }
  const existing = allRows<{ task_id: string }>(
    db,
    "SELECT task_id FROM contact_research_task_projections WHERE tenant_id = ?",
    [tenantId],
  );
  const drop = db.prepare(
    "DELETE FROM contact_research_task_projections WHERE tenant_id = ? AND task_id = ?",
  );
  for (const row of existing) {
    if (!liveIds.has(String(row.task_id))) {
      drop.run(tenantId, String(row.task_id));
    }
  }
}

function researchAttributeKinds(attributesJson: string | null): string[] {
  const kinds: string[] = [];
  for (const item of parseJsonArray(attributesJson)) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const kind = String((item as Record<string, unknown>).kind ?? "").trim();
      if (kind && !kinds.includes(kind)) {
        kinds.push(kind);
      }
    }
  }
  return kinds;
}

function outreachBackfillPending(db: SqliteDatabase, tenantId: string): boolean {
  if (
    !tableExists(db, "outreach_threads") ||
    !tableExists(db, "outreach_thread_projections")
  ) {
    return false;
  }
  const projected =
    getRow<{ c: number }>(
      db,
      "SELECT COUNT(*) AS c FROM outreach_thread_projections WHERE tenant_id = ?",
      [tenantId],
    )?.c ?? 0;
  if (projected > 0) {
    return false;
  }
  const canonical =
    getRow<{ c: number }>(db, "SELECT COUNT(*) AS c FROM outreach_threads WHERE tenant_id = ?", [
      tenantId,
    ])?.c ?? 0;
  return canonical > 0;
}

/**
 * Rematerialise every ``outreach_thread_projections`` row from canonical outreach
 * rows (ninth context). The draft body, gate internals, and claim provenance are
 * never read into the projection — only the thread lifecycle summary and per-draft
 * metadata (generation, kind, status, the persisted gate outcome INV-5, and
 * timestamps). Mirrors the Python ``ProjectionBuilder._rebuild_outreach`` for
 * cross-runtime parity.
 */
function rebuildOutreachProjections(db: SqliteDatabase, tenantId: string): void {
  if (!tableExists(db, "outreach_threads") || !tableExists(db, "outreach_drafts")) {
    return;
  }
  const threads = allRows<{
    thread_id: string;
    contact_id: string;
    job_url: string | null;
    created_at: string | null;
    updated_at: string | null;
  }>(
    db,
    `SELECT thread_id, contact_id, job_url, created_at, updated_at
     FROM outreach_threads
     WHERE tenant_id = ?`,
    [tenantId],
  );
  const liveIds = new Set<string>();
  const upsert = db.prepare(
    `INSERT INTO outreach_thread_projections (
       tenant_id, thread_id, contact_id, job_id, draft_count,
       latest_generation, has_approved_draft, approved_draft_id,
       latest_status, drafts_json, created_at, updated_at, last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, thread_id) DO UPDATE SET
       contact_id         = excluded.contact_id,
       job_id             = excluded.job_id,
       draft_count        = excluded.draft_count,
       latest_generation  = excluded.latest_generation,
       has_approved_draft = excluded.has_approved_draft,
       approved_draft_id  = excluded.approved_draft_id,
       latest_status      = excluded.latest_status,
       drafts_json        = excluded.drafts_json,
       created_at         = excluded.created_at,
       updated_at         = excluded.updated_at,
       last_updated_at    = excluded.last_updated_at`,
  );
  for (const thread of threads) {
    const threadId = String(thread.thread_id);
    liveIds.add(threadId);
    const draftRows = allRows<{
      draft_id: string;
      generation: number | null;
      kind: string | null;
      status: string | null;
      gate_results_json: string | null;
      created_at: string | null;
      approved_at: string | null;
      rejected_at: string | null;
    }>(
      db,
      `SELECT draft_id, generation, kind, status, gate_results_json,
              created_at, approved_at, rejected_at
       FROM outreach_drafts
       WHERE tenant_id = ? AND thread_id = ?
       ORDER BY generation ASC, draft_id ASC`,
      [tenantId, threadId],
    );
    let latestGeneration = 0;
    let latestStatus: string | null = null;
    let hasApproved = false;
    let approvedDraftId: string | null = null;
    const drafts = draftRows.map((draft) => {
      const generation = Number(draft.generation ?? 0);
      const status = String(draft.status ?? "candidate");
      latestGeneration = generation;
      latestStatus = status;
      if (status === "approved") {
        hasApproved = true;
        approvedDraftId = String(draft.draft_id);
      }
      return {
        draftId: String(draft.draft_id),
        generation,
        kind: String(draft.kind ?? ""),
        status,
        gatePassed: gatePassed(draft.gate_results_json),
        createdAt: draft.created_at ?? null,
        approvedAt: draft.approved_at ?? null,
        rejectedAt: draft.rejected_at ?? null,
      };
    });
    upsert.run(
      tenantId,
      threadId,
      String(thread.contact_id),
      thread.job_url,
      draftRows.length,
      latestGeneration,
      hasApproved ? 1 : 0,
      approvedDraftId,
      latestStatus,
      JSON.stringify(drafts),
      thread.created_at,
      thread.updated_at,
      thread.updated_at,
    );
  }
  const existing = allRows<{ thread_id: string }>(
    db,
    "SELECT thread_id FROM outreach_thread_projections WHERE tenant_id = ?",
    [tenantId],
  );
  const drop = db.prepare(
    "DELETE FROM outreach_thread_projections WHERE tenant_id = ? AND thread_id = ?",
  );
  for (const row of existing) {
    if (!liveIds.has(String(row.thread_id))) {
      drop.run(tenantId, String(row.thread_id));
    }
  }
}

/**
 * Rematerialise one `due_follow_up_projections` row per thread whose follow-up is
 * SCHEDULED (Contact & Outreach, ninth context). Whether a scheduled follow-up is
 * *due* is computed at read time (schedule + clock) — a derived signal, never an
 * action (INV-1). Completed/dismissed/unscheduled threads are dropped. Mirrors the
 * Python `ProjectionBuilder._rebuild_due_follow_ups` for cross-runtime parity.
 */
function rebuildDueFollowUpProjections(db: SqliteDatabase, tenantId: string): void {
  if (!tableExists(db, "outreach_threads")) {
    return;
  }
  const threads = allRows<{
    thread_id: string;
    contact_id: string;
    job_url: string | null;
    follow_up_due_at: string | null;
    follow_up_basis: string | null;
    follow_up_state: string | null;
    created_at: string | null;
    updated_at: string | null;
  }>(
    db,
    `SELECT thread_id, contact_id, job_url, follow_up_due_at, follow_up_basis,
            follow_up_state, created_at, updated_at
     FROM outreach_threads
     WHERE tenant_id = ? AND follow_up_state = 'scheduled'`,
    [tenantId],
  );
  const liveIds = new Set<string>();
  const upsert = db.prepare(
    `INSERT INTO due_follow_up_projections (
       tenant_id, thread_id, contact_id, job_id, due_at, basis, state,
       created_at, updated_at, last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, thread_id) DO UPDATE SET
       contact_id      = excluded.contact_id,
       job_id          = excluded.job_id,
       due_at          = excluded.due_at,
       basis           = excluded.basis,
       state           = excluded.state,
       created_at      = excluded.created_at,
       updated_at      = excluded.updated_at,
       last_updated_at = excluded.last_updated_at`,
  );
  for (const thread of threads) {
    const threadId = String(thread.thread_id);
    liveIds.add(threadId);
    upsert.run(
      tenantId,
      threadId,
      String(thread.contact_id),
      thread.job_url,
      thread.follow_up_due_at,
      thread.follow_up_basis ?? "",
      String(thread.follow_up_state ?? "scheduled"),
      thread.created_at,
      thread.updated_at,
      thread.updated_at,
    );
  }
  const existing = allRows<{ thread_id: string }>(
    db,
    "SELECT thread_id FROM due_follow_up_projections WHERE tenant_id = ?",
    [tenantId],
  );
  const drop = db.prepare(
    "DELETE FROM due_follow_up_projections WHERE tenant_id = ? AND thread_id = ?",
  );
  for (const row of existing) {
    if (!liveIds.has(String(row.thread_id))) {
      drop.run(tenantId, String(row.thread_id));
    }
  }
}

function gatePassed(raw: string | null): boolean {
  if (!raw) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      Boolean(parsed) &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).passed === true
    );
  } catch {
    return false;
  }
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

// Anti-join fragments that exclude soft-deleted and hidden jobs from a
// tenant-wide read, mirroring rebuildDashboardProjection. Guarded by
// tableExists so callers work on databases where the TS write-model has not
// created the lifecycle tables yet.
function jobLifecycleExclusionSql(
  db: SqliteDatabase,
  jobUrlExpression: string,
): { joinSql: string; whereSql: string } {
  const joins: string[] = [];
  const wheres: string[] = [];
  if (tableExists(db, "jobctrl_deleted_jobs")) {
    joins.push(
      `LEFT JOIN jobctrl_deleted_jobs d ON d.job_url = ${jobUrlExpression} AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))`,
    );
    wheres.push("d.job_url IS NULL");
  }
  if (tableExists(db, "jobctrl_hidden_jobs")) {
    joins.push(
      `LEFT JOIN jobctrl_hidden_jobs h ON h.job_url = ${jobUrlExpression} AND h.unhidden_at IS NULL`,
    );
    wheres.push("h.job_url IS NULL");
  }
  return {
    joinSql: joins.length ? ` ${joins.join(" ")}` : "",
    whereSql: wheres.length ? ` AND ${wheres.join(" AND ")}` : "",
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

function deriveApplyMode(
  db: SqliteDatabase,
  tenantId: string,
  jobUrl: string,
  apply: ApplyLatest,
  legacyStatus: string | null,
  legacyAppliedAt: string | null,
): string | null {
  if (apply.status === "succeeded" && !apply.dryRun) return "automated_live";
  const isApplied = Boolean(legacyAppliedAt) || legacyStatus === "applied";
  if (!isApplied) return null;
  if (hasJobEvent(db, jobUrl, "ApplicationManuallyMarked")) return "manual_marked";
  if (hasApplicationOutcomeKind(db, tenantId, jobUrl, "applied_confirmation")) return "external_confirmed";
  return "manual_marked";
}

function hasJobEvent(db: SqliteDatabase, jobUrl: string, eventType: string): boolean {
  if (!tableExists(db, "job_events")) return false;
  const row = getRow<{ c: number }>(
    db,
    "SELECT COUNT(*) AS c FROM job_events WHERE job_url = ? AND event_type = ?",
    [jobUrl, eventType],
  );
  return Number(row?.c ?? 0) > 0;
}

function hasApplicationOutcomeKind(
  db: SqliteDatabase,
  tenantId: string,
  jobUrl: string,
  kind: string,
): boolean {
  if (!tableExists(db, "application_outcomes")) return false;
  const row = getRow<{ c: number }>(
    db,
    "SELECT COUNT(*) AS c FROM application_outcomes WHERE tenant_id = ? AND job_key = ? AND kind = ?",
    [tenantId, jobUrl, kind],
  );
  return Number(row?.c ?? 0) > 0;
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
