import fs from "node:fs";

import type {
  ArtifactListQuery,
  ArtifactSummary,
  JobListQuery,
  JobSummary,
  PaginatedResponse,
  Stage,
  StageState,
  StageSummary,
} from "./contracts.js";
import { STAGES } from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase } from "./db.js";

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

export interface DashboardSummary {
  ok: true;
  generatedAt: string;
  totals: {
    jobs: number;
    failures: number;
    blocked: number;
    ready: number;
    applied: number;
    dryRuns: number;
  };
  funnel: Array<{
    stage: Stage;
    total: number;
    succeeded: number;
    running: number;
    pending: number;
    blocked: number;
    failed: number;
  }>;
  activity: Array<{
    jobKey: string | null;
    stage: string;
    level: string;
    message: string;
    at: string | null;
  }>;
  applyRuns: Array<{
    runId: string;
    jobKey: string;
    title: string;
    company: string;
    status: string;
    dryRun: boolean;
    startedAt: string | null;
  }>;
}

export interface JobDetail {
  ok: true;
  job: JobSummary & {
    descriptionPreview: string;
    scoreReasoning: string;
  };
  stages: StageSummary[];
  artifacts: ArtifactSummary[];
}

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
  const jobs = loadJobs(db);
  const explicitStates = loadStageStates(db);
  const artifactCounts = artifactCountByJob(db, jobs);
  const normalizedQuery = query.q.toLowerCase();

  const filtered = jobs
    .map((job) => buildJobSummary(job, statesForJob(job, explicitStates), artifactCounts))
    .filter((job) => filterJob(job, query, normalizedQuery));

  filtered.sort((left, right) => compareJobs(left, right, query.sort, query.dir));

  return paginate(filtered, query.page, query.pageSize, query.sort, query.dir, {
    q: query.q,
    stage: query.stage ?? "",
    state: query.state ?? "",
    source: query.source,
    company: query.company,
    minFitScore: query.minFitScore ?? null,
    maxFitScore: query.maxFitScore ?? null,
  });
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
      descriptionPreview: previewText(asString(job.full_description) || asString(job.description), 1800),
      scoreReasoning: asString(job.score_reasoning),
    },
    stages,
    artifacts: artifactsForJobs(db, [job]),
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

export function readProfileConfig(paths: {
  profilePath: string;
  resumeStylePath: string;
  resumeTemplatePath: string;
}): { ok: true; profile: unknown; style: unknown; templateText: string; paths: Record<string, string> } {
  return {
    ok: true,
    profile: readJson(paths.profilePath, {}),
    style: readJson(paths.resumeStylePath, {}),
    templateText: readText(paths.resumeTemplatePath),
    paths,
  };
}

function loadJobs(db: SqliteDatabase): JobRow[] {
  if (!tableExists(db, "jobs")) {
    return [];
  }
  return allRows<JobRow>(db, "SELECT * FROM jobs");
}

function findJob(db: SqliteDatabase, jobKey: string): JobRow | null {
  if (!tableExists(db, "jobs")) {
    return null;
  }
  const row = getRow<JobRow>(db, "SELECT * FROM jobs WHERE url = ? OR application_url = ? LIMIT 1", [jobKey, jobKey]);
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
    company: asString(job.site) || "Unknown",
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
    for (const row of allRows<ArtifactRow>(db, "SELECT rowid AS artifact_id, * FROM job_artifacts")) {
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
  const sizeBytes = asNullableNumber(row.size_bytes) ?? pathSize(localPath);
  return {
    artifactId: asString(row.artifact_id) || `${asString(row.job_url)}:${asString(row.artifact_type)}:${localPath}`,
    jobKey: job.url ?? "",
    title: asString(job.title) || "Untitled",
    company: asString(job.site) || "Unknown",
    type: asString(row.artifact_type) || "artifact",
    status: asString(row.status) || (pathExists(localPath) ? "active" : "stale"),
    localPath,
    createdAt: asNullableString(row.created_at),
    sizeBytes,
    size: formatSize(sizeBytes),
  };
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
    const sizeBytes = pathSize(localPath);
    return [
      {
        artifactId: `${job.url}:${type}:${localPath}`,
        jobKey: job.url ?? "",
        title: asString(job.title) || "Untitled",
        company: asString(job.site) || "Unknown",
        type,
        status: pathExists(localPath) ? "active" : "stale",
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

function recentActivity(db: SqliteDatabase): DashboardSummary["activity"] {
  if (!tableExists(db, "job_events")) {
    return [];
  }
  return allRows<Record<string, unknown>>(
    db,
    "SELECT job_url, stage, level, message, occurred_at FROM job_events ORDER BY occurred_at DESC, event_id DESC LIMIT 20",
  ).map((row) => ({
    jobKey: asNullableString(row.job_url),
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
  return allRows<Record<string, unknown>>(
    db,
    "SELECT run_id, job_url, title, site, status, result, dry_run, started_at FROM apply_runs ORDER BY started_at DESC LIMIT 12",
  ).map((row) => ({
    runId: asString(row.run_id),
    jobKey: asString(row.job_url),
    title: asString(row.title) || "Untitled",
    company: asString(row.site) || "Unknown",
    status: asString(row.status) || asString(row.result) || "unknown",
    dryRun: Boolean(row.dry_run),
    startedAt: asNullableString(row.started_at),
  }));
}

function dryRunCount(db: SqliteDatabase): number {
  if (!tableExists(db, "apply_runs")) {
    return 0;
  }
  const row = getRow<{ count: number }>(db, "SELECT COUNT(*) AS count FROM apply_runs WHERE dry_run = 1");
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

function pathExists(value: string): boolean {
  return Boolean(value) && fs.existsSync(value);
}

function pathSize(value: string): number | null {
  if (!pathExists(value)) {
    return null;
  }
  return fs.statSync(value).size;
}

function formatSize(size: number | null): string {
  if (!size) {
    return "missing";
  }
  if (size < 1024) {
    return `${size}b`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)}kb`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)}mb`;
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
