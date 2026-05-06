import fs from "node:fs";

import type {
  ArtifactDetail,
  ArtifactListQuery,
  ArtifactSummary,
  BulkJobMutationFilter,
  DashboardSettings,
  DashboardSummary,
  JobDeletedFilter,
  JobDetail,
  JobListQuery,
  JobSummary,
  PaginatedResponse,
  ProfileConfigResponse,
  ProfileShape,
  SettingsResponse,
  Stage,
  StageState,
  StageSummary,
} from "./contracts.js";
import { ProfileSchema, STAGES } from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";

type JobRow = Record<string, unknown> & {
  url?: string;
  title?: string | null;
  site?: string | null;
  strategy?: string | null;
  location?: string | null;
  salary?: string | null;
  discovered_at?: string | null;
  application_url?: string | null;
  full_description?: string | null;
  detail_scraped_at?: string | null;
  detail_error?: string | null;
  fit_score?: number | null;
  score_reasoning?: string | null;
  scored_at?: string | null;
  // Phase 5 (S-18): joined-in fields from job_scores latest version.
  js_fit_score?: number | null;
  js_scored_at?: string | null;
  js_breakdown_json?: string | null;
  tailored_resume_path?: string | null;
  tailored_at?: string | null;
  tailor_attempts?: number | null;
  cover_letter_path?: string | null;
  cover_letter_at?: string | null;
  cover_attempts?: number | null;
  // Phase 6 (S-20): joined-in fields from job_materials latest generation.
  jm_generation?: number | null;
  jm_status?: string | null;
  jm_tailored_path?: string | null;
  jm_tailored_at?: string | null;
  jm_cover_path?: string | null;
  jm_cover_at?: string | null;
  jm_resume_pdf_path?: string | null;
  jm_cover_pdf_path?: string | null;
  // Phase 7 (S-26): joined-in fields from job_enrichments.
  je_full_description?: string | null;
  je_application_url?: string | null;
  je_enriched_at?: string | null;
  je_current_status?: string | null;
  je_extraction_tier?: string | null;
  apply_status?: string | null;
  apply_error?: string | null;
  apply_attempts?: number | null;
  applied_at?: string | null;
  // Phase 8 (S-30): joined-in fields from apply_runs latest row.
  ar_run_id?: string | null;
  ar_status?: string | null;
  ar_result?: string | null;
  ar_finished_at?: string | null;
  ar_started_at?: string | null;
  deleted_at?: string | null;
};

type StageRow = {
  job_url?: string;
  stage?: string;
  state?: string;
  attempt_count?: number | null;
  max_attempts?: number | null;
  started_at?: string | null;
  updated_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  retryable?: number | boolean | null;
  blocked_by_json?: string | null;
  next_action?: string | null;
};

type ArtifactRow = {
  row_id?: number | string | null;
  artifact_id?: number | string | null;
  job_url?: string;
  artifact_type?: string;
  status?: string;
  path?: string;
  created_at?: string | null;
  size_bytes?: number | null;
};

const DEFAULT_MAX_ATTEMPTS: Record<Stage, number> = {
  discover: 1,
  enrich: 3,
  score: 3,
  tailor: 5,
  cover: 5,
  pdf: 3,
  apply: 3,
};

const STATE_RANK: Record<StageState, number> = {
  failed: 0,
  exhausted: 1,
  blocked: 2,
  running: 3,
  queued: 4,
  pending: 5,
  stale: 6,
  canceled: 7,
  skipped: 8,
  succeeded: 9,
};

const DEFAULT_SETTINGS: DashboardSettings = {
  targetRole: "",
  locationFilter: "",
  minFitScore: 7,
  autoApply: false,
  applyConcurrency: 1,
  scoreCriteria: "",
  targetCriteria: "",
};
const SOURCE_BOARD_NAMES = new Set(["greenhouse", "linkedin", "talent.com"]);

const JOB_COLUMNS = [
  "url",
  "title",
  "site",
  "strategy",
  "location",
  "salary",
  "discovered_at",
  "application_url",
  "description",
  "full_description",
  "detail_scraped_at",
  "detail_error",
  "fit_score",
  "score_reasoning",
  "scored_at",
  "tailored_resume_path",
  "tailored_at",
  "tailor_attempts",
  "cover_letter_path",
  "cover_letter_at",
  "cover_attempts",
  "apply_status",
  "apply_error",
  "applied_at",
] as const;

// Phase 5 (S-18): scoring fields are now sourced from the per-aggregate
// ``job_scores`` table. The legacy ``jobs.fit_score`` columns remain in the
// schema as a read-only fallback for historical rows that were never
// re-scored after the one-shot backfill — but new writes only target
// ``job_scores`` so the LEFT JOIN below carries the canonical value.
//
// SCORE_SUBQUERY pulls the latest version per job and exposes the score
// fields under ``js_*`` aliases so they don't collide with the legacy
// columns selected from ``jobs``.
const SCORE_SUBQUERY = `(
  SELECT s.job_url      AS js_job_url,
         s.fit_score    AS js_fit_score,
         s.scored_at    AS js_scored_at,
         s.breakdown_json AS js_breakdown_json
  FROM job_scores s
  INNER JOIN (
    SELECT job_url, MAX(version) AS max_version
    FROM job_scores
    GROUP BY job_url
  ) latest
    ON latest.job_url = s.job_url AND latest.max_version = s.version
)`;

function scoreJoin(db: SqliteDatabase): string {
  return tableExists(db, "job_scores")
    ? ` LEFT JOIN ${SCORE_SUBQUERY} js ON js.js_job_url = jobs.url`
    : "";
}

function scoreSelect(db: SqliteDatabase): string {
  return tableExists(db, "job_scores")
    ? ", js.js_fit_score AS js_fit_score, js.js_scored_at AS js_scored_at, js.js_breakdown_json AS js_breakdown_json"
    : ", NULL AS js_fit_score, NULL AS js_scored_at, NULL AS js_breakdown_json";
}

