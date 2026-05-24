/**
 * TS read-model — projection-backed (Phase 9 / S-33).
 *
 * Per the no-strangler directive, the legacy LEFT-JOIN-with-COALESCE
 * helpers have been deleted.  Every endpoint now reads from one of the
 * five ``*_projections`` tables maintained by ``projections.ts`` (TS
 * mirror) and the Python ``ProjectionBuilder``.  The projection tables
 * carry the canonical denormalised view; reads are simple SELECTs with
 * no per-stage join soup.
 *
 * The refresh runs at the start of every read so the projections always
 * reflect the latest worker writes (which all push to ``job_events``).
 * The refresh is incremental (driven by the ``operations_projections``
 * watermark in ``event_watermarks``) — typically zero or a handful of
 * rows per request.
 */
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
  ProfileShape,
  ScoreBreakdown,
  SettingsResponse,
  Stage,
  StageState,
  StageSummary,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowRunsListQuery,
} from "./contracts.js";
import { ProfileSchema, STAGES, WORKFLOW_RUN_STATUSES } from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import { normalizeJobLocation } from "./location-normalization.js";
import { refreshProjections } from "./projections.js";

const DEFAULT_TENANT = "local";

const DEFAULT_MAX_ATTEMPTS: Record<Stage, number> = {
  discover: 1,
  enrich: 3,
  score: 3,
  tailor: 5,
  cover: 5,
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

interface JobListProjectionRow extends Record<string, unknown> {
  tenant_id: string;
  job_id: string;
  title: string;
  employer: string;
  source: string;
  discovery_source: string;
  posting_source_url: string | null;
  posting_source_ats_kind: string | null;
  strategy: string;
  location: string;
  salary: string;
  application_url: string | null;
  discovered_at: string | null;
  description: string;
  full_description: string;
  fit_score: number | null;
  score_breakdown_json: string | null;
  score_keywords_json: string;
  score_reasoning: string;
  score_version: number | null;
  scored_at: string | null;
  score_criteria_json: string | null;
  score_trace_json: string | null;
  score_correction_json: string | null;
  score_stale_reason: string | null;
  score_stale_old_policy_version: number | null;
  score_stale_new_policy_version: number | null;
  score_stale_marked_at: string | null;
  current_stage: string;
  current_state: string;
  current_error_code: string | null;
  current_error_message: string | null;
  current_next_action: string | null;
  has_resume: number;
  has_cover_letter: number;
  has_pdf: number;
  apply_status: string | null;
  applied_at: string | null;
  artifact_count: number;
  deleted_at: string | null;
  hidden_at: string | null;
  last_updated_at: string | null;
}

interface JobDetailProjectionRow extends Record<string, unknown> {
  tenant_id: string;
  job_id: string;
  description_preview: string;
  score_breakdown_json: string | null;
  score_keywords_json: string;
  score_reasoning: string;
  score_version: number | null;
  scored_at: string | null;
  score_criteria_json: string | null;
  score_trace_json: string | null;
  score_correction_json: string | null;
  stages_json: string;
  last_updated_at: string | null;
}

interface ArtifactProjectionRow extends Record<string, unknown> {
  artifact_id: string;
  tenant_id: string;
  job_id: string;
  job_title: string;
  job_employer: string;
  artifact_type: string;
  status: string;
  local_path: string;
  size_bytes: number | null;
  created_at: string | null;
  generation: number | null;
}

interface DashboardProjectionRow extends Record<string, unknown> {
  tenant_id: string;
  total_jobs: number;
  failures: number;
  blocked: number;
  ready: number;
  applied: number;
  dry_runs: number;
  funnel_json: string;
  by_source_json: string;
  score_distribution_json: string;
  generated_at: string;
}

interface ApplyRunProjectionRow extends Record<string, unknown> {
  run_id: string;
  tenant_id: string;
  job_id: string;
  job_title: string;
  job_employer: string;
  status: string;
  result: string | null;
  dry_run: number;
  worker_id: number | null;
  model: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  events_json: string;
}

interface SourceQualityProjectionRow extends Record<string, unknown> {
  source_id: string;
  recommended_state: string;
  run_count: number;
  failed_run_count: number;
  consecutive_failures: number;
  observed_jobs: number;
  new_jobs: number;
  existing_jobs: number;
  duplicate_rate: number | null;
  active_verification_rate: number | null;
  full_description_success_rate: number | null;
  apply_url_success_rate: number | null;
  last_run_id: string | null;
  last_error_class: string | null;
  updated_at: string | null;
}

interface OperationalMetricRow extends Record<string, unknown> {
  metric_id: number;
  stage: string;
  source_id: string | null;
  source_kind: string | null;
  source_priority: string | null;
  source_role: string | null;
  adapter: string | null;
  outcome: string;
  failure_category: string | null;
  is_operational_failure: number;
  is_scrape_failure: number;
  is_retryable: number;
  run_id: string | null;
  duration_ms: number | null;
  error_class: string | null;
}

interface OperationalRollup {
  key: string;
  stage: string;
  sourceId: string | null;
  adapter: string | null;
  sourceKind: string | null;
  sourcePriority: string | null;
  sourceRole: string | null;
  attempts: number;
  failures: number;
  operationalFailures: number;
  scrapeFailures: number;
  retryableFailures: number;
  durationTotal: number;
  durationSamples: number;
  lastOutcome: string | null;
  lastFailureCategory: string | null;
  lastErrorClass: string | null;
  lastRunId: string | null;
}

const SQL_JOB_SORT_COLUMNS: Partial<Record<string, string>> = {
  discovered_at: "discovered_at",
  title: "LOWER(title)",
  company: "LOWER(employer)",
  location: "LOWER(location)",
  fit_score: "COALESCE(fit_score, -1)",
};

export function buildDashboardSummary(db: SqliteDatabase): DashboardSummary {
  refreshProjections(db, DEFAULT_TENANT);
  const dashboardRow = getRow<DashboardProjectionRow>(
    db,
    "SELECT * FROM dashboard_projections WHERE tenant_id = ?",
    [DEFAULT_TENANT],
  );
  const dashboard = dashboardRow ?? defaultDashboardRow();
  const operationalMetrics = buildOperationalMetrics(db);
  return {
    ok: true,
    generatedAt: dashboard.generated_at || new Date().toISOString(),
    totals: {
      jobs: Number(dashboard.total_jobs ?? 0),
      failures: Number(dashboard.failures ?? 0),
      blocked: Number(dashboard.blocked ?? 0),
      ready: Number(dashboard.ready ?? 0),
      applied: Number(dashboard.applied ?? 0),
      dryRuns: Number(dashboard.dry_runs ?? 0),
    },
    funnel: parseFunnel(dashboard.funnel_json),
    activity: recentActivity(db),
    sourceHealth: listSourceHealth(db),
    operationalMetrics,
    applyRuns: recentApplyRuns(db),
  };
}

export function listJobs(db: SqliteDatabase, query: JobListQuery): PaginatedResponse<JobSummary> {
  refreshProjections(db, DEFAULT_TENANT);
  const sortColumn = SQL_JOB_SORT_COLUMNS[query.sort] ?? "discovered_at";
  const filter = jobSqlFilter(db, query);
  const projectionSelect = jobProjectionSelect(db);

  if (!query.q) {
    const total = countJobProjections(db, filter);
    const pages = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, pages);
    const offset = (page - 1) * query.pageSize;
    const direction = query.dir === "asc" ? "ASC" : "DESC";
    const rows = allRows<JobListProjectionRow>(
      db,
      `SELECT ${projectionSelect} FROM job_list_projections${filter.where} ORDER BY ${sortColumn} ${direction}, job_id ASC LIMIT ? OFFSET ?`,
      [...filter.params, query.pageSize, offset],
    );
    const summaries = rows.map(rowToJobSummary);
    return paginateWithTotal(summaries, total, page, query.pageSize, query.sort, query.dir, jobFilterPayload(query));
  }

  // Free-text search: pull all matching rows and filter in memory (the
  // projection table makes this cheap — it's already denormalised).
  const allMatching = allRows<JobListProjectionRow>(
    db,
    `SELECT ${projectionSelect} FROM job_list_projections${filter.where}`,
    filter.params,
  );
  const normalizedQuery = query.q.toLowerCase();
  const filtered = allMatching.map(rowToJobSummary).filter((job) => filterJob(job, query, normalizedQuery));
  filtered.sort((left, right) => compareJobs(left, right, query.sort, query.dir));
  return paginate(filtered, query.page, query.pageSize, query.sort, query.dir, jobFilterPayload(query));
}

