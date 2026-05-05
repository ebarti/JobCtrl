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
  tailored_resume_path?: string | null;
  tailored_at?: string | null;
  tailor_attempts?: number | null;
  cover_letter_path?: string | null;
  cover_letter_at?: string | null;
  cover_attempts?: number | null;
  apply_status?: string | null;
  apply_error?: string | null;
  apply_attempts?: number | null;
  applied_at?: string | null;
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

const SQL_JOB_SORT_COLUMNS: Partial<Record<string, string>> = {
  discovered_at: "discovered_at",
  title: "LOWER(COALESCE(title, ''))",
  company: "LOWER(COALESCE(site, ''))",
  location: "LOWER(COALESCE(location, ''))",
  fit_score: "COALESCE(fit_score, -1)",
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
      descriptionPreview: previewText(asString(job.full_description) || asString(job.description), 6000),
      scoreReasoning: asString(job.score_reasoning),
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
    `SELECT ${JOB_COLUMNS.map((column) => `jobs.${column}`).join(", ")}${deletedSelect(db)} FROM jobs${deletedJoin(db)}${filter.where}`,
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
  const totalRow = getRow<{ count: number }>(db, `SELECT COUNT(*) AS count FROM jobs${deletedJoin(db)}${filter.where}`, filter.params);
  const total = Number(totalRow?.count ?? 0);
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, pages);
  const offset = (page - 1) * query.pageSize;
  const direction = query.dir === "asc" ? "ASC" : "DESC";
  const jobs = allRows<JobRow>(
    db,
    `SELECT ${JOB_COLUMNS.map((column) => `jobs.${column}`).join(", ")}${deletedSelect(db)} FROM jobs${deletedJoin(db)}${filter.where} ORDER BY ${sqlSortColumn} ${direction}, url ASC LIMIT ? OFFSET ?`,
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
    clauses.push("COALESCE(fit_score, -1) >= ?");
    params.push(query.minFitScore);
  }
  if (query.maxFitScore !== undefined) {
    clauses.push("COALESCE(fit_score, 999) <= ?");
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
    `SELECT jobs.*${deletedSelect(db)} FROM jobs${deletedJoin(db)} WHERE jobs.url = ? OR jobs.application_url = ? LIMIT 1`,
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
    applicationUrl: asNullableString(job.application_url),
    fitScore: asNullableNumber(job.fit_score),
    currentStage: current.stage,
    currentState: current.state,
    errorCode: current.errorCode,
    errorMessage: current.errorMessage,
    nextAction: current.nextAction,
    artifactCount: artifactCounts.get(jobKey) ?? 0,
    applyStatus: asNullableString(job.apply_status),
    appliedAt: asNullableString(job.applied_at),
    deletedAt: asNullableString(job.deleted_at),
  };
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
  const hasScore = Boolean(job.scored_at) || asNullableNumber(job.fit_score) !== null;
  const enrich = job.detail_error
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
  const tailor = deriveArtifactStage("tailor", score, job.tailored_resume_path, job.tailor_attempts);
  const cover = deriveArtifactStage("cover", tailor, job.cover_letter_path, job.cover_attempts);
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
  const status = asString(job.apply_status).toLowerCase();
  if (job.applied_at || status === "applied") {
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
  const candidates = [
    ["tailored_resume_txt", job.tailored_resume_path, job.tailored_at],
    ["tailored_resume_pdf", pdfSibling(job.tailored_resume_path), job.tailored_at],
    ["cover_letter_txt", job.cover_letter_path, job.cover_letter_at],
    ["cover_letter_pdf", pdfSibling(job.cover_letter_path), job.cover_letter_at],
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