// Phase 6 (S-20): the canonical artifact paths for tailored resumes,
// cover letters, and their PDFs now live in
// ``job_materials_artifacts``. The legacy ``jobs.tailored_resume_path``
// / ``jobs.cover_letter_path`` columns remain in the schema as a
// read-only fallback for un-backfilled rows. ``MATERIALS_SUBQUERY``
// pulls the latest generation per job and surfaces the per-type artifact
// paths under ``jm_*`` aliases that don't collide with the legacy
// columns.
const MATERIALS_SUBQUERY = `(
  SELECT m.job_url AS jm_job_url,
         m.generation AS jm_generation,
         m.status AS jm_status,
         tr.path AS jm_tailored_path,
         tr.created_at AS jm_tailored_at,
         cl.path AS jm_cover_path,
         cl.created_at AS jm_cover_at,
         rpdf.path AS jm_resume_pdf_path,
         cpdf.path AS jm_cover_pdf_path
  FROM job_materials m
  INNER JOIN (
    SELECT job_url, MAX(generation) AS max_generation
    FROM job_materials
    GROUP BY job_url
  ) latest ON latest.job_url = m.job_url AND latest.max_generation = m.generation
  LEFT JOIN job_materials_artifacts tr
    ON tr.job_url = m.job_url AND tr.generation = m.generation
    AND tr.artifact_type = 'tailored_resume' AND tr.status = 'approved'
  LEFT JOIN job_materials_artifacts cl
    ON cl.job_url = m.job_url AND cl.generation = m.generation
    AND cl.artifact_type = 'cover_letter' AND cl.status = 'approved'
  LEFT JOIN job_materials_artifacts rpdf
    ON rpdf.job_url = m.job_url AND rpdf.generation = m.generation
    AND rpdf.artifact_type = 'resume_pdf' AND rpdf.status = 'approved'
  LEFT JOIN job_materials_artifacts cpdf
    ON cpdf.job_url = m.job_url AND cpdf.generation = m.generation
    AND cpdf.artifact_type = 'cover_letter_pdf' AND cpdf.status = 'approved'
)`;

function materialsJoin(db: SqliteDatabase): string {
  return tableExists(db, "job_materials")
    ? ` LEFT JOIN ${MATERIALS_SUBQUERY} jm ON jm.jm_job_url = jobs.url`
    : "";
}

function materialsSelect(db: SqliteDatabase): string {
  return tableExists(db, "job_materials")
    ? (
        ", jm.jm_generation AS jm_generation" +
        ", jm.jm_status AS jm_status" +
        ", jm.jm_tailored_path AS jm_tailored_path" +
        ", jm.jm_tailored_at AS jm_tailored_at" +
        ", jm.jm_cover_path AS jm_cover_path" +
        ", jm.jm_cover_at AS jm_cover_at" +
        ", jm.jm_resume_pdf_path AS jm_resume_pdf_path" +
        ", jm.jm_cover_pdf_path AS jm_cover_pdf_path"
      )
    : (
        ", NULL AS jm_generation" +
        ", NULL AS jm_status" +
        ", NULL AS jm_tailored_path" +
        ", NULL AS jm_tailored_at" +
        ", NULL AS jm_cover_path" +
        ", NULL AS jm_cover_at" +
        ", NULL AS jm_resume_pdf_path" +
        ", NULL AS jm_cover_pdf_path"
      );
}

// Phase 7 (S-26): the canonical enrichment fields (description, apply
// URL, enrichment timestamp) now live in ``job_enrichments``. The legacy
// ``jobs.full_description`` / ``jobs.application_url`` /
// ``jobs.detail_scraped_at`` columns remain in the schema as a read-only
// fallback for un-backfilled rows. The LEFT JOIN below surfaces the
// per-job enrichment row under ``je_*`` aliases that don't collide with
// the legacy columns.
function enrichmentJoin(db: SqliteDatabase): string {
  return tableExists(db, "job_enrichments")
    ? " LEFT JOIN job_enrichments je ON je.job_url = jobs.url"
    : "";
}

function enrichmentSelect(db: SqliteDatabase): string {
  return tableExists(db, "job_enrichments")
    ? (
        ", je.full_description AS je_full_description" +
        ", je.application_url AS je_application_url" +
        ", je.enriched_at AS je_enriched_at" +
        ", je.current_status AS je_current_status" +
        ", je.extraction_tier AS je_extraction_tier"
      )
    : (
        ", NULL AS je_full_description" +
        ", NULL AS je_application_url" +
        ", NULL AS je_enriched_at" +
        ", NULL AS je_current_status" +
        ", NULL AS je_extraction_tier"
      );
}

// Phase 8 (S-30): apply state. The legacy launcher wrote
// ``jobs.applied_at`` / ``jobs.apply_status`` / ``jobs.apply_error``;
// the new launcher (and ``ApplyRunRepository``) write ONLY to
// ``apply_runs`` + ``apply_run_events``. The LEFT JOIN below promotes
// the latest apply_runs row into ``ar_*`` aliases that ``buildJobSummary``
// + ``deriveApplyStage`` consume to derive the canonical apply state.
// The legacy columns stay in the schema as a read-only fallback for
// historical rows that never went through the new code path.
// Round-1 review L1: tie-break by run_id when two apply_runs rows
// share the same ``started_at``. The correlated subquery picks the
// latest row deterministically (ORDER BY started_at DESC, run_id
// DESC + LIMIT 1) — the prior MAX(started_at) GROUP BY pattern
// produced duplicate parent rows on same-second retries.
const APPLY_RUN_SUBQUERY = `(
  SELECT ar.job_url AS ar_job_url,
         ar.run_id AS ar_run_id,
         ar.status AS ar_status,
         ar.result AS ar_result,
         ar.finished_at AS ar_finished_at,
         ar.started_at AS ar_started_at
  FROM apply_runs ar
  WHERE ar.run_id = (
    SELECT run_id FROM apply_runs ar_inner
    WHERE ar_inner.job_url = ar.job_url
    ORDER BY ar_inner.started_at DESC, ar_inner.run_id DESC
    LIMIT 1
  )
)`;

function applyRunJoin(db: SqliteDatabase): string {
  return tableExists(db, "apply_runs")
    ? ` LEFT JOIN ${APPLY_RUN_SUBQUERY} ar ON ar.ar_job_url = jobs.url`
    : "";
}

function applyRunSelect(db: SqliteDatabase): string {
  return tableExists(db, "apply_runs")
    ? (
        ", ar.ar_run_id AS ar_run_id" +
        ", ar.ar_status AS ar_status" +
        ", ar.ar_result AS ar_result" +
        ", ar.ar_finished_at AS ar_finished_at" +
        ", ar.ar_started_at AS ar_started_at"
      )
    : (
        ", NULL AS ar_run_id" +
        ", NULL AS ar_status" +
        ", NULL AS ar_result" +
        ", NULL AS ar_finished_at" +
        ", NULL AS ar_started_at"
      );
}

// Effective score: latest job_scores row (canonical) ⇒ fall back to legacy
// ``jobs.fit_score`` for un-rescored historical rows. Used everywhere we
// previously wrote bare ``fit_score`` — sort columns, filters, comparators.
const EFFECTIVE_FIT_SCORE = "COALESCE(js.js_fit_score, jobs.fit_score)";