export function matchingJobKeys(db: SqliteDatabase, filter: Partial<BulkJobMutationFilter> = {}): string[] {
  const query = normalizeMutationFilter(filter);
  refreshProjections(db, DEFAULT_TENANT);
  const sqlFilter = jobSqlFilter(db, query);
  const rows = allRows<JobListProjectionRow>(
    db,
    `SELECT ${jobProjectionSelect(db)} FROM job_list_projections${sqlFilter.where}`,
    sqlFilter.params,
  );
  const normalizedQuery = query.q.toLowerCase();
  return rows
    .map(rowToJobSummary)
    .filter((job) => filterJob(job, query, normalizedQuery))
    .map((job) => job.jobKey);
}

export function getJobDetail(db: SqliteDatabase, jobKey: string): JobDetail | null {
  refreshProjections(db, DEFAULT_TENANT);
  const listRow = findJobListRow(db, jobKey);
  if (!listRow) return null;
  const detailRow = getRow<JobDetailProjectionRow>(
    db,
    "SELECT * FROM job_detail_projections WHERE tenant_id = ? AND job_id = ?",
    [DEFAULT_TENANT, listRow.job_id],
  );
  const stages = parseStages(detailRow?.stages_json);
  const artifacts = artifactsForJob(db, listRow.job_id);
  return {
    ok: true,
    job: {
      ...rowToJobSummary(listRow),
      descriptionPreview: detailRow?.description_preview ?? "",
      scoreReasoning: detailRow?.score_reasoning ?? listRow.score_reasoning,
    },
    stages,
    artifacts,
  };
}

function findJobListRow(db: SqliteDatabase, jobKey: string): JobListProjectionRow | null {
  const direct = getRow<JobListProjectionRow>(
    db,
    `SELECT ${jobProjectionSelect(db)} FROM job_list_projections WHERE tenant_id = ? AND job_id = ?`,
    [DEFAULT_TENANT, jobKey],
  );
  if (direct) return direct;
  // Fall back to application_url match for the "open via apply URL" case.
  return (
    getRow<JobListProjectionRow>(
      db,
      `SELECT ${jobProjectionSelect(db)} FROM job_list_projections WHERE tenant_id = ? AND application_url = ? LIMIT 1`,
      [DEFAULT_TENANT, jobKey],
    ) ?? null
  );
}