// Phase 7 (S-26) effective enrichment-field expression for SQL WHERE
// clauses. New writes land in ``job_enrichments``; the legacy column
// is the read-only fallback. The helper degrades gracefully when the
// ``job_enrichments`` table doesn't yet exist (early-startup state
// before ``init_db`` runs the migration) — it collapses to the bare
// legacy column reference so callers don't see "no such column" SQL
// errors. SELECT-side projection of the same effective values happens
// via ``enrichmentSelect`` (which surfaces ``je_*`` aliases that
// ``buildJobSummary`` / ``getJobDetail`` then COALESCE against the
// legacy fields in TS).
function effectiveApplicationUrl(db: SqliteDatabase): string {
  return tableExists(db, "job_enrichments")
    ? "COALESCE(je.application_url, jobs.application_url)"
    : "jobs.application_url";
}

// Phase 6 (S-20) effective-path expressions. New tailor + cover writes
// land in ``job_materials_artifacts``; the legacy columns are a read-only
// fallback. Use everywhere the prior code read bare
// ``tailored_resume_path`` / ``cover_letter_path``.
const EFFECTIVE_TAILOR_PATH = "COALESCE(jm.jm_tailored_path, jobs.tailored_resume_path)";
const EFFECTIVE_TAILOR_AT = "COALESCE(jm.jm_tailored_at, jobs.tailored_at)";
const EFFECTIVE_COVER_PATH = "COALESCE(jm.jm_cover_path, jobs.cover_letter_path)";
const EFFECTIVE_COVER_AT = "COALESCE(jm.jm_cover_at, jobs.cover_letter_at)";

const SQL_JOB_SORT_COLUMNS: Partial<Record<string, string>> = {
  discovered_at: "discovered_at",
  title: "LOWER(COALESCE(title, ''))",
  company: "LOWER(COALESCE(site, ''))",
  location: "LOWER(COALESCE(location, ''))",
  fit_score: `COALESCE(${EFFECTIVE_FIT_SCORE}, -1)`,
};

export function buildDashboardSummary(db: SqliteDatabase): DashboardSummary {
  const jobs = loadJobs(db);
  const explicitStates = loadStageStates(db);
  const artifactCounts = artifactCountByJob(db, jobs);

  const summaries = jobs.map((job) => buildJobSummary(job, statesForJob(job, explicitStates), artifactCounts));
  const funnel = STAGES.map((stage) => buildFunnelStage(summaries, jobs, explicitStates, stage));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    totals: {
      jobs: summaries.length,
      failures: summaries.filter((job) => job.currentState === "failed" || job.currentState === "exhausted").length,
      blocked: summaries.filter((job) => job.currentState === "blocked").length,
      ready: summaries.filter((job) => job.currentStage === "apply" && job.currentState === "pending").length,
      applied: summaries.filter((job) => job.appliedAt || job.applyStatus === "applied").length,
      dryRuns: dryRunCount(db),
    },
    funnel,
    activity: recentActivity(db),
    applyRuns: recentApplyRuns(db),
  };
}

export function listJobs(db: SqliteDatabase, query: JobListQuery): PaginatedResponse<JobSummary> {
  const sqlSortColumn = SQL_JOB_SORT_COLUMNS[query.sort];
  if (!query.q && !query.stage && !query.state && sqlSortColumn) {
    const page = loadJobPage(db, query, sqlSortColumn);
    const explicitStates = loadStageStates(db);
    const artifactCounts = artifactCountByJob(db, page.jobs);
    const summaries = page.jobs.map((job) => buildJobSummary(job, statesForJob(job, explicitStates), artifactCounts));
    return paginateWithTotal(summaries, page.total, page.page, query.pageSize, query.sort, query.dir, jobFilterPayload(query));
  }

  const jobs = loadJobs(db, jobSqlFilter(query), query.deleted);
  const explicitStates = loadStageStates(db);
  const artifactCounts = artifactCountByJob(db, jobs);
  const normalizedQuery = query.q.toLowerCase();

  const filtered = jobs
    .map((job) => buildJobSummary(job, statesForJob(job, explicitStates), artifactCounts))
    .filter((job) => filterJob(job, query, normalizedQuery));

  filtered.sort((left, right) => compareJobs(left, right, query.sort, query.dir));

  return paginate(filtered, query.page, query.pageSize, query.sort, query.dir, jobFilterPayload(query));
}

export function matchingJobKeys(db: SqliteDatabase, filter: Partial<BulkJobMutationFilter> = {}): string[] {
  const query = normalizeMutationFilter(filter);
  const jobs = loadJobs(db, jobSqlFilter(query), query.deleted);
  const explicitStates = loadStageStates(db);
  const artifactCounts = artifactCountByJob(db, jobs);
  const normalizedQuery = query.q.toLowerCase();
  return jobs
    .map((job) => buildJobSummary(job, statesForJob(job, explicitStates), artifactCounts))
    .filter((job) => filterJob(job, query, normalizedQuery))
    .map((job) => job.jobKey);
}

export function getJobDetail(db: SqliteDatabase, jobKey: string): JobDetail | null {
  const job = findJob(db, jobKey);
  if (!job) {
    return null;
  }
  const explicitStates = loadStageStates(db);
  const artifactCounts = artifactCountByJob(db, [job]);
  const stages = statesForJob(job, explicitStates);
  return {
    ok: true,
    job: {
      ...buildJobSummary(job, stages, artifactCounts),
      // Phase 7 (S-26): prefer the joined ``job_enrichments.full_description``,
      // falling back to the legacy ``jobs.full_description`` (or the
      // discovery-time description) for un-backfilled rows.
      descriptionPreview: previewText(
        asString(job.je_full_description) ||
          asString(job.full_description) ||
          asString(job.description),
        6000,
      ),
      scoreReasoning: extractScoreReasoning(job),
    },
    stages,
    artifacts: artifactsForJobs(db, [job]),
  };
}

function normalizeMutationFilter(filter: Partial<BulkJobMutationFilter>): JobListQuery {
  return {
    page: 1,
    pageSize: 50,
    q: filter.q ?? "",
    sort: "discovered_at",
    dir: "desc",
    stage: filter.stage,
    state: filter.state,
    deleted: filter.deleted ?? "active",
    source: filter.source ?? "",
    company: filter.company ?? "",
    minFitScore: filter.minFitScore,
    maxFitScore: filter.maxFitScore,
  };
}

export function listArtifacts(db: SqliteDatabase, query: ArtifactListQuery): PaginatedResponse<ArtifactSummary> {
  const normalizedQuery = query.q.toLowerCase();
  const artifacts = artifactsForJobs(db, loadJobs(db)).filter((artifact) => {
    if (query.status && artifact.status !== query.status) {
      return false;
    }
    if (query.type && artifact.type !== query.type) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    return [artifact.title, artifact.company, artifact.type, artifact.status, artifact.localPath].some((value) =>
      value.toLowerCase().includes(normalizedQuery),
    );
  });

  artifacts.sort((left, right) => compareArtifacts(left, right, query.sort, query.dir));

  return paginate(artifacts, query.page, query.pageSize, query.sort, query.dir, {
    q: query.q,
    status: query.status,
    type: query.type,
  });
}

export function getArtifactDetail(db: SqliteDatabase, artifactId: string): ArtifactDetail | null {
  const artifact = findDbArtifact(db, artifactId) ?? findLegacyArtifact(db, artifactId);
  return artifact ? { ok: true, artifact } : null;
}

export function readProfileConfig(paths: {
  profilePath: string;
  resumeStylePath: string;
  resumeTemplatePath: string;
}): ProfileConfigResponse {
  return {
    ok: true,
    // Read returns the raw JSON so the web UI can edit even malformed
    // profile.json files. Schema validation is enforced on PATCH (see
    // ``writeProfileConfig``) — programmatic consumers should re-parse via
    // ``ProfileSchema``.
    profile: readJson(paths.profilePath, {}),
    style: readJson(paths.resumeStylePath, {}),
    templateText: readText(paths.resumeTemplatePath),
  };
}

/** Validate a candidate profile JSON. Used by callers (e.g. tests, future
 * SDK helpers) that want to assert canonical shape before posting. Stays
 * unused by the GET path so corrupt profile.json files remain editable. */
export function parseProfileShape(value: unknown): ProfileShape | null {
  const parsed = ProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readSettingsConfig(paths: { settingsPath: string }): SettingsResponse {
  return {
    ok: true,
    settings: normalizeSettings(readJson(paths.settingsPath, {})),
    paths,
  };
}

function normalizeSettings(raw: unknown): DashboardSettings {
  const source = isRecord(raw) ? raw : {};
  return {
    targetRole: normalizeText(source.targetRole ?? source.target_role, DEFAULT_SETTINGS.targetRole),
    locationFilter: normalizeText(source.locationFilter ?? source.location_filter, DEFAULT_SETTINGS.locationFilter),
    minFitScore: normalizeInt(source.minFitScore ?? source.min_fit_score, DEFAULT_SETTINGS.minFitScore, 0, 10),
    autoApply: normalizeBool(source.autoApply ?? source.auto_apply, DEFAULT_SETTINGS.autoApply),
    applyConcurrency: normalizeInt(
      source.applyConcurrency ?? source.apply_concurrency,
      DEFAULT_SETTINGS.applyConcurrency,
      1,
      16,
    ),
    scoreCriteria: normalizeText(source.scoreCriteria ?? source.score_criteria, DEFAULT_SETTINGS.scoreCriteria),
    targetCriteria: normalizeText(source.targetCriteria ?? source.target_criteria, DEFAULT_SETTINGS.targetCriteria),
  };
}

function loadJobs(
  db: SqliteDatabase,
  sqlFilter = { where: "", params: [] as SqliteValue[] },
  deleted: JobDeletedFilter = "active",
): JobRow[] {
  if (!tableExists(db, "jobs")) {
    return [];
  }
  const deletion = deletedSqlFilter(db, deleted);
  const filter = combineSqlFilters(sqlFilter, deletion);
  return allRows<JobRow>(
    db,
    `SELECT ${JOB_COLUMNS.map((column) => `jobs.${column}`).join(", ")}${deletedSelect(db)}${scoreSelect(db)}${materialsSelect(db)}${enrichmentSelect(db)}${applyRunSelect(db)} FROM jobs${deletedJoin(db)}${scoreJoin(db)}${materialsJoin(db)}${enrichmentJoin(db)}${applyRunJoin(db)}${filter.where}`,
    filter.params,
  );
}

function loadJobPage(
  db: SqliteDatabase,
  query: JobListQuery,
  sqlSortColumn: string,
): { jobs: JobRow[]; page: number; total: number } {
  if (!tableExists(db, "jobs")) {
    return { jobs: [], page: 1, total: 0 };
  }
  const filter = combineSqlFilters(jobSqlFilter(query), deletedSqlFilter(db, query.deleted));
  const totalRow = getRow<{ count: number }>(db, `SELECT COUNT(*) AS count FROM jobs${deletedJoin(db)}${scoreJoin(db)}${materialsJoin(db)}${enrichmentJoin(db)}${filter.where}`, filter.params);
  const total = Number(totalRow?.count ?? 0);
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, pages);
  const offset = (page - 1) * query.pageSize;
  const direction = query.dir === "asc" ? "ASC" : "DESC";
  const jobs = allRows<JobRow>(
    db,
    `SELECT ${JOB_COLUMNS.map((column) => `jobs.${column}`).join(", ")}${deletedSelect(db)}${scoreSelect(db)}${materialsSelect(db)}${enrichmentSelect(db)}${applyRunSelect(db)} FROM jobs${deletedJoin(db)}${scoreJoin(db)}${materialsJoin(db)}${enrichmentJoin(db)}${applyRunJoin(db)}${filter.where} ORDER BY ${sqlSortColumn} ${direction}, url ASC LIMIT ? OFFSET ?`,
    [...filter.params, query.pageSize, offset],
  );
  return { jobs, page, total };
}

function deletedJoin(db: SqliteDatabase): string {
  return tableExists(db, "jobhunter_deleted_jobs")
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = jobs.url AND d.restored_at IS NULL"
    : "";
}

function deletedSelect(db: SqliteDatabase): string {
  return tableExists(db, "jobhunter_deleted_jobs") ? ", d.deleted_at AS deleted_at" : ", NULL AS deleted_at";
}

function deletedSqlFilter(db: SqliteDatabase, mode: JobDeletedFilter): { where: string; params: SqliteValue[] } {
  if (mode === "all") {
    return { where: "", params: [] };
  }
  if (!tableExists(db, "jobhunter_deleted_jobs")) {
    return mode === "deleted" ? { where: " WHERE 1 = 0", params: [] } : { where: "", params: [] };
  }
  return { where: mode === "deleted" ? " WHERE d.job_url IS NOT NULL" : " WHERE d.job_url IS NULL", params: [] };
}

function combineSqlFilters(
  left: { where: string; params: SqliteValue[] },
  right: { where: string; params: SqliteValue[] },
): { where: string; params: SqliteValue[] } {
  const clauses = [left.where, right.where].flatMap((where) => {
    const trimmed = where.trim();
    return trimmed ? [trimmed.replace(/^WHERE\s+/i, "")] : [];
  });
  return {
    where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
    params: [...left.params, ...right.params],
  };
}