export function listArtifacts(db: SqliteDatabase, query: ArtifactListQuery): PaginatedResponse<ArtifactSummary> {
  refreshProjections(db, DEFAULT_TENANT);
  const normalizedQuery = query.q.toLowerCase();
  const deletedJoin = tableExists(db, "jobhunter_deleted_jobs")
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = ap.job_id AND d.restored_at IS NULL"
    : "";
  const hiddenJoin = tableExists(db, "jobhunter_hidden_jobs")
    ? " LEFT JOIN jobhunter_hidden_jobs h ON h.job_url = ap.job_id AND h.unhidden_at IS NULL"
    : "";
  const deletedWhere = tableExists(db, "jobhunter_deleted_jobs") ? " AND d.job_url IS NULL" : "";
  const hiddenWhere = tableExists(db, "jobhunter_hidden_jobs") ? " AND h.job_url IS NULL" : "";
  const rows = allRows<ArtifactProjectionRow>(
    db,
    `SELECT ap.* FROM artifact_list_projections ap${deletedJoin}${hiddenJoin}
     WHERE ap.tenant_id = ?${deletedWhere}${hiddenWhere}`,
    [DEFAULT_TENANT],
  );
  const artifacts = rows.map(rowToArtifactSummary).filter((artifact) => {
    if (query.status && artifact.status !== query.status) return false;
    if (query.type && artifact.type !== query.type) return false;
    if (!normalizedQuery) return true;
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
  refreshProjections(db, DEFAULT_TENANT);
  const row = getRow<ArtifactProjectionRow>(
    db,
    "SELECT * FROM artifact_list_projections WHERE artifact_id = ?",
    [artifactId],
  );
  if (!row) return null;
  return { ok: true, artifact: rowToArtifactSummary(row) };
}

/** Validate a candidate profile JSON. Used by callers (e.g. tests, future
 * SDK helpers) that want to assert canonical shape before posting. */
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

// ============================================================== mappings

function rowToJobSummary(row: JobListProjectionRow): JobSummary {
  const jobKey = row.job_id;
  return {
    jobKey,
    url: jobKey,
    title: row.title || "Untitled",
    company: row.employer || "Unknown company",
    source: row.source || "unknown",
    discoverySource: displayDiscoverySource(row.discovery_source, row.strategy, row.source),
    postingSource: displayPostingSource(row.posting_source_ats_kind, row.posting_source_url),
    postingSourceUrl: row.posting_source_url,
    strategy: row.strategy ?? "",
    location: normalizeJobLocation(row.location),
    salary: row.salary ?? "",
    discoveredAt: row.discovered_at,
    applicationUrl: row.application_url,
    fitScore: row.fit_score === null || row.fit_score === undefined ? null : Number(row.fit_score),
    scoreBreakdown: parseScoreBreakdown(row.score_breakdown_json),
    scoreKeywords: parseScoreKeywords(row.score_keywords_json),
    scoreReasoning: row.score_reasoning ?? "",
    scoreVersion: nullableNumber(row.score_version),
    scoredAt: nullableString(row.scored_at),
    scoreCriteria: parseScoreCriteria(row.score_criteria_json),
    scoreTrace: parseScoreTrace(row.score_trace_json),
    scoreCorrection: parseScoreCorrection(row.score_correction_json),
    scoreStaleness: parseScoreStaleness(row),
    currentStage: (isStage(row.current_stage) ? row.current_stage : "discover") as Stage,
    currentState: (isStageState(row.current_state) ? row.current_state : "pending") as StageState,
    errorCode: row.current_error_code,
    errorMessage: row.current_error_message,
    nextAction: row.current_next_action,
    artifactCount: Number(row.artifact_count ?? 0),
    applyStatus: row.apply_status,
    appliedAt: row.applied_at,
    deletedAt: row.deleted_at,
    hiddenAt: row.hidden_at,
  };
}

function parseScoreBreakdown(value: string | null): ScoreBreakdown | null {
  let parsed: unknown = null;
  try {
    parsed = value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return {
    technicalFit: scoreDimension(parsed.technical_fit ?? parsed.technicalFit),
    experienceFit: scoreDimension(parsed.experience_fit ?? parsed.experienceFit),
    roleFit: scoreDimension(parsed.role_fit ?? parsed.roleFit),
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    fitBand: parseChoice(parsed.fit_band ?? parsed.fitBand, "plausible", [
      "excellent",
      "strong",
      "plausible",
      "stretch",
      "poor",
    ]),
    confidence: parseChoice(parsed.confidence, "medium", ["high", "medium", "low"]),
    eligibility: parseScoreEligibility(parsed.eligibility),
    matchedSignals: parseStringList(parsed.matched_signals ?? parsed.matchedSignals),
    missingSignals: parseStringList(parsed.missing_signals ?? parsed.missingSignals),
    transferableSignals: parseStringList(parsed.transferable_signals ?? parsed.transferableSignals),
  };
}

function parseScoreEligibility(value: unknown): ScoreBreakdown["eligibility"] {
  if (!isRecord(value)) {
    return { status: "unknown", hardBlockers: [], warnings: [] };
  }
  return {
    status: parseChoice(value.status, "unknown", ["eligible", "warning", "blocked", "unknown"]),
    hardBlockers: parseStringList(value.hard_blockers ?? value.hardBlockers),
    warnings: parseStringList(value.warnings),
  };
}

function parseScoreCriteria(value: string | null): JobSummary["scoreCriteria"] {
  const parsed = parseJsonRecord(value);
  if (!parsed) return null;
  return {
    minFitScore: scoreDimension(parsed.min_fit_score ?? parsed.minFitScore),
    criteriaText: stringField(parsed.criteria_text ?? parsed.criteriaText),
    targetCriteria: stringField(parsed.target_criteria ?? parsed.targetCriteria),
    criteriaVersion: stringField(parsed.criteria_version ?? parsed.criteriaVersion),
  };
}

function parseScoreTrace(value: string | null): JobSummary["scoreTrace"] {
  const parsed = parseJsonRecord(value);
  if (!parsed) return null;
  return {
    promptVersion: stringField(parsed.prompt_version ?? parsed.promptVersion),
    schemaVersion: stringField(parsed.schema_version ?? parsed.schemaVersion),
    model: stringField(parsed.model),
    criteriaVersion: stringField(parsed.criteria_version ?? parsed.criteriaVersion),
    profileSnapshotVersion: Number(parsed.profile_snapshot_version ?? parsed.profileSnapshotVersion ?? 0),
    scoringPolicyId: stringField(parsed.scoring_policy_id ?? parsed.scoringPolicyId),
    scoringPolicyVersion: Number(parsed.scoring_policy_version ?? parsed.scoringPolicyVersion ?? 0),
    rubricVersion: stringField(parsed.rubric_version ?? parsed.rubricVersion),
    rawWeightedScore: nullableNumber(parsed.raw_weighted_score ?? parsed.rawWeightedScore),
    calibrationAdjustment: Number(parsed.calibration_adjustment ?? parsed.calibrationAdjustment ?? 0),
    policyAnchorCount: parseStringList(parsed.anchor_ids ?? parsed.anchorIds).length,
    resolvedFitBand: stringField(parsed.resolved_fit_band ?? parsed.resolvedFitBand),
    resolutionReason: stringField(parsed.resolution_reason ?? parsed.resolutionReason),
    parserWarnings: parseStringList(parsed.parser_warnings ?? parsed.parserWarnings),
    correctionHistory: parseCorrectionList(parsed.correction_history ?? parsed.correctionHistory),
  };
}

function parseScoreStaleness(row: JobListProjectionRow): JobSummary["scoreStaleness"] {
  const staleReason = nullableString(row.score_stale_reason);
  return {
    isStale: Boolean(staleReason),
    staleReason,
    currentPolicyVersion: nullableNumber(row.score_stale_old_policy_version),
    targetPolicyVersion: nullableNumber(row.score_stale_new_policy_version),
    markedAt: nullableString(row.score_stale_marked_at),
    pendingExplicitRescore: Boolean(staleReason),
  };
}

function parseScoreCorrection(value: string | null): JobSummary["scoreCorrection"] {
  const parsed = parseJsonRecord(value);
  return parsed ? parseCorrectionRecord(parsed) : null;
}

function parseCorrectionList(value: unknown): NonNullable<JobSummary["scoreTrace"]>["correctionHistory"] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(parseCorrectionRecord);
}

function parseCorrectionRecord(value: Record<string, unknown>): NonNullable<JobSummary["scoreCorrection"]> {
  const originalScore = nullableNumber(value.original_score ?? value.originalScore);
  const correction: NonNullable<JobSummary["scoreCorrection"]> = {
    correctedScore: Number(value.corrected_fit_score ?? value.correctedScore ?? value.corrected_score ?? 0),
    rationale: stringField(value.rationale),
    correctedBy: stringField(value.corrected_by ?? value.correctedBy),
    correctedAt: stringField(value.corrected_at ?? value.correctedAt),
  };
  if (originalScore !== null) {
    correction.originalScore = originalScore;
  }
  return correction;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
  const keywords: string[] = [];
  for (const raw of parsed) {
    const keyword = String(raw ?? "").trim();
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
  }
  return keywords;
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

function parseChoice<T extends string>(value: unknown, fallback: T, allowed: readonly T[]): T {
  const text = String(value ?? "").trim() as T;
  return allowed.includes(text) ? text : fallback;
}

function scoreDimension(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 10) return 10;
  return Math.trunc(n);
}

function rowToArtifactSummary(row: ArtifactProjectionRow): ArtifactSummary {
  const localPath = row.local_path ?? "";
  let sizeBytes = row.size_bytes;
  if (sizeBytes === null || sizeBytes === undefined) {
    sizeBytes = localFileSize(localPath);
  }
  let status = row.status || "active";
  if (localPath && sizeBytes === null) {
    status = "missing";
  }
  return {
    artifactId: row.artifact_id,
    jobKey: row.job_id,
    title: row.job_title || "Untitled",
    company: row.job_employer || "Unknown company",
    type: row.artifact_type || "artifact",
    status,
    localPath,
    createdAt: row.created_at,
    sizeBytes,
    size: formatSize(sizeBytes),
  };
}

function parseFunnel(funnelJson: string): DashboardSummary["funnel"] {
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(funnelJson || "[]");
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return defaultFunnel();
  const byStage = new Map<string, DashboardSummary["funnel"][number]>();
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const stage = String(item.stage ?? "");
    if (!isStage(stage)) continue;
    byStage.set(stage, {
      stage,
      total: Number(item.total ?? 0),
      succeeded: Number(item.succeeded ?? 0),
      running: Number(item.running ?? 0),
      pending: Number(item.pending ?? 0),
      blocked: Number(item.blocked ?? 0),
      failed: Number(item.failed ?? 0),
    });
  }
  return STAGES.map(
    (stage) =>
      byStage.get(stage) ?? {
        stage,
        total: 0,
        succeeded: 0,
        running: 0,
        pending: 0,
        blocked: 0,
        failed: 0,
      },
  );
}

function defaultFunnel(): DashboardSummary["funnel"] {
  return STAGES.map((stage) => ({
    stage,
    total: 0,
    succeeded: 0,
    running: 0,
    pending: 0,
    blocked: 0,
    failed: 0,
  }));
}

function defaultDashboardRow(): DashboardProjectionRow {
  return {
    tenant_id: DEFAULT_TENANT,
    total_jobs: 0,
    failures: 0,
    blocked: 0,
    ready: 0,
    applied: 0,
    dry_runs: 0,
    funnel_json: "[]",
    by_source_json: "[]",
    score_distribution_json: "[]",
    generated_at: "",
  };
}

function listSourceHealth(db: SqliteDatabase): DashboardSummary["sourceHealth"] {
  const operationalBySource = operationalSourceRollups(db);
  const seen = new Set<string>();
  if (!tableExists(db, "source_quality_stats")) {
    return [...operationalBySource.values()].map((source) => sourceRollupToHealth(source));
  }
  const rows = allRows<SourceQualityProjectionRow>(
    db,
    `SELECT source_id, recommended_state, run_count, failed_run_count,
            consecutive_failures, observed_jobs, new_jobs, existing_jobs,
            duplicate_rate, active_verification_rate,
            full_description_success_rate, apply_url_success_rate,
            last_run_id, last_error_class,
            updated_at
     FROM source_quality_stats
     WHERE tenant_id = ?
     ORDER BY recommended_state DESC, observed_jobs DESC, source_id ASC`,
    [DEFAULT_TENANT],
  );
  const sourceHealth = rows.map((row) => {
    seen.add(row.source_id);
    const operational = operationalBySource.get(row.source_id);
    return {
      sourceId: row.source_id,
      recommendedState: row.recommended_state || "normal",
      runCount: Number(row.run_count ?? 0),
      failedRunCount: Number(row.failed_run_count ?? 0),
      consecutiveFailures: Number(row.consecutive_failures ?? 0),
      observedJobs: Number(row.observed_jobs ?? 0),
      newJobs: Number(row.new_jobs ?? 0),
      existingJobs: Number(row.existing_jobs ?? 0),
      duplicateRate: nullableNumber(row.duplicate_rate),
      activeVerificationRate: nullableNumber(row.active_verification_rate),
      fullDescriptionSuccessRate: nullableNumber(row.full_description_success_rate),
      applyUrlSuccessRate: nullableNumber(row.apply_url_success_rate),
      operationalFailureCount: operational?.operationalFailures ?? 0,
      scrapeFailureCount: operational?.scrapeFailures ?? 0,
      retryableFailureCount: operational?.retryableFailures ?? 0,
      lastFailureCategory: operational?.lastFailureCategory ?? null,
      lastRunId: row.last_run_id ?? operational?.lastRunId ?? null,
      lastErrorClass: row.last_error_class ?? operational?.lastErrorClass ?? null,
      updatedAt: row.updated_at,
    };
  });
  for (const source of operationalBySource.values()) {
    if (!source.sourceId || seen.has(source.sourceId)) continue;
    sourceHealth.push(sourceRollupToHealth(source));
  }
  return sourceHealth;
}

function buildOperationalMetrics(db: SqliteDatabase): DashboardSummary["operationalMetrics"] {
  const rows = operationalMetricRows(db);
  const byStage = new Map<string, OperationalRollup>();
  const bySource = new Map<string, OperationalRollup>();
  let attempts = 0;
  let failures = 0;
  let operationalFailures = 0;
  let scrapeFailures = 0;
  let retryableFailures = 0;

  for (const row of rows) {
    attempts += 1;
    if (isFailureMetric(row)) failures += 1;
    if (truthyNumber(row.is_operational_failure)) operationalFailures += 1;
    if (truthyNumber(row.is_scrape_failure)) scrapeFailures += 1;
    if (isFailureMetric(row) && truthyNumber(row.is_retryable)) retryableFailures += 1;
    addOperationalRollup(byStage, row.stage || "unknown", row);
    if (row.source_id) addOperationalRollup(bySource, row.source_id, row);
  }

  return {
    attempts,
    failures,
    operationalFailures,
    scrapeFailures,
    retryableFailures,
    byStage: [...byStage.values()].map((item) => rollupToStageMetric(item)),
    bySource: [...bySource.values()].map((item) => rollupToSourceMetric(item)),
  };
}

function operationalSourceRollups(db: SqliteDatabase): Map<string, OperationalRollup> {
  const rollups = new Map<string, OperationalRollup>();
  for (const row of operationalMetricRows(db)) {
    if (row.source_id) addOperationalRollup(rollups, row.source_id, row);
  }
  return rollups;
}

function operationalMetricRows(db: SqliteDatabase): OperationalMetricRow[] {
  if (!tableExists(db, "operational_attempt_metrics")) return [];
  return allRows<OperationalMetricRow>(
    db,
    `SELECT metric_id, stage, source_id, source_kind, source_priority,
            source_role, adapter, outcome, failure_category,
            is_operational_failure, is_scrape_failure, is_retryable,
            run_id, duration_ms, error_class
     FROM operational_attempt_metrics
     WHERE tenant_id = ? AND outcome != 'started'
     ORDER BY occurred_at ASC, metric_id ASC`,
    [DEFAULT_TENANT],
  );
}

function addOperationalRollup(map: Map<string, OperationalRollup>, key: string, row: OperationalMetricRow): void {
  const current = map.get(key) ?? {
    key,
    stage: row.stage || "unknown",
    sourceId: row.source_id,
    adapter: row.adapter,
    sourceKind: row.source_kind,
    sourcePriority: row.source_priority,
    sourceRole: row.source_role,
    attempts: 0,
    failures: 0,
    operationalFailures: 0,
    scrapeFailures: 0,
    retryableFailures: 0,
    durationTotal: 0,
    durationSamples: 0,
    lastOutcome: null,
    lastFailureCategory: null,
    lastErrorClass: null,
    lastRunId: null,
  };
  current.attempts += 1;
  if (isFailureMetric(row)) current.failures += 1;
  if (truthyNumber(row.is_operational_failure)) current.operationalFailures += 1;
  if (truthyNumber(row.is_scrape_failure)) current.scrapeFailures += 1;
  if (isFailureMetric(row) && truthyNumber(row.is_retryable)) current.retryableFailures += 1;
  if (row.duration_ms !== null && row.duration_ms !== undefined) {
    current.durationTotal += Number(row.duration_ms);
    current.durationSamples += 1;
  }
  current.lastOutcome = row.outcome;
  current.lastRunId = row.run_id ?? current.lastRunId;
  current.adapter = row.adapter ?? current.adapter;
  current.sourceKind = row.source_kind ?? current.sourceKind;
  current.sourcePriority = row.source_priority ?? current.sourcePriority;
  current.sourceRole = row.source_role ?? current.sourceRole;
  if (isFailureMetric(row)) {
    current.lastFailureCategory = row.failure_category;
    current.lastErrorClass = row.error_class;
  }
  map.set(key, current);
}

function rollupToStageMetric(item: OperationalRollup): DashboardSummary["operationalMetrics"]["byStage"][number] {
  return {
    stage: item.stage,
    attempts: item.attempts,
    failures: item.failures,
    operationalFailures: item.operationalFailures,
    scrapeFailures: item.scrapeFailures,
    retryableFailures: item.retryableFailures,
    avgDurationMs: averageDuration(item),
    lastOutcome: item.lastOutcome,
    lastFailureCategory: item.lastFailureCategory,
    lastErrorClass: item.lastErrorClass,
  };
}

function rollupToSourceMetric(item: OperationalRollup): DashboardSummary["operationalMetrics"]["bySource"][number] {
  return {
    ...rollupToStageMetric(item),
    sourceId: item.sourceId || item.key,
    adapter: item.adapter,
    sourceKind: item.sourceKind,
    sourcePriority: item.sourcePriority,
    sourceRole: item.sourceRole,
    lastRunId: item.lastRunId,
  };
}

function sourceRollupToHealth(source: OperationalRollup): DashboardSummary["sourceHealth"][number] {
  return {
    sourceId: source.sourceId || source.key,
    recommendedState: "normal",
    runCount: source.attempts,
    failedRunCount: source.failures,
    consecutiveFailures: source.lastOutcome === "failed" ? source.failures : 0,
    observedJobs: 0,
    newJobs: 0,
    existingJobs: 0,
    duplicateRate: null,
    activeVerificationRate: null,
    fullDescriptionSuccessRate: null,
    applyUrlSuccessRate: null,
    operationalFailureCount: source.operationalFailures,
    scrapeFailureCount: source.scrapeFailures,
    retryableFailureCount: source.retryableFailures,
    lastFailureCategory: source.lastFailureCategory,
    lastRunId: source.lastRunId,
    lastErrorClass: source.lastErrorClass,
    updatedAt: null,
  };
}

function averageDuration(item: OperationalRollup): number | null {
  if (item.durationSamples === 0) return null;
  return Math.round(item.durationTotal / item.durationSamples);
}

function isFailureMetric(row: OperationalMetricRow): boolean {
  return row.outcome === "failed" || row.outcome === "partial_failed";
}

function truthyNumber(value: unknown): boolean {
  return Number(value ?? 0) !== 0;
}

function parseStages(stagesJson: string | undefined): StageSummary[] {
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(stagesJson || "[]");
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return defaultStages();
  const byStage = new Map<Stage, StageSummary>();
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const stage = String(item.stage ?? "");
    if (!isStage(stage)) continue;
    const state = String(item.state ?? "pending");
    byStage.set(stage, {
      stage,
      state: isStageState(state) ? (state as StageState) : "pending",
      attemptCount: Number(item.attempt_count ?? 0),
      maxAttempts:
        item.max_attempts === null || item.max_attempts === undefined
          ? DEFAULT_MAX_ATTEMPTS[stage]
          : Number(item.max_attempts),
      startedAt: nullableString(item.started_at),
      updatedAt: nullableString(item.updated_at),
      finishedAt: nullableString(item.finished_at),
      durationMs: nullableNumber(item.duration_ms),
      errorCode: nullableString(item.error_code),
      errorMessage: nullableString(item.error_message),
      retryable: item.retryable === undefined || item.retryable === null ? true : Boolean(item.retryable),
      blockedBy: Array.isArray(item.blocked_by) ? item.blocked_by.map((it) => String(it)) : [],
      nextAction: nullableString(item.next_action),
    });
  }
  return STAGES.map((stage) => byStage.get(stage) ?? defaultStage(stage, "pending"));
}