function jobSqlFilter(query: JobListQuery): { where: string; params: SqliteValue[] } {
  const clauses: string[] = [];
  const params: SqliteValue[] = [];
  if (query.source) {
    clauses.push("LOWER(COALESCE(site, '')) LIKE ?");
    params.push(`%${query.source.toLowerCase()}%`);
  }
  if (query.company) {
    clauses.push("LOWER(COALESCE(site, '')) LIKE ?");
    params.push(`%${query.company.toLowerCase()}%`);
  }
  if (query.minFitScore !== undefined) {
    clauses.push(`COALESCE(${EFFECTIVE_FIT_SCORE}, -1) >= ?`);
    params.push(query.minFitScore);
  }
  if (query.maxFitScore !== undefined) {
    clauses.push(`COALESCE(${EFFECTIVE_FIT_SCORE}, 999) <= ?`);
    params.push(query.maxFitScore);
  }
  return {
    where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function jobFilterPayload(query: JobListQuery): Record<string, unknown> {
  return {
    q: query.q,
    stage: query.stage ?? "",
    state: query.state ?? "",
    source: query.source,
    company: query.company,
    minFitScore: query.minFitScore ?? null,
    maxFitScore: query.maxFitScore ?? null,
    deleted: query.deleted,
  };
}

function findJob(db: SqliteDatabase, jobKey: string): JobRow | null {
  if (!tableExists(db, "jobs")) {
    return null;
  }
  const row = getRow<JobRow>(
    db,
    `SELECT jobs.*${deletedSelect(db)}${scoreSelect(db)}${materialsSelect(db)}${enrichmentSelect(db)}${applyRunSelect(db)} FROM jobs${deletedJoin(db)}${scoreJoin(db)}${materialsJoin(db)}${enrichmentJoin(db)}${applyRunJoin(db)} WHERE jobs.url = ? OR ${effectiveApplicationUrl(db)} = ? LIMIT 1`,
    [jobKey, jobKey],
  );
  return row ?? null;
}

function loadStageStates(db: SqliteDatabase): Map<string, Map<Stage, StageSummary>> {
  const byJob = new Map<string, Map<Stage, StageSummary>>();
  if (!tableExists(db, "job_stage_states")) {
    return byJob;
  }
  for (const row of allRows<StageRow>(db, "SELECT * FROM job_stage_states")) {
    const jobUrl = asString(row.job_url);
    if (!jobUrl || !isStage(row.stage)) {
      continue;
    }
    const jobStates = byJob.get(jobUrl) ?? new Map<Stage, StageSummary>();
    jobStates.set(row.stage, normalizeStageRow(row));
    byJob.set(jobUrl, jobStates);
  }
  return byJob;
}

function statesForJob(job: JobRow, explicitStates: Map<string, Map<Stage, StageSummary>>): StageSummary[] {
  const jobKey = job.url ?? "";
  const states = explicitStates.get(jobKey);
  if (states && states.size > 0) {
    return STAGES.map((stage) => states.get(stage) ?? defaultStage(stage, "pending"));
  }
  return deriveLegacyStates(job);
}

function buildJobSummary(
  job: JobRow,
  states: StageSummary[],
  artifactCounts: Map<string, number>,
): JobSummary {
  const current = firstActionableState(states);
  const jobKey = job.url ?? "";
  return {
    jobKey,
    url: jobKey,
    title: asString(job.title) || "Untitled",
    company: companyName(job),
    source: asString(job.site) || "unknown",
    strategy: asString(job.strategy),
    location: asString(job.location),
    salary: asString(job.salary),
    discoveredAt: asNullableString(job.discovered_at),
    // Phase 7 (S-26): prefer the joined ``job_enrichments.application_url``,
    // falling back to the legacy ``jobs.application_url`` only for
    // historical rows that were never re-enriched.
    applicationUrl:
      asNullableString(job.je_application_url) ?? asNullableString(job.application_url),
    // Phase 5 (S-18): prefer the joined ``job_scores.fit_score``, falling
    // back to the legacy ``jobs.fit_score`` only for historical rows.
    fitScore: asNullableNumber(job.js_fit_score) ?? asNullableNumber(job.fit_score),
    currentStage: current.stage,
    currentState: current.state,
    errorCode: current.errorCode,
    errorMessage: current.errorMessage,
    nextAction: current.nextAction,
    artifactCount: artifactCounts.get(jobKey) ?? 0,
    // Phase 8 (S-30): prefer the latest ``apply_runs`` row, falling
    // back to the legacy ``jobs.apply_status`` / ``jobs.applied_at``
    // for historical rows that never went through the new code path.
    applyStatus: deriveApplyStatusString(job),
    appliedAt: deriveAppliedAt(job),
    deletedAt: asNullableString(job.deleted_at),
  };
}

function deriveApplyStatusString(job: JobRow): string | null {
  const arStatus = asNullableString(job.ar_status);
  if (arStatus) {
    switch (arStatus) {
      case "succeeded":
        return "applied";
      case "starting":
      case "in_progress":
        return "in_progress";
      case "dry_run_complete":
        return "dry_run";
      default:
        return arStatus;
    }
  }
  return asNullableString(job.apply_status);
}

function deriveAppliedAt(job: JobRow): string | null {
  if (asNullableString(job.ar_status) === "succeeded") {
    return asNullableString(job.ar_finished_at);
  }
  return asNullableString(job.applied_at);
}

/**
 * Phase 5 (S-18): the canonical reasoning for a job's latest score now
 * lives in ``job_scores.breakdown_json.reasoning``. We fall back to the
 * legacy ``jobs.score_reasoning`` column for **pre-backfill** rows only
 * — once ``ensure_score_tables`` has run on the database, every row that
 * had a legacy reasoning is replicated into ``breakdown_json``, so the
 * fallback below is unreachable in practice. It exists as a safety net
 * for (a) databases where the migration hasn't run yet (read-only API
 * processes pointed at an old file), and (b) a corrupt
 * ``breakdown_json`` row whose JSON.parse fails. Don't delete it — it's
 * defensive, not dead. (Round-1 review L2.)
 */
function extractScoreReasoning(job: JobRow): string {
  const raw = job.js_breakdown_json;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as { reasoning?: unknown };
      if (parsed && typeof parsed.reasoning === "string") {
        return parsed.reasoning;
      }
    } catch {
      // Fall through to the legacy column — broken JSON in job_scores
      // shouldn't take down the dashboard.
    }
  }
  return asString(job.score_reasoning);
}

function buildFunnelStage(
  summaries: JobSummary[],
  jobs: JobRow[],
  explicitStates: Map<string, Map<Stage, StageSummary>>,
  stage: Stage,
): DashboardSummary["funnel"][number] {
  const counts = { stage, total: 0, succeeded: 0, running: 0, pending: 0, blocked: 0, failed: 0 };
  const byJob = new Map(summaries.map((summary) => [summary.jobKey, summary]));
  for (const job of jobs) {
    const summary = byJob.get(job.url ?? "");
    if (!summary) {
      continue;
    }
    const stageState = statesForJob(job, explicitStates).find((item) => item.stage === stage);
    if (!stageState || stageState.state === "skipped") {
      continue;
    }
    counts.total += 1;
    if (stageState.state === "exhausted" || stageState.state === "failed") {
      counts.failed += 1;
    } else if (stageState.state === "running" || stageState.state === "queued") {
      counts.running += 1;
    } else if (stageState.state === "blocked") {
      counts.blocked += 1;
    } else if (stageState.state === "succeeded") {
      counts.succeeded += 1;
    } else {
      counts.pending += 1;
    }
  }
  return counts;
}

function deriveLegacyStates(job: JobRow): StageSummary[] {
  const discover = defaultStage("discover", "succeeded");
  // Phase 5 (S-18): a job has a score if either the joined ``job_scores``
  // row exists or the legacy ``jobs.fit_score`` column has a value.
  const hasScore =
    Boolean(job.js_scored_at) ||
    asNullableNumber(job.js_fit_score) !== null ||
    Boolean(job.scored_at) ||
    asNullableNumber(job.fit_score) !== null;
  // Phase 7 (S-26): the canonical "enriched" signal now lives in
  // ``job_enrichments.current_status`` ⇒ ``enriched``; the legacy
  // ``jobs.detail_scraped_at`` / ``jobs.full_description`` columns
  // remain as a read-only fallback for un-backfilled rows.
  const enrichmentStatus = asString(job.je_current_status);
  const hasEnrichmentSuccess =
    enrichmentStatus === "enriched" ||
    Boolean(job.je_full_description) ||
    Boolean(job.je_enriched_at);
  const hasEnrichmentFailure = enrichmentStatus === "failed";
  const enrich = hasEnrichmentFailure
    ? defaultStage("enrich", "failed", "Enrichment failed")
    : hasEnrichmentSuccess
      ? defaultStage("enrich", "succeeded")
      : job.detail_error
        ? defaultStage("enrich", "failed", asString(job.detail_error))
        : job.detail_scraped_at || job.full_description
          ? defaultStage("enrich", "succeeded")
          : defaultStage("enrich", "pending");
  const score =
    enrich.state !== "succeeded"
      ? defaultStage("score", "blocked", "Enrichment has not completed.")
      : hasScore
        ? defaultStage("score", "succeeded")
        : defaultStage("score", "pending");
  // Phase 6 (S-20): tailored-resume / cover-letter presence reads through
  // the joined ``job_materials`` artifact paths, falling back to the
  // legacy columns for un-backfilled rows.
  const tailorPath = (job.jm_tailored_path ?? job.tailored_resume_path) as string | null | undefined;
  const coverPath = (job.jm_cover_path ?? job.cover_letter_path) as string | null | undefined;
  const tailor = deriveArtifactStage("tailor", score, tailorPath, job.tailor_attempts);
  const cover = deriveArtifactStage("cover", tailor, coverPath, job.cover_attempts);
  const pdf = tailor.state === "succeeded" ? defaultStage("pdf", "succeeded") : defaultStage("pdf", "blocked");
  const apply = deriveApplyStage(job, pdf);
  return [discover, enrich, score, tailor, cover, pdf, apply];
}

function deriveArtifactStage(
  stage: "tailor" | "cover",
  upstream: StageSummary,
  artifactPath: string | null | undefined,
  attempts: number | null | undefined,
): StageSummary {
  if (artifactPath) {
    return defaultStage(stage, "succeeded");
  }
  if (upstream.state !== "succeeded") {
    return defaultStage(stage, "blocked", `${upstream.stage} has not completed.`);
  }
  const maxAttempts = DEFAULT_MAX_ATTEMPTS[stage];
  if ((attempts ?? 0) >= maxAttempts) {
    return { ...defaultStage(stage, "exhausted", `${stage} attempts exhausted.`), attemptCount: attempts ?? 0 };
  }
  return { ...defaultStage(stage, "pending"), attemptCount: attempts ?? 0 };
}

function deriveApplyStage(job: JobRow, upstream: StageSummary): StageSummary {
  // Phase 8 (S-30): prefer the joined apply_runs row.
  const arStatus = asString(job.ar_status).toLowerCase();
  if (arStatus === "succeeded" || job.applied_at) {
    return defaultStage("apply", "succeeded");
  }
  if (arStatus === "starting" || arStatus === "in_progress") {
    return defaultStage("apply", "running");
  }
  if (
    arStatus === "failed"
    || arStatus === "captcha"
    || arStatus === "login_issue"
    || arStatus === "expired"
  ) {
    return defaultStage("apply", "failed", asString(job.ar_result) || arStatus);
  }
  if (arStatus === "manual") {
    return defaultStage("apply", "skipped", "Manual ATS — apply by hand.");
  }
  if (arStatus === "dry_run_complete") {
    return defaultStage("apply", "skipped", "Dry run complete — re-run without --dry-run to submit.");
  }
  // Legacy fallback for historical rows (no apply_runs row exists).
  const status = asString(job.apply_status).toLowerCase();
  if (status === "applied") {
    return defaultStage("apply", "succeeded");
  }
  if (status === "in_progress") {
    return defaultStage("apply", "running");
  }
  if (job.apply_error) {
    return defaultStage("apply", "failed", asString(job.apply_error));
  }
  if (upstream.state !== "succeeded") {
    return defaultStage("apply", "blocked", "Materials are not ready.");
  }
  return defaultStage("apply", "pending");
}

function normalizeStageRow(row: StageRow): StageSummary {
  const stage = isStage(row.stage) ? row.stage : "discover";
  const state = isStageState(row.state) ? row.state : "pending";
  return {
    stage,
    state,
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: asNullableNumber(row.max_attempts) ?? DEFAULT_MAX_ATTEMPTS[stage],
    startedAt: asNullableString(row.started_at),
    updatedAt: asNullableString(row.updated_at),
    finishedAt: asNullableString(row.finished_at),
    durationMs: asNullableNumber(row.duration_ms),
    errorCode: asNullableString(row.error_code),
    errorMessage: asNullableString(row.error_message),
    retryable: row.retryable === null || row.retryable === undefined ? true : Boolean(row.retryable),
    blockedBy: parseStringArray(row.blocked_by_json),
    nextAction: asNullableString(row.next_action),
  };
}

function defaultStage(stage: Stage, state: StageState, errorMessage = ""): StageSummary {
  return {
    stage,
    state,
    attemptCount: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS[stage],
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    durationMs: null,
    errorCode: state === "failed" || state === "exhausted" || state === "blocked" ? state.toUpperCase() : null,
    errorMessage: errorMessage || null,
    retryable: state !== "blocked",
    blockedBy: [],
    nextAction: null,
  };
}

function firstActionableState(states: StageSummary[]): StageSummary {
  return states.find((item) => !["succeeded", "skipped"].includes(item.state)) ?? states[states.length - 1]!;
}