function defaultStages(): StageSummary[] {
  return STAGES.map((stage) => defaultStage(stage, "pending"));
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

function artifactsForJob(db: SqliteDatabase, jobId: string): ArtifactSummary[] {
  const rows = allRows<ArtifactProjectionRow>(
    db,
    "SELECT * FROM artifact_list_projections WHERE tenant_id = ? AND job_id = ?",
    [DEFAULT_TENANT, jobId],
  );
  return rows.map(rowToArtifactSummary);
}

// ================================================================ filters

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

function jobSqlFilter(db: SqliteDatabase, query: JobListQuery): { where: string; params: SqliteValue[] } {
  const clauses: string[] = ["tenant_id = ?"];
  const params: SqliteValue[] = [DEFAULT_TENANT];
  const hasHiddenTable = tableExists(db, "jobhunter_hidden_jobs");
  if (query.deleted === "active") {
    clauses.push("deleted_at IS NULL");
    if (hasHiddenTable) {
      clauses.push("NOT EXISTS (SELECT 1 FROM jobhunter_hidden_jobs h WHERE h.job_url = job_id AND h.unhidden_at IS NULL)");
    }
  } else if (query.deleted === "deleted") {
    clauses.push("deleted_at IS NOT NULL");
    if (hasHiddenTable) {
      clauses.push("NOT EXISTS (SELECT 1 FROM jobhunter_hidden_jobs h WHERE h.job_url = job_id AND h.unhidden_at IS NULL)");
    }
  } else if (query.deleted === "hidden") {
    clauses.push(
      hasHiddenTable
        ? "EXISTS (SELECT 1 FROM jobhunter_hidden_jobs h WHERE h.job_url = job_id AND h.unhidden_at IS NULL)"
        : "1 = 0",
    );
  }
  if (query.stage) {
    clauses.push("current_stage = ?");
    params.push(query.stage);
  }
  if (query.state) {
    clauses.push("current_state = ?");
    params.push(query.state);
  }
  if (query.source) {
    const postingSourceUrlSql = postingSourceUrlSqlExpression(db);
    const postingSourceAtsKindSql = postingSourceAtsKindSqlExpression(db);
    clauses.push(
      `(LOWER(source) LIKE ?
        OR LOWER(${discoverySourceSqlExpression(db)}) LIKE ?
        OR LOWER(COALESCE(${postingSourceUrlSql}, '')) LIKE ?
        OR LOWER(COALESCE(${postingSourceAtsKindSql}, '')) LIKE ?
        OR (
          LOWER(COALESCE(${postingSourceAtsKindSql}, '')) LIKE ?
          AND LOWER(COALESCE(${postingSourceUrlSql}, '')) LIKE ?
        ))`,
    );
    const normalizedSource = query.source.toLowerCase();
    const [postingSourceKind, ...postingSourceOwnerParts] = normalizedSource.split(":");
    const postingSourceOwner = postingSourceOwnerParts.join(":") || normalizedSource;
    params.push(
      `%${normalizedSource}%`,
      `%${normalizedSource}%`,
      `%${normalizedSource}%`,
      `%${normalizedSource}%`,
      `%${postingSourceKind}%`,
      `%${postingSourceOwner}%`,
    );
  }
  if (query.company) {
    clauses.push("LOWER(employer) LIKE ?");
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
  return { where: ` WHERE ${clauses.join(" AND ")}`, params };
}

function jobProjectionSelect(db: SqliteDatabase): string {
  const hiddenSelect = tableExists(db, "jobhunter_hidden_jobs")
    ? `(SELECT h.hidden_at
          FROM jobhunter_hidden_jobs h
         WHERE h.job_url = job_list_projections.job_id
           AND h.unhidden_at IS NULL
         LIMIT 1) AS hidden_at`
    : "NULL AS hidden_at";
  const stalenessSelect = tableExists(db, "job_score_staleness")
    ? `(SELECT s.stale_reason
          FROM job_score_staleness s
         WHERE s.tenant_id = job_list_projections.tenant_id
           AND s.job_url = job_list_projections.job_id
           AND s.resolved = 0
         ORDER BY s.marked_at DESC
         LIMIT 1) AS score_stale_reason,
       (SELECT s.old_policy_version
          FROM job_score_staleness s
         WHERE s.tenant_id = job_list_projections.tenant_id
           AND s.job_url = job_list_projections.job_id
           AND s.resolved = 0
         ORDER BY s.marked_at DESC
         LIMIT 1) AS score_stale_old_policy_version,
       (SELECT s.new_policy_version
          FROM job_score_staleness s
         WHERE s.tenant_id = job_list_projections.tenant_id
           AND s.job_url = job_list_projections.job_id
           AND s.resolved = 0
         ORDER BY s.marked_at DESC
         LIMIT 1) AS score_stale_new_policy_version,
       (SELECT s.marked_at
          FROM job_score_staleness s
         WHERE s.tenant_id = job_list_projections.tenant_id
           AND s.job_url = job_list_projections.job_id
           AND s.resolved = 0
         ORDER BY s.marked_at DESC
         LIMIT 1) AS score_stale_marked_at`
    : `NULL AS score_stale_reason,
       NULL AS score_stale_old_policy_version,
       NULL AS score_stale_new_policy_version,
       NULL AS score_stale_marked_at`;
  return `job_list_projections.*,
          ${discoverySourceSqlExpression(db)} AS discovery_source,
          ${postingSourceUrlSqlExpression(db)} AS posting_source_url,
          ${postingSourceAtsKindSqlExpression(db)} AS posting_source_ats_kind,
          ${hiddenSelect},
          ${stalenessSelect}`;
}

function discoverySourceFallback(strategy: string | null | undefined, source: string | null | undefined): string {
  const normalizedStrategy = String(strategy ?? "").trim();
  const normalizedSource = String(source ?? "").trim();
  if (normalizedStrategy === "jobspy" && normalizedSource) {
    return `jobspy:${normalizedSource.toLowerCase()}`;
  }
  return normalizedStrategy || "";
}

function displayDiscoverySource(
  discoverySource: string | null | undefined,
  strategy: string | null | undefined,
  source: string | null | undefined,
): string {
  const observed = String(discoverySource ?? "").trim();
  if (observed && !(strategy === "jobspy" && !observed.includes(":"))) {
    return observed;
  }
  return discoverySourceFallback(strategy, observed || source);
}

function discoverySourceFallbackSql(): string {
  return "CASE WHEN strategy = 'jobspy' AND source != '' THEN 'jobspy:' || LOWER(source) ELSE strategy END";
}

function discoverySourceSqlExpression(db: SqliteDatabase): string {
  const observationSelect = tableExists(db, "job_source_observations") ? latestSourceObservationSql() : "NULL";
  return `CASE
            WHEN strategy = 'jobspy'
             AND COALESCE(${observationSelect}, '') != ''
             AND INSTR(${observationSelect}, ':') = 0
              THEN 'jobspy:' || LOWER(${observationSelect})
            ELSE COALESCE(${observationSelect}, ${discoverySourceFallbackSql()})
          END`;
}

function latestSourceObservationSql(): string {
  return `(SELECT o.source_id
             FROM job_source_observations o
            WHERE o.tenant_id = job_list_projections.tenant_id
              AND o.job_url = job_list_projections.job_id
            ORDER BY o.observed_at DESC, o.source_observation_id DESC
            LIMIT 1)`;
}

function postingSourceUrlSqlExpression(db: SqliteDatabase): string {
  if (!tableExists(db, "job_canonical_identities")) return "NULL";
  return `(SELECT c.canonical_url
             FROM job_canonical_identities c
            WHERE c.tenant_id = job_list_projections.tenant_id
              AND c.job_url = job_list_projections.job_id
            LIMIT 1)`;
}

function postingSourceAtsKindSqlExpression(db: SqliteDatabase): string {
  if (!tableExists(db, "job_canonical_identities")) return "NULL";
  return `(SELECT c.ats_kind
             FROM job_canonical_identities c
            WHERE c.tenant_id = job_list_projections.tenant_id
              AND c.job_url = job_list_projections.job_id
            LIMIT 1)`;
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

function countJobProjections(
  db: SqliteDatabase,
  filter: { where: string; params: SqliteValue[] },
): number {
  const row = getRow<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM job_list_projections${filter.where}`,
    filter.params,
  );
  return Number(row?.count ?? 0);
}

function filterJob(job: JobSummary, query: JobListQuery, normalizedQuery: string): boolean {
  if (query.stage && job.currentStage !== query.stage) return false;
  if (query.state && job.currentState !== query.state) return false;
  if (
    query.source &&
    ![job.source, job.discoverySource, job.postingSource, job.postingSourceUrl ?? ""].some((source) =>
      source.toLowerCase().includes(query.source.toLowerCase()),
    )
  ) {
    return false;
  }
  if (query.company && !job.company.toLowerCase().includes(query.company.toLowerCase())) return false;
  if (query.minFitScore !== undefined && (job.fitScore ?? -1) < query.minFitScore) return false;
  if (query.maxFitScore !== undefined && (job.fitScore ?? 999) > query.maxFitScore) return false;
  if (!normalizedQuery) return true;
  return [
    job.title,
    job.company,
    job.url,
    job.location,
    job.source,
    job.discoverySource,
    job.postingSource,
    job.postingSourceUrl ?? "",
    job.strategy,
    job.currentStage,
    job.currentState,
  ].some((value) => value.toLowerCase().includes(normalizedQuery));
}

function displayPostingSource(
  atsKind: string | null | undefined,
  canonicalUrl: string | null | undefined,
): string {
  const normalizedKind = String(atsKind ?? "").trim().toLowerCase();
  const normalizedUrl = String(canonicalUrl ?? "").trim();
  if (!normalizedUrl || !normalizedKind || normalizedKind === "other") return "";
  return `${normalizedKind}:${postingSourceSlug(normalizedUrl, normalizedKind)}`;
}

function postingSourceSlug(rawUrl: string, atsKind: string): string {
  let host = "";
  let segments: string[] = [];
  try {
    const parsed = new URL(rawUrl);
    host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    segments = parsed.pathname.split("/").filter(Boolean);
  } catch {
    return slugText(rawUrl);
  }
  if (atsKind === "greenhouse") {
    const boardsIndex = segments.indexOf("boards");
    const board = boardsIndex >= 0 ? segments[boardsIndex + 1] : undefined;
    if (board) return slugText(board);
    const firstSegment = segments[0];
    if (host.includes("greenhouse.io") && firstSegment) return slugText(firstSegment);
  }
  if (atsKind === "lever") {
    const postingsIndex = segments.indexOf("postings");
    const postingSite = postingsIndex >= 0 ? segments[postingsIndex + 1] : undefined;
    if (postingSite) return slugText(postingSite);
    const firstSegment = segments[0];
    if (firstSegment) return slugText(firstSegment);
  }
  if (atsKind === "ashby") {
    const boardIndex = segments.indexOf("job-board");
    const board = boardIndex >= 0 ? segments[boardIndex + 1] : undefined;
    if (board) return slugText(board);
    const firstSegment = segments[0];
    if (firstSegment) return slugText(firstSegment);
  }
  return slugText(host || rawUrl);
}

function slugText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "source";
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
    sort: { field: sortField, dir: sortDir },
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
    pagination: { page, pageSize, total, pages },
    sort: { field: sortField, dir: sortDir },
    filter,
  };
}

function recentActivity(db: SqliteDatabase): DashboardSummary["activity"] {
  if (!tableExists(db, "job_events")) return [];
  const eventColumns = columnNames(db, "job_events");
  const eventTypeSelect = eventColumns.has("event_type") ? "e.event_type" : "'Event' AS event_type";
  const hideDeletedJoin = tableExists(db, "jobhunter_deleted_jobs")
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = e.job_url AND d.restored_at IS NULL"
    : "";
  const hideHiddenJoin = tableExists(db, "jobhunter_hidden_jobs")
    ? " LEFT JOIN jobhunter_hidden_jobs h ON h.job_url = e.job_url AND h.unhidden_at IS NULL"
    : "";
  const activityClauses = [
    "(e.job_url IS NULL OR e.job_url = '' OR jp.job_id IS NOT NULL)",
    tableExists(db, "jobhunter_deleted_jobs") ? "d.job_url IS NULL" : "",
    tableExists(db, "jobhunter_hidden_jobs") ? "h.job_url IS NULL" : "",
  ].filter(Boolean);
  const activityWhere = `WHERE ${activityClauses.join(" AND ")}`;
  const sql = `
    SELECT
      e.event_id,
      ${eventTypeSelect},
      e.job_url,
      e.stage,
      e.level,
      e.message,
      e.occurred_at,
      jp.title    AS title,
      jp.employer AS employer
    FROM job_events e
    LEFT JOIN job_list_projections jp ON jp.tenant_id = ? AND jp.job_id = e.job_url
    ${hideDeletedJoin}
    ${hideHiddenJoin}
    ${activityWhere}
    ORDER BY e.occurred_at DESC, e.event_id DESC
    LIMIT 20`;
  return allRows<Record<string, unknown>>(db, sql, [DEFAULT_TENANT]).map((row) => ({
    eventId: stringField(row.event_id),
    eventType: stringField(row.event_type) || "Event",
    jobKey: nullableString(row.job_url),
    title: nullableString(row.title),
    company: nullableString(row.employer),
    stage: stringField(row.stage) || "system",
    level: stringField(row.level) || "info",
    message: stringField(row.message) || "event",
    at: nullableString(row.occurred_at),
  }));
}

function columnNames(db: SqliteDatabase, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) return new Set();
  return new Set(allRows<{ name: string }>(db, `PRAGMA table_info(${tableName})`).map((row) => row.name));
}

/**
 * PR 5 of the Temporal stack — Workflow Runs view source.
 *
 * Reads `apply_run_projections` (now sourced from Temporal workflow
 * histories per PR 4) and projects each row to a `WorkflowRunSummary`.
 * The `runId` IS the Temporal `workflow_id` (see `ApplyWorkflow.run`),
 * so the deep-link to the Temporal Web UI uses it verbatim. The
 * `workflowId` field is kept distinct in the wire shape so future
 * non-apply workflows can supply a different value without a breaking
 * read-model change.
 */
export function listWorkflowRuns(
  db: SqliteDatabase,
  query: WorkflowRunsListQuery,
): PaginatedResponse<WorkflowRunSummary> {
  refreshProjections(db, DEFAULT_TENANT);
  if (!tableExists(db, "apply_run_projections")) {
    return paginate([], query.page, query.pageSize, query.sort, query.dir, {
      status: query.status,
    });
  }
  const deletedJoin = tableExists(db, "jobhunter_deleted_jobs")
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = arp.job_id AND d.restored_at IS NULL"
    : "";
  const hiddenJoin = tableExists(db, "jobhunter_hidden_jobs")
    ? " LEFT JOIN jobhunter_hidden_jobs h ON h.job_url = arp.job_id AND h.unhidden_at IS NULL"
    : "";
  const where: string[] = ["arp.tenant_id = ?"];
  const params: SqliteValue[] = [DEFAULT_TENANT];
  if (tableExists(db, "jobhunter_deleted_jobs")) {
    where.push("d.job_url IS NULL");
  }
  if (tableExists(db, "jobhunter_hidden_jobs")) {
    where.push("h.job_url IS NULL");
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const rows = allRows<ApplyRunProjectionRow>(
    db,
    `SELECT arp.* FROM apply_run_projections arp${deletedJoin}${hiddenJoin}${whereSql}
     ORDER BY arp.started_at DESC, arp.run_id DESC`,
    params,
  );
  const all = rows
    .map(rowToWorkflowRunSummary)
    .filter((run) => query.status === "all" || run.status === query.status);
  all.sort((left, right) => compareWorkflowRuns(left, right, query.sort, query.dir));
  return paginate(all, query.page, query.pageSize, query.sort, query.dir, {
    status: query.status,
  });
}

function compareWorkflowRuns(
  left: WorkflowRunSummary,
  right: WorkflowRunSummary,
  field: string,
  direction: "asc" | "desc",
): number {
  const multiplier = direction === "asc" ? 1 : -1;
  const values: Record<string, [unknown, unknown]> = {
    started_at: [left.startedAt, right.startedAt],
    finished_at: [left.finishedAt, right.finishedAt],
    duration_ms: [left.durationMs ?? -1, right.durationMs ?? -1],
    title: [left.title, right.title],
    company: [left.company, right.company],
    status: [left.status, right.status],
    model: [left.model ?? "", right.model ?? ""],
    dry_run: [left.dryRun ? 1 : 0, right.dryRun ? 1 : 0],
  };
  const [leftValue, rightValue] = values[field] ?? values.started_at!;
  return compareValues(leftValue, rightValue) * multiplier;
}

function rowToWorkflowRunSummary(row: ApplyRunProjectionRow): WorkflowRunSummary {
  const runId = stringField(row.run_id);
  return {
    workflowId: runId,
    runId,
    jobKey: stringField(row.job_id),
    title: stringField(row.job_title) || "Untitled",
    company: stringField(row.job_employer) || "Unknown company",
    status: normalizeWorkflowRunStatus(row.status),
    result: nullableString(row.result),
    dryRun: Boolean(row.dry_run),
    model: nullableString(row.model),
    startedAt: nullableString(row.started_at),
    finishedAt: nullableString(row.finished_at),
    durationMs: nullableNumber(row.duration_ms),
  };
}

const WORKFLOW_RUN_STATUS_SET = new Set<string>(WORKFLOW_RUN_STATUSES);

function normalizeWorkflowRunStatus(value: unknown): WorkflowRunStatus {
  const raw = stringField(value);
  if (WORKFLOW_RUN_STATUS_SET.has(raw)) {
    return raw as WorkflowRunStatus;
  }
  // The legacy "finished" sentinel from earlier seeds → succeeded.
  if (raw === "finished") {
    return "succeeded";
  }
  // Unknown / "unknown" / blank → treat as in_progress so the row still renders.
  return "in_progress";
}

function recentApplyRuns(db: SqliteDatabase): DashboardSummary["applyRuns"] {
  // L3 (round-1 review): caller (``buildDashboardSummary``) already
  // refreshed projections; do not double-refresh here.
  const deletedJoin = tableExists(db, "jobhunter_deleted_jobs")
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = arp.job_id AND d.restored_at IS NULL"
    : "";
  const hiddenJoin = tableExists(db, "jobhunter_hidden_jobs")
    ? " LEFT JOIN jobhunter_hidden_jobs h ON h.job_url = arp.job_id AND h.unhidden_at IS NULL"
    : "";
  const deletedWhere = tableExists(db, "jobhunter_deleted_jobs") ? " AND d.job_url IS NULL" : "";
  const hiddenWhere = tableExists(db, "jobhunter_hidden_jobs") ? " AND h.job_url IS NULL" : "";
  const rows = allRows<ApplyRunProjectionRow>(
    db,
    `SELECT arp.* FROM apply_run_projections arp${deletedJoin}${hiddenJoin}
     WHERE arp.tenant_id = ?${deletedWhere}${hiddenWhere}
     ORDER BY arp.started_at DESC LIMIT 12`,
    [DEFAULT_TENANT],
  );
  return rows.map((row) => ({
    runId: row.run_id,
    jobKey: row.job_id,
    title: row.job_title || "Untitled",
    company: row.job_employer || "Unknown company",
    // Mirror listWorkflowRuns: ``apply_run_projections`` rows can carry
    // raw legacy strings ("finished", "submitted", etc.); normalize so
    // dashboard.applyRuns and /v1/workflow-runs agree on the same row.
    status: normalizeWorkflowRunStatus(row.status),
    dryRun: Boolean(row.dry_run),
    startedAt: row.started_at,
  }));
}

// ================================================================ helpers

function readJson(filePath: string, fallback: unknown): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function formatSize(size: number | null): string {
  if (size === null) return "missing file";
  if (size < 1024) return `${size}b`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}kb`;
  return `${(size / (1024 * 1024)).toFixed(1)}mb`;
}

function localFileSize(filePath: string): number | null {
  if (!filePath) return null;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined || left === "") return -1;
  if (right === null || right === undefined || right === "") return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
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

function stringField(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const stringValue = String(value);
  return stringValue ? stringValue : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function normalizeText(value: unknown, fallback: string): string {
  const text = stringField(value).trim();
  return text.length <= 160 ? text : fallback;
}

function normalizeInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numberValue = Number.parseInt(stringField(value), 10);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(maximum, Math.max(minimum, numberValue));
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}