function artifactCountByJob(db: SqliteDatabase, jobs: JobRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const artifact of artifactsForJobs(db, jobs)) {
    counts.set(artifact.jobKey, (counts.get(artifact.jobKey) ?? 0) + 1);
  }
  return counts;
}

function artifactsForJobs(db: SqliteDatabase, jobs: JobRow[]): ArtifactSummary[] {
  const jobByUrl = new Map(jobs.map((job) => [job.url ?? "", job]));
  const artifacts: ArtifactSummary[] = [];
  // Phase 6 (S-20): the canonical artifact rows come from
  // ``job_materials_artifacts``. The legacy ``job_artifacts`` table is
  // still read for non-materials artifacts (apply logs, etc.).
  if (tableExists(db, "job_materials_artifacts")) {
    for (const row of allRows<ArtifactRow & { artifact_id?: string; generation?: number }>(
      db,
      "SELECT job_url, generation, artifact_type, artifact_id, status, path, created_at, size_bytes FROM job_materials_artifacts",
    )) {
      const job = jobByUrl.get(asString(row.job_url));
      if (!job || !row.path) {
        continue;
      }
      artifacts.push(formatArtifact({ ...row, row_id: row.artifact_id ?? `${row.job_url}:${row.generation}:${row.artifact_type}` }, job));
    }
  }
  if (tableExists(db, "job_artifacts")) {
    for (const row of allRows<ArtifactRow>(db, "SELECT rowid AS row_id, * FROM job_artifacts")) {
      const job = jobByUrl.get(asString(row.job_url));
      if (!job || !row.path) {
        continue;
      }
      artifacts.push(formatArtifact(row, job));
    }
  }
  for (const job of jobs) {
    artifacts.push(...legacyArtifacts(job, artifacts));
  }
  return artifacts;
}

function formatArtifact(row: ArtifactRow, job: JobRow): ArtifactSummary {
  const localPath = asString(row.path);
  const sizeBytes = asNullableNumber(row.size_bytes) ?? localFileSize(localPath);
  return {
    artifactId: asString(row.row_id ?? row.artifact_id) || `${asString(row.job_url)}:${asString(row.artifact_type)}:${localPath}`,
    jobKey: job.url ?? "",
    title: asString(job.title) || "Untitled",
    company: companyName(job),
    type: asString(row.artifact_type) || "artifact",
    status: localPath && sizeBytes === null ? "missing" : asString(row.status) || "active",
    localPath,
    createdAt: asNullableString(row.created_at),
    sizeBytes,
    size: formatSize(sizeBytes),
  };
}

function findDbArtifact(db: SqliteDatabase, artifactId: string): ArtifactSummary | null {
  if (!tableExists(db, "job_artifacts") || !tableExists(db, "jobs")) {
    return null;
  }
  const row = getRow<ArtifactRow>(db, "SELECT rowid AS row_id, * FROM job_artifacts WHERE CAST(rowid AS TEXT) = ? LIMIT 1", [
    artifactId,
  ]);
  if (!row || !row.path) {
    return null;
  }
  const job = findJob(db, asString(row.job_url));
  return job ? formatArtifact(row, job) : null;
}

function findLegacyArtifact(db: SqliteDatabase, artifactId: string): ArtifactSummary | null {
  return artifactsForJobs(db, loadJobs(db)).find((item) => item.artifactId === artifactId) ?? null;
}

function legacyArtifacts(job: JobRow, existing: ArtifactSummary[]): ArtifactSummary[] {
  // Phase 6 (S-20) artifact derivation: prefer the joined materials
  // artifact paths over the legacy ``jobs.*_path`` columns. The PDF
  // siblings come straight from the materials join (no longer guessed
  // by suffix-swapping) when they exist.
  const tailorPath = (job.jm_tailored_path ?? job.tailored_resume_path) as string | null | undefined;
  const tailorAt = (job.jm_tailored_at ?? job.tailored_at) as string | null | undefined;
  const coverPath = (job.jm_cover_path ?? job.cover_letter_path) as string | null | undefined;
  const coverAt = (job.jm_cover_at ?? job.cover_letter_at) as string | null | undefined;
  const resumePdfPath = (job.jm_resume_pdf_path ?? pdfSibling(tailorPath)) as string | null | undefined;
  const coverPdfPath = (job.jm_cover_pdf_path ?? pdfSibling(coverPath)) as string | null | undefined;
  const candidates = [
    ["tailored_resume_txt", tailorPath, tailorAt],
    ["tailored_resume_pdf", resumePdfPath, tailorAt],
    ["cover_letter_txt", coverPath, coverAt],
    ["cover_letter_pdf", coverPdfPath, coverAt],
  ] as const;
  const seen = new Set(existing.filter((artifact) => artifact.jobKey === job.url).map((artifact) => `${artifact.type}:${artifact.localPath}`));
  return candidates.flatMap(([type, localPath, createdAt]) => {
    if (!localPath || seen.has(`${type}:${localPath}`)) {
      return [];
    }
    const sizeBytes = localFileSize(localPath);
    return [
      {
        artifactId: `${job.url}:${type}:${localPath}`,
        jobKey: job.url ?? "",
        title: asString(job.title) || "Untitled",
        company: companyName(job),
        type,
        status: sizeBytes === null ? "missing" : "active",
        localPath,
        createdAt: asNullableString(createdAt),
        sizeBytes,
        size: formatSize(sizeBytes),
      },
    ];
  });
}

function filterJob(job: JobSummary, query: JobListQuery, normalizedQuery: string): boolean {
  if (query.stage && job.currentStage !== query.stage) {
    return false;
  }
  if (query.state && job.currentState !== query.state) {
    return false;
  }
  if (query.source && !job.source.toLowerCase().includes(query.source.toLowerCase())) {
    return false;
  }
  if (query.company && !job.company.toLowerCase().includes(query.company.toLowerCase())) {
    return false;
  }
  if (query.minFitScore !== undefined && (job.fitScore ?? -1) < query.minFitScore) {
    return false;
  }
  if (query.maxFitScore !== undefined && (job.fitScore ?? 999) > query.maxFitScore) {
    return false;
  }
  if (!normalizedQuery) {
    return true;
  }
  return [job.title, job.company, job.url, job.location, job.strategy, job.currentStage, job.currentState].some((value) =>
    value.toLowerCase().includes(normalizedQuery),
  );
}

function compareJobs(left: JobSummary, right: JobSummary, field: string, direction: "asc" | "desc"): number {
  const multiplier = direction === "asc" ? 1 : -1;
  const values: Record<string, [unknown, unknown]> = {
    discovered_at: [left.discoveredAt, right.discoveredAt],
    title: [left.title, right.title],
    company: [left.company, right.company],
    location: [left.location, right.location],
    fit_score: [left.fitScore ?? -1, right.fitScore ?? -1],
    current_stage: [left.currentStage, right.currentStage],
    current_state: [STATE_RANK[left.currentState], STATE_RANK[right.currentState]],
  };
  const [leftValue, rightValue] = values[field] ?? values.discovered_at!;
  return compareValues(leftValue, rightValue) * multiplier;
}

function compareArtifacts(
  left: ArtifactSummary,
  right: ArtifactSummary,
  field: string,
  direction: "asc" | "desc",
): number {
  const multiplier = direction === "asc" ? 1 : -1;
  const values: Record<string, [unknown, unknown]> = {
    created_at: [left.createdAt, right.createdAt],
    title: [left.title, right.title],
    company: [left.company, right.company],
    type: [left.type, right.type],
    status: [left.status, right.status],
    size_bytes: [left.sizeBytes ?? -1, right.sizeBytes ?? -1],
  };
  const [leftValue, rightValue] = values[field] ?? values.created_at!;
  return compareValues(leftValue, rightValue) * multiplier;
}

function paginate<T>(
  items: T[],
  page: number,
  pageSize: number,
  sortField: string,
  sortDir: "asc" | "desc",
  filter: Record<string, unknown>,
): PaginatedResponse<T> {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const offset = (safePage - 1) * pageSize;
  return {
    ok: true,
    items: items.slice(offset, offset + pageSize),
    pagination: {
      page: safePage,
      pageSize,
      total,
      pages,
    },
    sort: {
      field: sortField,
      dir: sortDir,
    },
    filter,
  };
}

function paginateWithTotal<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
  sortField: string,
  sortDir: "asc" | "desc",
  filter: Record<string, unknown>,
): PaginatedResponse<T> {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return {
    ok: true,
    items,
    pagination: {
      page,
      pageSize,
      total,
      pages,
    },
    sort: {
      field: sortField,
      dir: sortDir,
    },
    filter,
  };
}

function recentActivity(db: SqliteDatabase): DashboardSummary["activity"] {
  if (!tableExists(db, "job_events")) {
    return [];
  }
  const hideDeletedJoin = tableExists(db, "jobhunter_deleted_jobs")
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = e.job_url AND d.restored_at IS NULL"
    : "";
  const hideDeletedWhere = tableExists(db, "jobhunter_deleted_jobs") ? "WHERE d.job_url IS NULL" : "";
  const activitySql = tableExists(db, "jobs")
    ? `SELECT
      e.event_id,
      e.job_url,
      e.stage,
      e.level,
      e.message,
      e.occurred_at,
      j.title,
      j.site
    FROM job_events e
    LEFT JOIN jobs j ON j.url = e.job_url
    ${hideDeletedJoin}
    ${hideDeletedWhere}
    ORDER BY e.occurred_at DESC, e.event_id DESC
    LIMIT 20`
    : `SELECT
      event_id,
      job_url,
      stage,
      level,
      message,
      occurred_at,
      NULL AS title,
      NULL AS site
    FROM job_events
    ORDER BY occurred_at DESC, event_id DESC
    LIMIT 20`;
  return allRows<Record<string, unknown>>(db, activitySql).map((row) => ({
    eventId: asString(row.event_id),
    jobKey: asNullableString(row.job_url),
    title: asNullableString(row.title),
    company: companyName({ ...row, url: row.job_url } as JobRow),
    stage: asString(row.stage) || "system",
    level: asString(row.level) || "info",
    message: asString(row.message) || "event",
    at: asNullableString(row.occurred_at),
  }));
}

function recentApplyRuns(db: SqliteDatabase): DashboardSummary["applyRuns"] {
  if (!tableExists(db, "apply_runs")) {
    return [];
  }
  const deletedJoinSql = tableExists(db, "jobhunter_deleted_jobs")
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = apply_runs.job_url AND d.restored_at IS NULL"
    : "";
  const deletedWhereSql = tableExists(db, "jobhunter_deleted_jobs") ? " WHERE d.job_url IS NULL" : "";
  return allRows<Record<string, unknown>>(
    db,
    `SELECT run_id, apply_runs.job_url, title, site, status, result, dry_run, started_at FROM apply_runs${deletedJoinSql}${deletedWhereSql} ORDER BY started_at DESC LIMIT 12`,
  ).map((row) => ({
    runId: asString(row.run_id),
    jobKey: asString(row.job_url),
    title: asString(row.title) || "Untitled",
    company: companyName({ site: row.site, url: row.job_url } as JobRow),
    status: asString(row.status) || asString(row.result) || "unknown",
    dryRun: Boolean(row.dry_run),
    startedAt: asNullableString(row.started_at),
  }));
}

function dryRunCount(db: SqliteDatabase): number {
  if (!tableExists(db, "apply_runs")) {
    return 0;
  }
  const deletedJoinSql = tableExists(db, "jobhunter_deleted_jobs")
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = apply_runs.job_url AND d.restored_at IS NULL"
    : "";
  const deletedWhereSql = tableExists(db, "jobhunter_deleted_jobs") ? " AND d.job_url IS NULL" : "";
  const row = getRow<{ count: number }>(db, `SELECT COUNT(*) AS count FROM apply_runs${deletedJoinSql} WHERE dry_run = 1${deletedWhereSql}`);
  return Number(row?.count ?? 0);
}

function readJson(filePath: string, fallback: unknown): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function previewText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function pdfSibling(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return `${value.replace(/\.[^.]+$/, "")}.pdf`;
}

function formatSize(size: number | null): string {
  if (size === null) {
    return "missing file";
  }
  if (size < 1024) {
    return `${size}b`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)}kb`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)}mb`;
}

function companyName(job: JobRow): string {
  const source = asString(job.site);
  const inferred = inferredCompanyFromUrl(asString(job.application_url) || asString(job.url));
  if (inferred) {
    return inferred;
  }
  if (!source || SOURCE_BOARD_NAMES.has(source.toLowerCase())) {
    return "Unknown company";
  }
  return source;
}

function inferredCompanyFromUrl(rawUrl: string): string {
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
  const normalized = value.toLowerCase();
  const knownNames: Record<string, string> = {
    gitlab: "GitLab",
  };
  if (knownNames[normalized]) {
    return knownNames[normalized];
  }
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function localFileSize(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) {
    return 0;
  }
  if (left === null || left === undefined || left === "") {
    return -1;
  }
  if (right === null || right === undefined || right === "") {
    return 1;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
}

function parseStringArray(value: string | null | undefined): string[] {
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

function isStage(value: unknown): value is Stage {
  return typeof value === "string" && STAGES.includes(value as Stage);
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

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function asNullableString(value: unknown): string | null {
  const stringValue = asString(value);
  return stringValue ? stringValue : null;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: unknown, fallback: string): string {
  const text = asString(value).trim();
  return text.length <= 160 ? text : fallback;
}

function normalizeInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numberValue = Number.parseInt(asString(value), 10);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, numberValue));
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}
