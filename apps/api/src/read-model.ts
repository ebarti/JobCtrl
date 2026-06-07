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
  ActivityEventSummary,
  ActivityListQuery,
  ActiveState,
  ArtifactDetail,
  ArtifactListQuery,
  ArtifactSummary,
  ArtifactTailoringExplanation,
  BulkJobMutationFilter,
  DashboardSettings,
  DashboardSummary,
  JobDeletedFilter,
  JobAuditEntry,
  JobDetail,
  JobListQuery,
  JobSummary,
  PaginatedResponse,
  PreparationSummary,
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
import { PIPELINE_RUN_STAGES, ProfileSchema, STAGES, WORKFLOW_RUN_STATUSES } from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import { normalizeJobLocation } from "./location-normalization.js";
import { refreshProjections } from "./projections.js";

const DEFAULT_TENANT = "local";
const CLOSED_ACTIVE_STATES = ["closed", "expired", "removed", "location_incompatible"] as const satisfies readonly ActiveState[];

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

function sqlRankCase(column: string, ranks: Record<string, number>, fallback: number): string {
  const arms = Object.entries(ranks)
    .map(([value, rank]) => `WHEN '${value}' THEN ${rank}`)
    .join(" ");
  return `(CASE ${column} ${arms} ELSE ${fallback} END)`;
}

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
  current_substage: string;
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
  active_state: string | null;
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
  metadata_json: string | null;
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
  current_stage: "LOWER(current_stage)",
  current_state: `(${sqlRankCase("current_state", STATE_RANK, 999)} || ':' || LOWER(COALESCE(current_substage, current_stage)))`,
};

const SQL_ACTIVITY_SORT_COLUMNS: Partial<Record<string, string>> = {
  occurred_at: "e.occurred_at",
  event_id: "e.event_id",
  stage: "LOWER(e.stage)",
  level: "LOWER(e.level)",
  event_type: "LOWER(event_type)",
  message: "LOWER(e.message)",
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
  const todayMetrics = dashboardTodayMetrics(db);
  return {
    ok: true,
    generatedAt: dashboard.generated_at || new Date().toISOString(),
    totals: {
      jobs: Number(dashboard.total_jobs ?? 0),
      jobsToday: todayMetrics.jobsToday,
      failures: Number(dashboard.failures ?? 0),
      blocked: Number(dashboard.blocked ?? 0),
      ready: Number(dashboard.ready ?? 0),
      applied: Number(dashboard.applied ?? 0),
      appliedToday: todayMetrics.appliedToday,
      dryRuns: Number(dashboard.dry_runs ?? 0),
    },
    funnel: parseFunnel(dashboard.funnel_json),
    activity: recentActivity(db),
    progress: listPipelineProgress(db),
    sourceHealth: listSourceHealth(db),
    operationalMetrics,
    applyRuns: recentApplyRuns(db),
    preparation: buildPreparationSummary(db, DEFAULT_TENANT),
  };
}

function localDateKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dashboardTodayMetrics(
  db: SqliteDatabase,
): Pick<DashboardSummary["totals"], "jobsToday" | "appliedToday"> {
  const activeFilter = jobSqlFilter(db, {
    page: 1,
    pageSize: 1,
    q: "",
    sort: "discovered_at",
    dir: "desc",
    deleted: "active",
    applyStatus: "all",
    source: "",
    company: "",
  });
  const rows = allRows<{ discovered_at: string | null; applied_at: string | null }>(
    db,
    `SELECT discovered_at, applied_at FROM job_list_projections${activeFilter.where}`,
    activeFilter.params,
  );
  const today = localDateKey(new Date());
  return {
    jobsToday: rows.filter((row) => localDateKey(row.discovered_at) === today).length,
    appliedToday: rows.filter((row) => localDateKey(row.applied_at) === today).length,
  };
}

function buildPreparationSummary(db: SqliteDatabase, tenantId: string): PreparationSummary {
  const currentScoringPolicyVersion = latestPolicyVersion(db, "scoring_policies", tenantId);
  const currentTailoringPolicyVersion = latestPolicyVersion(db, "tailoring_policies", tenantId);
  return {
    currentScoringPolicyVersion,
    currentTailoringPolicyVersion,
    outdatedScoreCount: countOutdatedScores(db, tenantId, currentScoringPolicyVersion),
    outdatedTailoredArtifactCount: countOutdatedTailoredArtifacts(db, tenantId, currentTailoringPolicyVersion),
    workItems: countPreparationWorkItems(db, tenantId),
  };
}

function latestPolicyVersion(
  db: SqliteDatabase,
  tableName: "scoring_policies" | "tailoring_policies",
  tenantId: string,
): number | null {
  if (!tableExists(db, tableName)) return null;
  const row = getRow<{ version: number | null }>(
    db,
    `SELECT MAX(version) AS version FROM ${tableName} WHERE tenant_id = ?`,
    [tenantId],
  );
  return nullableNumber(row?.version);
}

function countOutdatedScores(
  db: SqliteDatabase,
  tenantId: string,
  currentPolicyVersion: number | null,
): number {
  const activeJobs = activeJobUrlSet(db);
  if (activeJobs.size === 0) return 0;

  if (tableExists(db, "job_score_staleness")) {
    const rows = tableExists(db, "job_scores")
      ? allRows<{ job_url: string }>(
          db,
          `SELECT DISTINCT stale.job_url
             FROM job_score_staleness stale
             JOIN (
               SELECT job_url, MAX(version) AS max_version
               FROM job_scores
               WHERE tenant_id = ?
               GROUP BY job_url
             ) latest ON latest.job_url = stale.job_url
             JOIN job_scores s
               ON s.tenant_id = stale.tenant_id
              AND s.job_url = stale.job_url
              AND s.version = latest.max_version
            WHERE stale.tenant_id = ?
              AND stale.resolved = 0
              AND (s.correction_json IS NULL OR TRIM(s.correction_json) = '')`,
          [tenantId, tenantId],
        )
      : allRows<{ job_url: string }>(
          db,
          "SELECT DISTINCT job_url FROM job_score_staleness WHERE tenant_id = ? AND resolved = 0",
          [tenantId],
        );
    return rows.filter((row) => activeJobs.has(row.job_url)).length;
  }

  if (currentPolicyVersion === null || !tableExists(db, "job_scores")) return 0;
  const rows = allRows<{ job_url: string; trace_json: string | null; correction_json: string | null }>(
    db,
    `SELECT s.job_url, s.trace_json, s.correction_json
       FROM job_scores s
       JOIN (
         SELECT job_url, MAX(version) AS max_version
         FROM job_scores
         WHERE tenant_id = ?
         GROUP BY job_url
       ) latest ON latest.job_url = s.job_url AND latest.max_version = s.version
      WHERE s.tenant_id = ?`,
    [tenantId, tenantId],
  );
  return rows.filter((row) => {
    if (!activeJobs.has(row.job_url)) return false;
    if (row.correction_json?.trim()) return false;
    const policyVersion = policyVersionFromJson(row.trace_json, [
      "scoring_policy_version",
      "scoringPolicyVersion",
    ]);
    return policyVersion === null || policyVersion < currentPolicyVersion;
  }).length;
}

function countOutdatedTailoredArtifacts(
  db: SqliteDatabase,
  tenantId: string,
  currentPolicyVersion: number | null,
): number {
  if (
    currentPolicyVersion === null ||
    !tableExists(db, "job_materials") ||
    !tableExists(db, "job_materials_artifacts")
  ) {
    return 0;
  }
  const activeJobs = activeJobUrlSet(db);
  if (activeJobs.size === 0) return 0;
  const rows = allRows<{ job_url: string; metadata_json: string | null }>(
    db,
    `WITH latest AS (
       SELECT job_url, MAX(generation) AS max_generation
       FROM job_materials
       WHERE tenant_id = ?
       GROUP BY job_url
     )
     SELECT a.job_url, a.metadata_json
       FROM job_materials_artifacts a
       JOIN latest ON latest.job_url = a.job_url AND latest.max_generation = a.generation
      WHERE a.artifact_type = 'tailored_resume'
        AND a.status = 'approved'`,
    [tenantId],
  );
  return rows.filter((row) => {
    if (!activeJobs.has(row.job_url)) return false;
    const policyVersion = policyVersionFromJson(row.metadata_json, [
      "tailoring_policy_version",
      "tailoringPolicyVersion",
    ]);
    return policyVersion === null || policyVersion < currentPolicyVersion;
  }).length;
}

function countPreparationWorkItems(
  db: SqliteDatabase,
  tenantId: string,
): PreparationSummary["workItems"] {
  const counts: PreparationSummary["workItems"] = { queued: 0, running: 0, failed: 0 };
  if (!tableExists(db, "preparation_work_items")) return counts;
  const activeJobs = activeJobUrlSet(db);
  if (activeJobs.size === 0) return counts;
  const rows = allRows<{ job_id: string; state: string }>(
    db,
    `SELECT job_id, state
       FROM preparation_work_items
      WHERE tenant_id = ?
        AND state IN ('queued', 'running', 'failed')`,
    [tenantId],
  );
  for (const row of rows) {
    if (!activeJobs.has(row.job_id)) continue;
    if (row.state === "queued" || row.state === "running" || row.state === "failed") {
      counts[row.state] += 1;
    }
  }
  return counts;
}

function activeJobUrlSet(db: SqliteDatabase): Set<string> {
  if (!tableExists(db, "job_list_projections")) return new Set();
  const filter = jobSqlFilter(db, {
    page: 1,
    pageSize: 1,
    q: "",
    sort: "discovered_at",
    dir: "desc",
    deleted: "active",
    applyStatus: "all",
    source: "",
    company: "",
  });
  const rows = allRows<{ job_id: string }>(
    db,
    `SELECT job_id FROM job_list_projections${filter.where}`,
    filter.params,
  );
  return new Set(rows.map((row) => row.job_id).filter(Boolean));
}

function policyVersionFromJson(value: string | null, fields: readonly string[]): number | null {
  const parsed = parseJsonRecord(value);
  if (!parsed) return null;
  for (const field of fields) {
    const version = nullableNumber(parsed[field]);
    if (version !== null) return version;
  }
  return null;
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
  const stages = reconcileStageRetryability(db, listRow.job_id, parseStages(detailRow?.stages_json));
  const artifacts = artifactsForJob(db, listRow.job_id);
  const auditHistory = buildJobAuditHistory(db, listRow.job_id);
  return {
    ok: true,
    job: {
      ...rowToJobSummary(listRow),
      descriptionPreview: detailRow?.description_preview ?? "",
      scoreReasoning: detailRow?.score_reasoning ?? listRow.score_reasoning,
    },
    stages,
    artifacts,
    auditHistory,
  };
}

interface JobAuditEventRow extends Record<string, unknown> {
  event_id: number | string;
  event_type: string | null;
  job_url: string | null;
  stage: string | null;
  level: string | null;
  message: string | null;
  occurred_at: string | null;
  payload_json: string | null;
}

interface ApplicationReviewDecisionAuditRow extends Record<string, unknown> {
  decision_id: string;
  decision: string;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

interface ApplicationOutcomeAuditRow extends Record<string, unknown> {
  outcome_id: string;
  kind: string;
  source: string;
  note: string | null;
  occurred_at: string | null;
  recorded_at: string | null;
  suggestion_id: string | null;
  evidence_id: string | null;
}

interface OutcomeSuggestionAuditRow extends Record<string, unknown> {
  suggestion_id: string;
  suggested_kind: string;
  confidence: number | null;
  status: string;
  created_at: string | null;
  decided_at: string | null;
  decision: string | null;
  decision_reason: string | null;
  decided_outcome_id: string | null;
}

function buildJobAuditHistory(db: SqliteDatabase, jobId: string): JobAuditEntry[] {
  const entries: JobAuditEntry[] = [];
  const seenReferences = new Set<string>();

  if (tableExists(db, "job_events")) {
    const rows = allRows<JobAuditEventRow>(
      db,
      `SELECT event_id, event_type, job_url, stage, level, message, occurred_at, payload_json
         FROM job_events
        WHERE job_url = ?
           OR (
             payload_json IS NOT NULL
             AND json_valid(payload_json)
             AND (
               JSON_EXTRACT(payload_json, '$.jobId') = ?
               OR JSON_EXTRACT(payload_json, '$.job_id') = ?
               OR JSON_EXTRACT(payload_json, '$.jobKey') = ?
               OR JSON_EXTRACT(payload_json, '$.job_key') = ?
             )
           )
        ORDER BY occurred_at ASC, event_id ASC`,
      [jobId, jobId, jobId, jobId, jobId],
    );
    for (const row of rows) {
      const payload = parseJsonRecord(row.payload_json) ?? {};
      rememberAuditReferences(seenReferences, payload);
      const entry = jobEventToAuditEntry(row, payload);
      if (entry) entries.push(entry);
    }
  }

  appendReviewDecisionAuditEntries(db, jobId, entries, seenReferences);
  appendApplicationOutcomeAuditEntries(db, jobId, entries, seenReferences);
  appendOutcomeSuggestionAuditEntries(db, jobId, entries, seenReferences);

  entries.sort((left, right) => {
    const leftAt = left.occurredAt ?? "";
    const rightAt = right.occurredAt ?? "";
    if (leftAt !== rightAt) return leftAt.localeCompare(rightAt);
    return left.id.localeCompare(right.id);
  });
  return entries;
}

function rememberAuditReferences(seenReferences: Set<string>, payload: Record<string, unknown>): void {
  for (const [prefix, keys] of [
    ["review", ["decisionId", "decision_id"]],
    ["outcome", ["outcomeId", "outcome_id"]],
    ["suggestion", ["suggestionId", "suggestion_id"]],
  ] as const) {
    const id = payloadText(payload, ...keys);
    if (id) seenReferences.add(`${prefix}:${id}`);
  }
}

function appendReviewDecisionAuditEntries(
  db: SqliteDatabase,
  jobId: string,
  entries: JobAuditEntry[],
  seenReferences: Set<string>,
): void {
  if (!tableExists(db, "application_review_decisions")) return;
  const rows = allRows<ApplicationReviewDecisionAuditRow>(
    db,
    `SELECT decision_id, decision, reason, decided_by, decided_at
       FROM application_review_decisions
      WHERE tenant_id = ? AND job_key = ?
      ORDER BY decided_at ASC, decision_id ASC`,
    [DEFAULT_TENANT, jobId],
  );
  for (const row of rows) {
    if (seenReferences.has(`review:${row.decision_id}`)) continue;
    entries.push(
      makeAuditEntry({
        id: `review:${row.decision_id}`,
        category: "apply",
        tone: "info",
        title: "Apply review decision recorded",
        description: applyReviewDecisionDescription(row.decision),
        occurredAt: row.decided_at,
        actor: row.decided_by || "user",
        details: auditDetails(
          ["Decision", humanizeToken(row.decision)],
          ["Reason", row.reason ? "Provided" : ""],
        ),
      }),
    );
  }
}

function appendApplicationOutcomeAuditEntries(
  db: SqliteDatabase,
  jobId: string,
  entries: JobAuditEntry[],
  seenReferences: Set<string>,
): void {
  if (!tableExists(db, "application_outcomes")) return;
  const rows = allRows<ApplicationOutcomeAuditRow>(
    db,
    `SELECT outcome_id, kind, source, note, occurred_at, recorded_at, suggestion_id, evidence_id
       FROM application_outcomes
      WHERE tenant_id = ? AND job_key = ?
      ORDER BY occurred_at ASC, recorded_at ASC, outcome_id ASC`,
    [DEFAULT_TENANT, jobId],
  );
  for (const row of rows) {
    if (seenReferences.has(`outcome:${row.outcome_id}`)) continue;
    entries.push(
      makeAuditEntry({
        id: `outcome:${row.outcome_id}`,
        category: "outcome",
        tone: outcomeTone(row.kind),
        title: "Application outcome recorded",
        description: `Outcome: ${humanizeToken(row.kind)}.`,
        occurredAt: row.occurred_at ?? row.recorded_at,
        actor: row.source === "manual" ? "user" : row.source,
        details: auditDetails(
          ["Outcome", humanizeToken(row.kind)],
          ["Source", humanizeToken(row.source)],
          ["Suggestion", row.suggestion_id],
          ["Evidence", row.evidence_id],
          ["Note", row.note ? "Provided" : ""],
        ),
      }),
    );
  }
}

function appendOutcomeSuggestionAuditEntries(
  db: SqliteDatabase,
  jobId: string,
  entries: JobAuditEntry[],
  seenReferences: Set<string>,
): void {
  if (!tableExists(db, "application_outcome_suggestions")) return;
  const rows = allRows<OutcomeSuggestionAuditRow>(
    db,
    `SELECT suggestion_id, suggested_kind, confidence, status, created_at, decided_at,
            decision, decision_reason, decided_outcome_id
       FROM application_outcome_suggestions
      WHERE tenant_id = ? AND job_key = ?
      ORDER BY created_at ASC, suggestion_id ASC`,
    [DEFAULT_TENANT, jobId],
  );
  for (const row of rows) {
    if (seenReferences.has(`suggestion:${row.suggestion_id}`)) continue;
    entries.push(
      makeAuditEntry({
        id: `suggestion:${row.suggestion_id}`,
        category: "outcome",
        tone: row.status === "pending" ? "warning" : "info",
        title: row.status === "pending" ? "Application outcome suggested" : "Outcome suggestion decided",
        description:
          row.status === "pending"
            ? `Suggested outcome: ${humanizeToken(row.suggested_kind)}.`
            : `Suggestion ${humanizeToken(row.status)}.`,
        occurredAt: row.decided_at ?? row.created_at,
        actor: "system",
        details: auditDetails(
          ["Suggested outcome", humanizeToken(row.suggested_kind)],
          ["Confidence", formatPercent(row.confidence)],
          ["Decision", humanizeToken(row.decision)],
          ["Reason", row.decision_reason ? "Provided" : ""],
          ["Outcome", row.decided_outcome_id],
        ),
      }),
    );
  }
}

function jobEventToAuditEntry(
  row: JobAuditEventRow,
  payload: Record<string, unknown>,
): JobAuditEntry | null {
  const eventId = stringField(row.event_id);
  const stage = payloadText(payload, "stage") || stringField(row.stage);
  const base = {
    id: `event:${eventId}`,
    occurredAt: stringField(row.occurred_at) || null,
  };

  switch (row.event_type) {
    case "JobDiscovered":
      return makeAuditEntry({
        ...base,
        category: "discovery",
        tone: "success",
        title: "Job discovered",
        description: `Found via ${payloadText(payload, "source") || "a configured source"}.`,
        actor: "system",
        details: auditDetails(
          ["Source", payloadText(payload, "source")],
          ["Employer", payloadText(payload, "employer")],
          ["Posting URL", payloadText(payload, "postingUrl", "posting_url")],
        ),
      });
    case "JobSourceObserved":
      return makeAuditEntry({
        ...base,
        category: "discovery",
        tone: "info",
        title: "Source observed the job",
        description: `Seen in ${payloadText(payload, "sourceId", "source_id") || "a source run"}.`,
        actor: "system",
        details: auditDetails(
          ["Source", payloadText(payload, "sourceId", "source_id")],
          ["Observed URL", payloadText(payload, "observedUrl", "observed_url")],
          ["Run", payloadText(payload, "runId", "run_id")],
        ),
      });
    case "CanonicalJobIdentityResolved":
      return makeAuditEntry({
        ...base,
        category: "discovery",
        tone: "info",
        title: "Canonical posting resolved",
        description: "The posting was linked to its canonical ATS identity.",
        actor: "system",
        details: auditDetails(
          ["ATS", humanizeToken(payloadText(payload, "atsKind", "ats_kind"))],
          ["Canonical URL", payloadText(payload, "canonicalUrl", "canonical_url")],
          ["Confidence", formatPercent(payloadNumber(payload, "confidence"))],
        ),
      });
    case "DuplicateJobLinked":
      return makeAuditEntry({
        ...base,
        category: "discovery",
        tone: "muted",
        title: "Duplicate linked",
        description: "A duplicate observation was linked to this job.",
        actor: "system",
        details: auditDetails(
          ["Reason", humanizeToken(payloadText(payload, "reason"))],
          ["Confidence", formatPercent(payloadNumber(payload, "confidence"))],
        ),
      });
    case "DuplicateJobLinkRejected":
      return makeAuditEntry({
        ...base,
        category: "discovery",
        tone: "info",
        title: "Duplicate link rejected",
        description: "A possible duplicate was reviewed and kept separate.",
        actor: "system",
        details: auditDetails(
          ["Reason", humanizeToken(payloadText(payload, "reason"))],
          ["Confidence", formatPercent(payloadNumber(payload, "confidence"))],
          ["Candidate", payloadText(payload, "candidateJobId", "candidate_job_id")],
        ),
      });
    case "DiscoveryFeedbackRecorded":
      return makeAuditEntry({
        ...base,
        category: "discovery",
        tone: "info",
        title: "Discovery feedback recorded",
        description: `Feedback marked this job as ${humanizeToken(payloadText(payload, "kind"))}.`,
        actor: "user",
        details: auditDetails(
          ["Feedback", humanizeToken(payloadText(payload, "kind"))],
          ["Source", payloadText(payload, "sourceId", "source_id")],
        ),
      });
    case "JobUpdated":
    case "JobMetadataUpdated":
      return makeAuditEntry({
        ...base,
        category: "job",
        tone: "info",
        title: row.event_type === "JobMetadataUpdated" ? "Job metadata refreshed" : "Job details updated",
        description:
          row.event_type === "JobMetadataUpdated"
            ? "Stored job metadata was refreshed from its source."
            : "Stored job metadata changed.",
        actor: "system",
        details: auditDetails(
          ["Changed fields", changedFieldList(payload)],
          ["Source", payloadText(payload, "source")],
        ),
      });
    case "JobDeleted":
      return makeAuditEntry({
        ...base,
        category: "job",
        tone: "warning",
        title: "Job deleted",
        description: "The job was removed from active lists.",
        actor: "user",
        details: auditDetails(["Reason", humanizeToken(payloadText(payload, "reason"))]),
      });
    case "JobRestored":
      return makeAuditEntry({
        ...base,
        category: "job",
        tone: "success",
        title: "Job restored",
        description: "The job was restored to active lists.",
        actor: "user",
        details: [],
      });
    case "JobHidden":
      return makeAuditEntry({
        ...base,
        category: "job",
        tone: "muted",
        title: "Job hidden",
        description: "The job was hidden from active views.",
        actor: "user",
        details: auditDetails(["Reason", humanizeToken(payloadText(payload, "reason"))]),
      });
    case "JobUnhidden":
      return makeAuditEntry({
        ...base,
        category: "job",
        tone: "success",
        title: "Job unhidden",
        description: "The job was restored from hidden views.",
        actor: "user",
        details: [],
      });
    case "JobEnriched":
      return makeAuditEntry({
        ...base,
        category: "enrichment",
        tone: "success",
        title: "Posting enriched",
        description: "Full posting details were captured.",
        actor: "system",
        details: auditDetails(
          ["Extraction tier", humanizeToken(payloadText(payload, "extractionTier", "extraction_tier"))],
          ["Application URL", payloadText(payload, "applicationUrl", "application_url")],
        ),
      });
    case "EnrichmentFailed":
      return makeAuditEntry({
        ...base,
        category: "enrichment",
        tone: "danger",
        title: "Enrichment failed",
        description: safeAuditText(payloadText(payload, "error")) || "Posting enrichment failed.",
        actor: "system",
        details: auditDetails(["Attempt", payloadText(payload, "attemptNumber", "attempt_number")]),
      });
    case "PostingContentSnapshotCaptured":
      return makeAuditEntry({
        ...base,
        category: "enrichment",
        tone: "success",
        title: "Content snapshot captured",
        description: "A posting content snapshot was stored for future comparisons.",
        actor: "system",
        details: auditDetails(
          ["Source", payloadText(payload, "sourceId", "source_id")],
          ["Version", payloadText(payload, "snapshotVersion", "snapshot_version")],
          ["Extraction tier", humanizeToken(payloadText(payload, "extractionTier", "extraction_tier"))],
        ),
      });
    case "PostingContentSnapshotFailed":
      return makeAuditEntry({
        ...base,
        category: "enrichment",
        tone: "warning",
        title: "Content snapshot failed",
        description: "The system could not capture a posting content snapshot.",
        actor: "system",
        details: auditDetails(
          ["Source", payloadText(payload, "sourceId", "source_id")],
          ["Failure", humanizeToken(payloadText(payload, "errorClass", "error_class"))],
          ["Retryable", yesNo(payloadBoolean(payload, "retryable"))],
          ["Active state", humanizeToken(payloadText(payload, "activeState", "active_state"))],
          ["Verification", humanizeToken(payloadText(payload, "verificationMethod", "verification_method"))],
          ["HTTP status", payloadText(payload, "httpStatus", "http_status")],
          ["Extraction tier", payloadText(payload, "tier", "extractionTier", "extraction_tier")],
          ["Description chars", payloadText(payload, "descriptionChars", "description_chars")],
          ["Apply URL found", yesNo(payloadBoolean(payload, "applicationUrlFound", "application_url_found"))],
        ),
      });
    case "JobActiveStateChanged":
      return makeAuditEntry({
        ...base,
        category: "enrichment",
        tone: payloadText(payload, "activeState", "active_state") === "active" ? "success" : "warning",
        title: "Posting availability changed",
        description: `Availability is ${humanizeToken(payloadText(payload, "activeState", "active_state"))}.`,
        actor: "system",
        details: auditDetails(
          ["Previous", humanizeToken(payloadText(payload, "previousState", "previous_state"))],
          ["Current", humanizeToken(payloadText(payload, "activeState", "active_state"))],
          ["Verification", humanizeToken(payloadText(payload, "verificationMethod", "verification_method"))],
        ),
      });
    case "ContentDuplicateCandidateDetected":
      return makeAuditEntry({
        ...base,
        category: "enrichment",
        tone: "warning",
        title: "Possible content duplicate detected",
        description: "The posting content looked similar to another job.",
        actor: "system",
        details: auditDetails(
          ["Candidate", payloadText(payload, "candidateJobId", "candidate_job_id")],
          ["Confidence", formatPercent(payloadNumber(payload, "confidence"))],
        ),
      });
    case "JobScored":
      return makeAuditEntry({
        ...base,
        category: "scoring",
        tone: scoreTone(payloadNumber(payload, "fitScore", "fit_score")),
        title: "Job scored",
        description: `Fit score ${payloadText(payload, "fitScore", "fit_score") || "recorded"}.`,
        actor: "system",
        details: auditDetails(
          ["Fit score", payloadText(payload, "fitScore", "fit_score")],
          ["Fit band", humanizeToken(payloadText(payload, "fitBand", "fit_band"))],
          ["Confidence", humanizeToken(payloadText(payload, "confidence"))],
          ["Eligibility", eligibilityStatus(payload)],
          ["Keywords", payloadList(payload, "keywords").join(", ")],
        ),
      });
    case "ScoreCorrected":
      return makeAuditEntry({
        ...base,
        category: "scoring",
        tone: "info",
        title: "Score corrected",
        description: `Fit score changed from ${payloadText(payload, "originalScore", "original_score")} to ${payloadText(payload, "correctedScore", "corrected_score")}.`,
        actor: "user",
        details: auditDetails(
          ["Original", payloadText(payload, "originalScore", "original_score")],
          ["Corrected", payloadText(payload, "correctedScore", "corrected_score")],
          ["Reason", safeAuditText(payloadText(payload, "reason"))],
        ),
      });
    case "ScoreMarkedStale":
      return makeAuditEntry({
        ...base,
        category: "scoring",
        tone: "warning",
        title: "Score marked stale",
        description: "The score needs review because the scoring policy changed.",
        actor: "system",
        details: auditDetails(
          ["Reason", humanizeToken(payloadText(payload, "staleReason", "stale_reason"))],
          ["Old policy", payloadText(payload, "oldPolicyVersion", "old_policy_version")],
          ["New policy", payloadText(payload, "newPolicyVersion", "new_policy_version")],
        ),
      });
    case "ScoreRescoreRequested":
      return makeAuditEntry({
        ...base,
        category: "scoring",
        tone: "warning",
        title: "Rescore requested",
        description: "The score was marked stale and queued for rescoring.",
        actor: "system",
        details: auditDetails(
          ["Reason", humanizeToken(payloadText(payload, "staleReason", "stale_reason"))],
          ["Old policy", payloadText(payload, "oldPolicyVersion", "old_policy_version")],
          ["New policy", payloadText(payload, "newPolicyVersion", "new_policy_version")],
        ),
      });
    case "ResumeApproved":
      return makeAuditEntry({
        ...base,
        category: "materials",
        tone: "success",
        title: "Resume approved",
        description: "A tailored resume became apply-ready.",
        actor: "system",
        details: auditDetails(
          ["Artifact", payloadText(payload, "artifactId", "artifact_id")],
          ["Generation", payloadText(payload, "generation")],
        ),
      });
    case "ResumeFailed":
      return makeAuditEntry({
        ...base,
        category: "materials",
        tone: "danger",
        title: "Resume generation failed",
        description: "The tailored resume did not pass validation.",
        actor: "system",
        details: auditDetails(
          ["Attempt", payloadText(payload, "attemptNumber", "attempt_number")],
          ["Validation", payloadList(payload, "validationErrors", "validation_errors").join(", ")],
        ),
      });
    case "CoverLetterGenerated":
      return makeAuditEntry({
        ...base,
        category: "materials",
        tone: "success",
        title: "Cover letter generated",
        description: "A tailored cover letter was created.",
        actor: "system",
        details: auditDetails(["Artifact", payloadText(payload, "artifactId", "artifact_id")]),
      });
    case "PdfRendered":
      return makeAuditEntry({
        ...base,
        category: "materials",
        tone: "success",
        title: "PDF rendered",
        description: `${humanizeToken(payloadText(payload, "artifactType", "artifact_type")) || "Material"} PDF was rendered.`,
        actor: "system",
        details: auditDetails(["Artifact", payloadText(payload, "artifactId", "artifact_id")]),
      });
    case "MaterialsExhausted":
      return makeAuditEntry({
        ...base,
        category: "materials",
        tone: "warning",
        title: "Materials attempts exhausted",
        description: "The material generation retry limit was reached.",
        actor: "system",
        details: auditDetails(
          ["Stage", humanizeToken(payloadText(payload, "stage"))],
          ["Attempts", `${payloadText(payload, "attemptCount", "attempt_count")}/${payloadText(payload, "maxAttempts", "max_attempts")}`],
        ),
      });
    case "TailorRetailorRequested":
      return makeAuditEntry({
        ...base,
        category: "materials",
        tone: "info",
        title: "Re-tailoring requested",
        description: "Resume tailoring was requested for this job.",
        actor: requestActor(payloadText(payload, "requestKind", "request_kind")),
        details: auditDetails(
          ["Request", humanizeToken(payloadText(payload, "requestKind", "request_kind"))],
          ["Reason", safeAuditText(payloadText(payload, "reason"))],
          ["Current policy", payloadText(payload, "currentPolicyVersion", "current_policy_version")],
        ),
      });
    case "TailorRequested":
      return makeAuditEntry({
        ...base,
        category: "materials",
        tone: "info",
        title: "Tailoring requested",
        description: "Resume tailoring was manually requested for this job.",
        actor: "user",
        details: auditDetails(
          ["Reason", safeAuditText(payloadText(payload, "reason"))],
          ["Low-fit override", payloadBoolean(payload, "allowLowFitOverride", "allow_low_fit_override") ? "yes" : null],
        ),
      });
    case "RetailorRequested":
      return makeAuditEntry({
        ...base,
        category: "materials",
        tone: "info",
        title: "Re-tailoring requested",
        description: "Current-policy resume re-tailoring was requested for this job.",
        actor: "user",
        details: auditDetails(
          ["Reason", safeAuditText(payloadText(payload, "reason"))],
          ["Suppress existing artifacts", payloadBoolean(payload, "suppressExistingArtifacts", "suppress_existing_artifacts") ? "yes" : "no"],
        ),
      });
    case "TailoredArtifactsSuppressed":
      return makeAuditEntry({
        ...base,
        category: "materials",
        tone: "warning",
        title: "Artifacts retained for audit",
        description: "Previously active materials were suppressed and kept as historical audit material.",
        actor: "system",
        details: auditDetails(
          ["Reason", humanizeToken(payloadText(payload, "suppressionReason", "suppression_reason"))],
          ["Artifacts", payloadList(payload, "artifactIds", "artifact_ids").join(", ")],
          ["Fit score", payloadText(payload, "currentFitScore", "current_fit_score")],
          ["Threshold", payloadText(payload, "scoreThreshold", "score_threshold")],
        ),
      });
    case "StageStarted":
      return stageAuditEntry(base, "info", stage, payload, "Stage started", "Work started for this stage.");
    case "StageCompleted":
      return stageAuditEntry(base, "success", stage, payload, "Stage completed", "Work completed for this stage.");
    case "StageFailed":
      return stageAuditEntry(
        base,
        "danger",
        stage,
        payload,
        "Stage failed",
        safeAuditText(payloadText(payload, "errorMessage", "error_message")) || "This stage failed.",
      );
    case "StageExhausted":
      return stageAuditEntry(base, "warning", stage, payload, "Stage exhausted", "Retry attempts were exhausted.");
    case "StageReset":
      return stageAuditEntry(base, "info", stage, payload, "Stage reset", "This stage was reset for another run.");
    case "StageBlocked":
      return stageAuditEntry(base, "warning", stage, payload, "Stage blocked", "This stage is blocked by prerequisites.");
    case "StageSkipped":
      return stageAuditEntry(
        base,
        "muted",
        stage,
        payload,
        "Stage skipped",
        safeAuditText(payloadText(payload, "reason")) || "This stage was skipped.",
      );
    case "StageCanceled":
      return stageAuditEntry(
        base,
        "warning",
        stage,
        payload,
        "Stage canceled",
        safeAuditText(payloadText(payload, "reason")) || "This stage was canceled.",
      );
    case "PreparationWorkItemQueued":
    case "PreparationWorkItemStarted":
    case "PreparationWorkItemCompleted":
    case "PreparationWorkItemFailed":
      return preparationWorkItemAuditEntry(base, row.event_type, payload);
    case "ApplyRunStarted":
      return makeAuditEntry({
        ...base,
        category: "apply",
        tone: payloadBoolean(payload, "dryRun", "dry_run") ? "info" : "warning",
        title: payloadBoolean(payload, "dryRun", "dry_run") ? "Dry-run apply started" : "Apply run started",
        description: payloadBoolean(payload, "dryRun", "dry_run")
          ? "A dry-run application attempt started."
          : "An application submission attempt started.",
        actor: "system",
        details: auditDetails(
          ["Run", payloadText(payload, "runId", "run_id")],
          ["Model", payloadText(payload, "model")],
          ["Dry run", yesNo(payloadBoolean(payload, "dryRun", "dry_run"))],
        ),
      });
    case "ApplicationSubmitted":
      return makeAuditEntry({
        ...base,
        category: "apply",
        tone: "success",
        title: "Application submitted",
        description: "The application was marked submitted.",
        actor: "system",
        details: auditDetails(
          ["Run", payloadText(payload, "runId", "run_id")],
          ["Confidence", formatPercent(payloadNumber(payload, "verificationConfidence", "verification_confidence"))],
        ),
      });
    case "ApplicationManuallyMarked":
      return makeAuditEntry({
        ...base,
        category: "apply",
        tone: "success",
        title: "Application marked applied",
        description: "The job was manually marked as applied.",
        actor: "user",
        details: auditDetails(["Reason", safeAuditText(payloadText(payload, "reason"))]),
      });
    case "ApplicationFailed":
      return makeAuditEntry({
        ...base,
        category: "apply",
        tone: "danger",
        title: "Application attempt failed",
        description: "The apply run did not complete successfully.",
        actor: "system",
        details: auditDetails(
          ["Run", payloadText(payload, "runId", "run_id")],
          ["Attempt", payloadText(payload, "attemptNumber", "attempt_number")],
        ),
      });
    case "ApplicationEmailFeedbackIngested":
      return makeAuditEntry({
        ...base,
        category: "outcome",
        tone: "info",
        title: "Application email feedback ingested",
        description: `Suggested outcome: ${humanizeToken(payloadText(payload, "suggestedKind", "suggested_kind"))}.`,
        actor: "system",
        details: auditDetails(
          ["Provider", humanizeToken(payloadText(payload, "provider"))],
          ["Classification confidence", formatPercent(payloadNumber(payload, "classificationConfidence", "classification_confidence"))],
          ["Link confidence", formatPercent(payloadNumber(payload, "linkConfidence", "link_confidence"))],
        ),
      });
    case "ApplyReviewDecisionRecorded":
      return makeAuditEntry({
        ...base,
        category: "apply",
        tone: "info",
        title: "Apply review decision recorded",
        description: applyReviewDecisionDescription(payloadText(payload, "decision")),
        actor: "user",
        details: auditDetails(
          ["Decision", humanizeToken(payloadText(payload, "decision"))],
          ["Reason", payloadBoolean(payload, "reasonPresent", "reason_present") ? "Provided" : ""],
        ),
      });
    case "ApplicationOutcomeRecorded":
      return makeAuditEntry({
        ...base,
        category: "outcome",
        tone: outcomeTone(payloadText(payload, "kind")),
        title: "Application outcome recorded",
        description: `Outcome: ${humanizeToken(payloadText(payload, "kind"))}.`,
        actor: payloadText(payload, "source") === "manual" ? "user" : payloadText(payload, "source"),
        details: auditDetails(
          ["Outcome", humanizeToken(payloadText(payload, "kind"))],
          ["Source", humanizeToken(payloadText(payload, "source"))],
          ["Evidence", payloadText(payload, "evidenceId", "evidence_id")],
          ["Note", payloadBoolean(payload, "notePresent", "note_present") ? "Provided" : ""],
        ),
      });
    case "OutcomeSuggestionDecided":
      return makeAuditEntry({
        ...base,
        category: "outcome",
        tone: "info",
        title: "Outcome suggestion decided",
        description: `Suggestion ${humanizeToken(payloadText(payload, "decision"))}.`,
        actor: "user",
        details: auditDetails(
          ["Decision", humanizeToken(payloadText(payload, "decision"))],
          ["Outcome", payloadText(payload, "outcomeId", "outcome_id")],
          ["Reason", payloadBoolean(payload, "reasonPresent", "reason_present") ? "Provided" : ""],
        ),
      });
    case "ActionStarted":
      return legacyActionAuditEntry(base, "info", stage, payload, "Action started", "A local job action started.");
    case "ActionSucceeded":
      return legacyActionAuditEntry(base, "success", stage, payload, "Action completed", "A local job action completed.");
    case "ActionFailed":
      return legacyActionAuditEntry(
        base,
        "danger",
        stage,
        payload,
        "Action failed",
        safeAuditText(payloadText(payload, "error")) || "A local job action failed.",
      );
    default:
      return null;
  }
}

function legacyActionAuditEntry(
  base: Pick<JobAuditEntry, "id" | "occurredAt">,
  tone: JobAuditEntry["tone"],
  stage: string,
  payload: Record<string, unknown>,
  title: string,
  description: string,
): JobAuditEntry {
  return makeAuditEntry({
    ...base,
    category: "pipeline",
    tone,
    title: `${title}: ${stageLabel(stage)}`,
    description,
    actor: "system",
    details: auditDetails(
      ["Stage", stageLabel(stage)],
      ["Action", payloadText(payload, "action_id", "actionId")],
      ["Duration", durationLabel(payloadNumber(payload, "duration_ms", "durationMs"))],
      ["Dry run", yesNo(payloadBoolean(payload, "dry_run", "dryRun"))],
    ),
  });
}

function stageAuditEntry(
  base: Pick<JobAuditEntry, "id" | "occurredAt">,
  tone: JobAuditEntry["tone"],
  stage: string,
  payload: Record<string, unknown>,
  title: string,
  description: string,
): JobAuditEntry {
  return makeAuditEntry({
    ...base,
    category: "pipeline",
    tone,
    title: `${title}: ${stageLabel(stage)}`,
    description,
    actor: "system",
    details: auditDetails(
      ["Stage", stageLabel(stage)],
      ["Attempt", payloadText(payload, "attemptNumber", "attempt_number")],
      ["Duration", durationLabel(payloadNumber(payload, "durationMs", "duration_ms"))],
      ["Blocked by", payloadList(payload, "blockedBy", "blocked_by").map(stageLabel).join(", ")],
      ["Retryable", yesNo(payloadBoolean(payload, "retryable"))],
      ["Active state", humanizeToken(payloadText(payload, "activeState", "active_state"))],
      ["Verification", humanizeToken(payloadText(payload, "verificationMethod", "verification_method"))],
      ["HTTP status", payloadText(payload, "httpStatus", "http_status")],
      ["Extraction tier", payloadText(payload, "tier", "extractionTier", "extraction_tier")],
      ["Description chars", payloadText(payload, "descriptionChars", "description_chars")],
      ["Apply URL found", yesNo(payloadBoolean(payload, "applicationUrlFound", "application_url_found"))],
    ),
  });
}

function preparationWorkItemAuditEntry(
  base: Pick<JobAuditEntry, "id" | "occurredAt">,
  eventType: string,
  payload: Record<string, unknown>,
): JobAuditEntry {
  const kind = payloadText(payload, "kind");
  const status =
    eventType === "PreparationWorkItemQueued"
      ? "queued"
      : eventType === "PreparationWorkItemStarted"
        ? "started"
        : eventType === "PreparationWorkItemCompleted"
          ? "completed"
          : "failed";
  return makeAuditEntry({
    ...base,
    category: "pipeline",
    tone: status === "failed" ? "danger" : status === "completed" ? "success" : "info",
    title: `Preparation ${status}: ${preparationKindLabel(kind)}`,
    description:
      status === "failed"
        ? safeAuditText(payloadText(payload, "error", "errorMessage", "error_message")) ||
          "Preparation work failed."
        : "Preparation work moved through the queue.",
    actor: "system",
    details: auditDetails(
      ["Work item", preparationKindLabel(kind)],
      ["Attempt", payloadText(payload, "attemptNumber", "attempt_number")],
      ["Reason", humanizeToken(payloadText(payload, "reason"))],
    ),
  });
}

function makeAuditEntry(entry: JobAuditEntry): JobAuditEntry {
  return {
    ...entry,
    title: safeAuditText(entry.title, 120) || "Activity recorded",
    description: entry.description ? safeAuditText(entry.description, 220) : null,
    actor: entry.actor ? safeAuditText(entry.actor, 80) : null,
    details: entry.details.slice(0, 8),
  };
}

function auditDetails(
  ...items: Array<readonly [label: string, value: unknown]>
): JobAuditEntry["details"] {
  return items.flatMap(([label, value]) => {
    const safeValue = safeAuditText(value);
    return safeValue ? [{ label, value: safeValue }] : [];
  });
}

function safeAuditText(value: unknown, maxLength = 180): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return safeAuditText(value.map((item) => safeAuditText(item, 60)).filter(Boolean).join(", "), maxLength);
  }
  if (typeof value === "object") return "";
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (!normalized || normalized === "null" || normalized === "undefined") return "";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function payloadText(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    const text = safeAuditText(value);
    if (text) return text;
  }
  return "";
}

function payloadNumber(payload: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = nullableNumber(payload[key]);
    if (value !== null) return value;
  }
  return null;
}

function payloadBoolean(payload: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes"].includes(normalized)) return true;
      if (["false", "0", "no"].includes(normalized)) return false;
    }
  }
  return null;
}

function payloadList(payload: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.map((item) => safeAuditText(item, 80)).filter(Boolean);
    }
  }
  return [];
}

function changedFieldList(payload: Record<string, unknown>): string {
  const changedFields = payload.changedFields ?? payload.changed_fields;
  if (!isRecord(changedFields)) return "";
  return Object.keys(changedFields).map(humanizeToken).join(", ");
}

function eligibilityStatus(payload: Record<string, unknown>): string {
  const eligibility = payload.eligibility;
  if (!isRecord(eligibility)) return "";
  return humanizeToken(safeAuditText(eligibility.status));
}

function applyReviewDecisionDescription(decision: string): string {
  switch (decision) {
    case "approve_submit":
      return "Human review approved a real application submission.";
    case "approve_dry_run":
      return "Human review approved a dry-run application.";
    case "defer":
      return "Human review deferred this application.";
    case "decline":
      return "Human review declined this application.";
    case "reset":
      return "Human review reset the application decision.";
    default:
      return "Human review recorded an application decision.";
  }
}

function outcomeTone(kind: unknown): JobAuditEntry["tone"] {
  const normalized = safeAuditText(kind).toLowerCase();
  if (["offer", "interview", "assessment", "recruiter_reply", "applied_confirmation"].includes(normalized)) {
    return "success";
  }
  if (["rejection", "bounced", "withdrawn"].includes(normalized)) return "warning";
  return "info";
}

function scoreTone(score: number | null): JobAuditEntry["tone"] {
  if (score === null) return "info";
  if (score >= 8) return "success";
  if (score >= 6) return "info";
  return "warning";
}

function requestActor(kind: string): string {
  return kind === "single_job" || kind === "repair" ? "user" : "system";
}

function stageLabel(stage: string): string {
  const normalized = stage.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "discover") return "Discover";
  if (normalized === "enrich") return "Enrich";
  if (normalized === "score") return "Score";
  if (normalized === "tailor") return "Tailor resume";
  if (normalized === "cover") return "Cover letter";
  if (normalized === "apply") return "Apply";
  return humanizeToken(stage);
}

function preparationKindLabel(kind: string): string {
  switch (kind) {
    case "score_job":
      return "Score job";
    case "tailor_resume":
      return "Tailor resume";
    case "suppress_tailored_artifacts":
      return "Suppress old materials";
    default:
      return humanizeToken(kind) || "Preparation work";
  }
}

function humanizeToken(value: unknown): string {
  const text = safeAuditText(value);
  if (!text) return "";
  return text
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatPercent(value: number | null): string {
  if (value === null) return "";
  const percent = value <= 1 ? value * 100 : value;
  return `${Math.round(percent)}%`;
}

function durationLabel(value: number | null): string {
  if (value === null) return "";
  if (value < 1000) return `${value} ms`;
  return `${Math.round(value / 1000)} s`;
}

function yesNo(value: boolean | null): string {
  if (value === null) return "";
  return value ? "Yes" : "No";
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
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = ap.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
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
    if (!query.status && isSuppressedArtifactStatus(artifact.status)) return false;
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

export function listActivity(
  db: SqliteDatabase,
  query: ActivityListQuery,
): PaginatedResponse<ActivityEventSummary> {
  refreshProjections(db, DEFAULT_TENANT);
  return listActivityFromEvents(db, query);
}

export function getActivityEvent(db: SqliteDatabase, eventId: string): ActivityEventSummary | null {
  refreshProjections(db, DEFAULT_TENANT);
  return getActivityEventFromEvents(db, eventId);
}

export function getArtifactDetail(db: SqliteDatabase, artifactId: string): ArtifactDetail | null {
  refreshProjections(db, DEFAULT_TENANT);
  const row = getRow<ArtifactProjectionRow>(
    db,
    "SELECT * FROM artifact_list_projections WHERE artifact_id = ?",
    [artifactId],
  );
  if (!row) return null;
  return {
    ok: true,
    artifact: rowToArtifactSummary(row),
    tailoringExplanation: tailoringExplanationForArtifact(db, row),
  };
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
    currentSubstage: (isStage(row.current_substage) ? row.current_substage : row.current_stage) as Stage,
    currentState: (isStageState(row.current_state) ? row.current_state : "pending") as StageState,
    errorCode: row.current_error_code,
    errorMessage: row.current_error_message,
    nextAction: row.current_next_action,
    artifactCount: Number(row.artifact_count ?? 0),
    applyStatus: row.apply_status,
    appliedAt: row.applied_at,
    activeState: isActiveState(row.active_state) ? row.active_state : "unknown",
    deletedAt: row.deleted_at,
    hiddenAt: row.hidden_at,
  };
}

function isActiveState(value: unknown): value is ActiveState {
  return (
    value === "unknown" ||
    value === "active" ||
    value === "closed" ||
    value === "expired" ||
    value === "removed" ||
    value === "location_incompatible"
  );
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

const TAILORING_ARTIFACT_TYPES = new Set([
  "tailored_resume",
  "tailored_resume_txt",
  "resume_pdf",
  "tailored_resume_pdf",
]);
const TAILORING_PDF_ARTIFACT_TYPES = new Set(["resume_pdf", "tailored_resume_pdf"]);
const KEYWORD_TOKEN_RE = /[a-z0-9][a-z0-9+#./-]*/gi;
const DISPLAY_METRIC_CLAIM_RE =
  /^(?:\$\s?\d+(?:[,.]\d+)*(?:\.\d+)?\s?(?:k|m|b|million|billion)?|\d+(?:\.\d+)?%|\d+(?:\.\d+)?x|\d+(?:\.\d+)?\s?(?:ms|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|qps|req\/s))$/i;
const LOW_SIGNAL_KEYWORDS = new Set([
  "about",
  "across",
  "believe",
  "chain",
  "clinic",
  "company",
  "cool",
  "deserves",
  "everyone",
  "expert",
  "fast",
  "growth",
  "head",
  "health",
  "innovator",
  "join",
  "largest",
  "leading",
  "love",
  "office",
  "ortho",
  "rapid",
  "smile",
  "team",
  "teams",
  "tech",
  "they",
  "worldwide",
]);
const HIGH_SIGNAL_SINGLE_KEYWORDS = new Set([
  "architecture",
  "automation",
  "aws",
  "azure",
  "backend",
  "cloud",
  "ci/cd",
  "cicd",
  "cost",
  "developer",
  "devops",
  "docker",
  "gcp",
  "incident",
  "infrastructure",
  "java",
  "javascript",
  "kafka",
  "kubernetes",
  "leadership",
  "node",
  "node.js",
  "observability",
  "optimization",
  "platform",
  "postgres",
  "postgresql",
  "productivity",
  "python",
  "react",
  "redis",
  "reliability",
  "resiliency",
  "scalability",
  "security",
  "sre",
  "terraform",
  "typescript",
]);

function tailoringExplanationForArtifact(
  db: SqliteDatabase,
  row: ArtifactProjectionRow,
): ArtifactTailoringExplanation | null {
  if (!TAILORING_ARTIFACT_TYPES.has(row.artifact_type)) return null;

  const direct = parseTailoringExplanation(row.metadata_json);
  if (direct) return direct;
  if (!TAILORING_PDF_ARTIFACT_TYPES.has(row.artifact_type)) return null;

  const sibling = getRow<{ metadata_json: string | null }>(
    db,
    `SELECT metadata_json
       FROM artifact_list_projections
      WHERE tenant_id = ?
        AND job_id = ?
        AND artifact_type IN ('tailored_resume', 'tailored_resume_txt')
        AND metadata_json IS NOT NULL
        AND TRIM(metadata_json) != ''
        AND (? IS NULL OR generation = ? OR generation IS NULL)
      ORDER BY CASE WHEN generation = ? THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1`,
    [row.tenant_id, row.job_id, row.generation, row.generation, row.generation],
  );
  return parseTailoringExplanation(sibling?.metadata_json ?? null);
}

function parseTailoringExplanation(value: string | null): ArtifactTailoringExplanation | null {
  const metadata = parseJsonRecord(value);
  if (!metadata) return null;

  const qualityPlan = metadataRecord(metadata.quality_plan);
  const qualityChecks = metadataRecord(metadata.quality_checks);
  const keywordCoverage = metadataRecord(qualityChecks.keyword_coverage);
  const evidenceSupport = metadataRecord(qualityChecks.evidence_support);
  const judge = metadataRecord(metadata.judge);
  const adversarialReview = parseAdversarialReview(metadata.adversarial_review);
  const reviewFeedback = metadataRecord(metadata.review_feedback);
  const judgeMinScore = metadataNumber(metadata.judge_min_score);

  const explanation: ArtifactTailoringExplanation = {
    targetSeniority: metadataText(qualityPlan.target_seniority),
    claimMode: metadataText(qualityPlan.claim_mode),
    validationMode: metadataText(metadata.validation_mode),
    safety: {
      autoApprovableClaimModes: metadataTextList(qualityPlan.auto_approvable_claim_modes),
      allowAdjacentAchievementDrafts: metadataBoolean(qualityPlan.allow_adjacent_achievement_drafts),
      qualityPassed: metadataBoolean(qualityChecks.passed),
    },
    keywords: {
      planned: metadataKeywordList(qualityPlan.job_keywords, 16),
      covered: metadataKeywordList(keywordCoverage.covered, 16),
      missing: metadataKeywordList(keywordCoverage.missing, 16),
    },
    evidence: {
      requiredIds: metadataTextList(qualityPlan.required_evidence_ids, 32),
      seniorityIds: metadataTextList(qualityPlan.seniority_evidence_ids, 32),
      representedIds: metadataTextList(evidenceSupport.represented_ids, 32),
      missingIds: metadataTextList(evidenceSupport.missing_ids, 32),
      verifiedMetricCount: metadataNumber(qualityPlan.verified_metric_count),
    },
    quality: {
      passed: metadataBoolean(qualityChecks.passed),
      errors: metadataTextList(qualityChecks.errors, 8, 220),
      warnings: metadataTextList(qualityChecks.warnings, 8, 220),
      notes: metadataTextList(qualityChecks.notes, 8, 220),
      metricClaims: metadataMetricClaims(qualityChecks.metric_claims),
      repeatedKeywords: metadataRepeatedKeywords(qualityChecks.repeated_keywords),
    },
    judge: {
      passed: metadataBoolean(judge.passed),
      verdict: metadataText(judge.verdict),
      score: metadataNumber(judge.score),
      minScore: judgeMinScore,
      issues: metadataTextList(judge.issues, 8, 220),
      unsupportedClaims: metadataTextList(judge.unsupported_claims, 8, 220),
      fabrications: metadataTextList(judge.fabrications, 8, 220),
      missingRequiredEvidence: metadataTextList(judge.missing_required_evidence, 8, 220),
      repairInstructions: metadataTextList(judge.repair_instructions, 8, 220),
    },
    adversarialReview,
    reviewFeedback: {
      warningRepairAttempted: metadataBoolean(reviewFeedback.warning_retry_attempted),
      acceptedWithResidualWarnings: metadataBoolean(reviewFeedback.accepted_with_residual_warnings),
      acceptedWarnings: metadataTextList(reviewFeedback.accepted_warning_notes, 8, 220),
    },
    models: {
      candidateModels: metadataTextList(metadata.candidate_models, 6, 120),
      selectedModel: metadataText(metadata.selected_model, 120),
      selectedCandidate: metadataText(metadata.selected_candidate, 80),
      judgeModel: metadataText(metadata.judge_model, 120),
      attempts: metadataNumber(metadata.attempts),
    },
  };

  return hasTailoringExplanationContent(explanation) ? explanation : null;
}

function parseAdversarialReview(
  value: unknown,
): ArtifactTailoringExplanation["adversarialReview"] {
  const review = metadataRecord(value);
  const ran = metadataBoolean(review.ran);
  if (ran === null) return null;
  return {
    ran,
    passed: metadataBoolean(review.passed),
    score: metadataNumber(review.score),
    threshold: metadataNumber(review.threshold),
    blockers: metadataTextList(review.blockers, 8, 220),
    warnings: metadataTextList(review.warnings, 8, 220),
    repairInstructions: metadataTextList(review.repair_instructions, 8, 220),
    personas: Array.isArray(review.personas)
      ? review.personas.filter(isRecord).slice(0, 8).map((persona) => ({
          persona: metadataText(persona.persona, 80) ?? "reviewer",
          verdict: metadataText(persona.verdict, 20),
          score: metadataNumber(persona.score),
        }))
      : [],
    skippedReason: metadataText(review.skipped_reason, 180),
  };
}

function hasTailoringExplanationContent(explanation: ArtifactTailoringExplanation): boolean {
  return Boolean(
    explanation.targetSeniority ||
      explanation.claimMode ||
      explanation.validationMode ||
      explanation.safety.autoApprovableClaimModes.length ||
      explanation.safety.allowAdjacentAchievementDrafts !== null ||
      explanation.safety.qualityPassed !== null ||
      explanation.keywords.planned.length ||
      explanation.keywords.covered.length ||
      explanation.keywords.missing.length ||
      explanation.evidence.requiredIds.length ||
      explanation.evidence.seniorityIds.length ||
      explanation.evidence.representedIds.length ||
      explanation.evidence.missingIds.length ||
      explanation.evidence.verifiedMetricCount !== null ||
      explanation.quality.passed !== null ||
      explanation.quality.errors.length ||
      explanation.quality.warnings.length ||
      explanation.quality.notes.length ||
      explanation.quality.metricClaims.length ||
      explanation.quality.repeatedKeywords.length ||
      explanation.judge.passed !== null ||
      explanation.judge.verdict ||
      explanation.judge.score !== null ||
      explanation.judge.minScore !== null ||
      explanation.judge.issues.length ||
      explanation.judge.unsupportedClaims.length ||
      explanation.judge.fabrications.length ||
      explanation.judge.missingRequiredEvidence.length ||
      explanation.judge.repairInstructions.length ||
      explanation.adversarialReview ||
      explanation.reviewFeedback.warningRepairAttempted !== null ||
      explanation.reviewFeedback.acceptedWithResidualWarnings !== null ||
      explanation.reviewFeedback.acceptedWarnings.length ||
      explanation.models.candidateModels.length ||
      explanation.models.selectedModel ||
      explanation.models.selectedCandidate ||
      explanation.models.judgeModel ||
      explanation.models.attempts !== null,
  );
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function metadataText(value: unknown, maxLength = 120): string | null {
  const text = safeAuditText(value, maxLength);
  if (!text || /(?:api[_-]?key|password|secret|token|bearer\s+)/i.test(text) || text.includes("://")) {
    return null;
  }
  return text;
}

function metadataTextList(value: unknown, limit = 12, maxLength = 120): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const text = metadataText(raw, maxLength);
    const key = text?.toLowerCase();
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function metadataKeywordList(value: unknown, limit = 12, maxLength = 120): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const text = metadataText(raw, maxLength);
    const key = normalizedKeywordKey(text);
    if (!text || !key || !isMeaningfulDisplayKeyword(text, key) || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizedKeywordKey(value: string | null): string | null {
  if (!value) return null;
  const tokens = value.toLowerCase().match(KEYWORD_TOKEN_RE) ?? [];
  return tokens.length ? tokens.join(" ") : null;
}

function isMeaningfulDisplayKeyword(text: string, normalized: string): boolean {
  const tokens = normalized.split(" ").filter(Boolean);
  if (!tokens.length || tokens.length > 4) return false;
  if (tokens.every((token) => LOW_SIGNAL_KEYWORDS.has(token) || /^\d+$/.test(token))) {
    return false;
  }
  if (tokens.length > 1) {
    return tokens.some((token) => !LOW_SIGNAL_KEYWORDS.has(token) && !/^\d+$/.test(token));
  }
  const token = tokens[0]!;
  if (LOW_SIGNAL_KEYWORDS.has(token) || /^\d+$/.test(token)) return false;
  return HIGH_SIGNAL_SINGLE_KEYWORDS.has(token) || /[+#./-]/.test(text);
}

function metadataMetricClaims(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const text = metadataText(raw, 80);
    if (!text || !DISPLAY_METRIC_CLAIM_RE.test(text)) continue;
    const key = text.toLowerCase().replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 8) break;
  }
  return out;
}

function metadataRepeatedKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const keyword = isRecord(raw)
      ? metadataText(raw.keyword ?? raw.term ?? raw.value, 80)
      : metadataText(raw, 80);
    if (!keyword) continue;
    const count = isRecord(raw) ? metadataNumber(raw.count) : null;
    const text = count !== null && count > 0 ? `${keyword} (${count})` : keyword;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 8) break;
  }
  return out;
}

function metadataBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === "false") return false;
  if (value === 1 || value === "true") return true;
  return null;
}

function metadataNumber(value: unknown): number | null {
  return nullableNumber(value);
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
  if (localPath && sizeBytes === null && !isSuppressedArtifactStatus(status)) {
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
  return PIPELINE_RUN_STAGES.map(
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
  return PIPELINE_RUN_STAGES.map((stage) => ({
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

function reconcileStageRetryability(
  db: SqliteDatabase,
  jobId: string,
  stages: StageSummary[],
): StageSummary[] {
  const retryability = latestStageRetryabilityByEvent(db, jobId);
  if (retryability.size === 0) return stages;
  return stages.map((stage) => {
    if (!["failed", "exhausted"].includes(stage.state)) return stage;
    if (stage.stage === "enrich") return { ...stage, retryable: true };
    if (retryability.get(stage.stage) !== false) return stage;
    return { ...stage, retryable: false, nextAction: null };
  });
}

function latestStageRetryabilityByEvent(db: SqliteDatabase, jobId: string): Map<Stage, boolean> {
  if (!tableExists(db, "job_events")) return new Map();
  const rows = allRows<{ stage: string | null; payload_json: string | null }>(
    db,
    `SELECT stage, payload_json
     FROM job_events
     WHERE job_url = ?
       AND stage IS NOT NULL
       AND payload_json IS NOT NULL
     ORDER BY event_id ASC`,
    [jobId],
  );
  const retryability = new Map<Stage, boolean>();
  for (const row of rows) {
    if (!isStage(row.stage)) continue;
    const payload = parseJsonRecord(row.payload_json);
    const retryable = payload?.["retryable"];
    if (typeof retryable === "boolean") {
      retryability.set(row.stage, retryable);
    }
  }
  return retryability;
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
  return rows.map(rowToArtifactSummary).filter((artifact) => !isSuppressedArtifactStatus(artifact.status));
}

function isSuppressedArtifactStatus(status: string | null | undefined): boolean {
  return String(status ?? "").toLowerCase() === "suppressed";
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
    applyStatus: filter.applyStatus ?? "all",
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
  const closedPredicate = closedActiveStatePredicate(
    db,
    "job_list_projections.tenant_id",
    "job_list_projections.job_id",
  );
  if (query.deleted === "active") {
    clauses.push("deleted_at IS NULL");
    if (hasHiddenTable) {
      clauses.push("NOT EXISTS (SELECT 1 FROM jobhunter_hidden_jobs h WHERE h.job_url = job_id AND h.unhidden_at IS NULL)");
    }
    if (closedPredicate) {
      clauses.push(`NOT (${closedPredicate.sql})`);
      params.push(...closedPredicate.params);
    }
  } else if (query.deleted === "closed") {
    clauses.push("deleted_at IS NULL");
    if (hasHiddenTable) {
      clauses.push("NOT EXISTS (SELECT 1 FROM jobhunter_hidden_jobs h WHERE h.job_url = job_id AND h.unhidden_at IS NULL)");
    }
    if (closedPredicate) {
      clauses.push(closedPredicate.sql);
      params.push(...closedPredicate.params);
    } else {
      clauses.push("1 = 0");
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
  if (query.applyStatus === "applied") {
    clauses.push("(applied_at IS NOT NULL OR LOWER(COALESCE(apply_status, '')) = 'applied')");
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

function closedActiveStatePredicate(
  db: SqliteDatabase,
  tenantColumn: string,
  jobColumn: string,
): { sql: string; params: SqliteValue[] } | null {
  if (!tableExists(db, "posting_snapshot_sets")) {
    return null;
  }
  const placeholders = CLOSED_ACTIVE_STATES.map(() => "?").join(", ");
  return {
    sql: `EXISTS (
      SELECT 1
      FROM posting_snapshot_sets pss
      WHERE pss.tenant_id = ${tenantColumn}
        AND pss.job_url = ${jobColumn}
        AND pss.latest_active_state IN (${placeholders})
    )`,
    params: [...CLOSED_ACTIVE_STATES],
  };
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
  const activeStateSelect = tableExists(db, "posting_snapshot_sets")
    ? `(SELECT pss.latest_active_state
          FROM posting_snapshot_sets pss
         WHERE pss.tenant_id = job_list_projections.tenant_id
           AND pss.job_url = job_list_projections.job_id
         LIMIT 1) AS active_state`
    : "'unknown' AS active_state";
  return `job_list_projections.*,
          ${discoverySourceSqlExpression(db)} AS discovery_source,
          ${postingSourceUrlSqlExpression(db)} AS posting_source_url,
          ${postingSourceAtsKindSqlExpression(db)} AS posting_source_ats_kind,
          ${activeStateSelect},
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
    applyStatus: query.applyStatus,
    minFitScore: query.minFitScore ?? null,
    maxFitScore: query.maxFitScore ?? null,
    deleted: query.deleted,
  };
}

function countJobProjections(
  db: SqliteDatabase,
  filter: { where: string; params: SqliteValue[] },
): number {
  const row = getRow<{ count: number }>(db, `SELECT COUNT(*) AS count FROM job_list_projections${filter.where}`, filter.params);
  return Number(row?.count ?? 0);
}

function countRows(db: SqliteDatabase, sql: string, params: SqliteValue[]): number {
  const row = getRow<{ count: number }>(db, sql, params);
  return Number(row?.count ?? 0);
}

function filterJob(job: JobSummary, query: JobListQuery, normalizedQuery: string): boolean {
  if (query.stage && job.currentStage !== query.stage) return false;
  if (query.state && job.currentState !== query.state) return false;
  if (
    query.applyStatus === "applied"
    && !job.appliedAt
    && job.applyStatus?.toLowerCase() !== "applied"
  ) {
    return false;
  }
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
    job.currentSubstage,
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
    current_state: [
      `${STATE_RANK[left.currentState] ?? 999}:${left.currentSubstage}`,
      `${STATE_RANK[right.currentState] ?? 999}:${right.currentSubstage}`,
    ],
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
  return listActivityFromEvents(db, {
    page: 1,
    pageSize: 50,
    sort: "occurred_at",
    dir: "desc",
    q: "",
    level: "",
    stage: "",
    eventType: "",
  }).items;
}

function listPipelineProgress(db: SqliteDatabase): DashboardSummary["progress"] {
  if (!tableExists(db, "job_events")) {
    return [];
  }
  const rows = allRows<{
    stage: string | null;
    event_type: string | null;
    message: string | null;
    occurred_at: string | null;
    payload_json: string | null;
  }>(
    db,
    `SELECT stage, event_type, message, occurred_at, payload_json
       FROM job_events
      WHERE COALESCE(job_url, '') IN ('', 'pipeline')
        AND (
          event_type IN ('StageStarted', 'StageCompleted', 'StageFailed')
          OR (
            payload_json IS NOT NULL
            AND json_valid(payload_json)
            AND (
              JSON_EXTRACT(payload_json, '$.progress') IS NOT NULL
              OR JSON_EXTRACT(payload_json, '$.progressTotal') IS NOT NULL
            )
          )
        )
        AND (
          stage IN ('discover', 'enrich', 'score', 'tailor', 'cover', 'apply')
          OR (
            payload_json IS NOT NULL
            AND json_valid(payload_json)
            AND JSON_EXTRACT(payload_json, '$.stage') IN ('discover', 'enrich', 'score', 'tailor', 'cover', 'apply')
          )
        )
      ORDER BY event_id DESC
      LIMIT 100`,
  );
  const byStage = new Map<Stage, DashboardSummary["progress"][number]>();
  for (const row of rows) {
    const payload = parseJsonRecord(row.payload_json);
    const stage = isStage(row.stage)
      ? row.stage
      : isStage(payload?.stage)
        ? payload.stage
        : null;
    if (!stage || byStage.has(stage)) {
      continue;
    }
    const progress = parseProgressPayload(payload, { ...row, stage });
    if (progress) {
      byStage.set(stage, progress);
    }
  }
  return [...byStage.values()];
}

const COMPLETE_STAGE_MESSAGES = new Set(["stage ok", "stage partial", "stage skipped"]);
const DISCOVERY_SOURCE_PROGRESS = [
  ["jobspy", "JobSpy"],
  ["ats_api", "Canonical ATS APIs"],
  ["workday", "Workday scraper"],
  ["smartextract", "Smart extract"],
] as const;

function parseProgressPayload(
  payload: Record<string, unknown> | null,
  row: {
    stage: string | null;
    event_type: string | null;
    message: string | null;
    occurred_at: string | null;
  },
): DashboardSummary["progress"][number] | null {
  if (!payload || !isStage(row.stage)) {
    return parseFallbackProgressPayload(row);
  }
  const source = isRecord(payload.progress) ? payload.progress : payload;
  const completed = nullableNumber(source.completed ?? source.progressCompleted);
  const total = nullableNumber(source.total ?? source.progressTotal);
  if (completed === null || total === null || total <= 0) {
    return parseFallbackProgressPayload(row, source.status ?? source.progressStatus);
  }
  const rawPercent = nullableNumber(source.percent ?? source.progressPercent);
  const basePercent = rawPercent === null
    ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
    : Math.max(0, Math.min(100, Math.round(rawPercent)));
  const runId = stringField(source.runId ?? source.run_id ?? payload.runId ?? payload.run_id);
  const workflowId = stringField(
    source.workflowId
      ?? source.workflow_id
      ?? payload.workflowId
      ?? payload.workflow_id,
  );
  const sourceDetail = progressSourceDetail(source);
  return {
    stage: row.stage,
    status: progressStatus(source.status ?? source.progressStatus, row.event_type),
    ...(runId ? { runId } : {}),
    ...(workflowId ? { workflowId } : {}),
    percent: progressPercentWithSource(basePercent, sourceDetail.sourceProgress),
    completed,
    total,
    currentStep: nullableString(source.currentStep ?? source.current_step),
    message: stringField(source.message) || stringField(row.message),
    ...sourceDetail,
    updatedAt: nullableString(row.occurred_at),
  };
}

function progressPercentWithSource(
  percent: number,
  sourceProgress: DashboardSummary["progress"][number]["sourceProgress"],
): number {
  if (percent !== 0 || !sourceProgress) {
    return percent;
  }
  return sourceProgress.completed > 0 && sourceProgress.total > 0 ? 1 : percent;
}

function progressSourceDetail(source: Record<string, unknown>): Pick<DashboardSummary["progress"][number], "sourceProgress"> {
  const detail = isRecord(source.sourceProgress)
    ? source.sourceProgress
    : isRecord(source.source_progress)
      ? source.source_progress
      : null;
  if (!detail) {
    return {};
  }
  const completed = nullableNumber(detail.completed ?? detail.sourceCompleted);
  const total = nullableNumber(detail.total ?? detail.sourceTotal);
  if (completed === null || total === null || total <= 0) {
    return {};
  }
  return {
    sourceProgress: {
      completed,
      total,
      unit: nullableString(detail.unit),
      currentQuery: nullableString(detail.currentQuery ?? detail.current_query),
      currentLocation: nullableString(detail.currentLocation ?? detail.current_location),
      newJobs: nullableNumber(detail.newJobs ?? detail.new_jobs),
      existingJobs: nullableNumber(detail.existingJobs ?? detail.existing_jobs),
      filteredJobs: nullableNumber(detail.filteredJobs ?? detail.filtered_jobs),
      errorCount: nullableNumber(detail.errorCount ?? detail.error_count ?? detail.errors),
      rawTotal: nullableNumber(detail.rawTotal ?? detail.raw_total),
    },
  };
}

function parseFallbackProgressPayload(
  row: {
    stage: string | null;
    event_type: string | null;
    message: string | null;
    occurred_at: string | null;
  },
  statusValue: unknown = null,
): DashboardSummary["progress"][number] | null {
  if (!isStage(row.stage)) {
    return null;
  }
  const status = progressStatus(statusValue, row.event_type);
  const message = stringField(row.message);
  const discoverySourceProgress = row.stage === "discover"
    ? parseDiscoverySourceProgress(row, status, message)
    : null;
  if (discoverySourceProgress) {
    return discoverySourceProgress;
  }
  const normalizedMessage = message.replace(row.stage, "").trim().toLowerCase();
  const isWholeStageCompletion =
    row.event_type === "StageCompleted" && COMPLETE_STAGE_MESSAGES.has(normalizedMessage);
  if (row.event_type === "StageCompleted" && !isWholeStageCompletion) {
    return null;
  }
  const completedStage = row.event_type === "StageCompleted" && (status === "succeeded" || status === "partial");
  const percent = completedStage ? 100 : status === "failed" ? 0 : 0;
  const fallbackMessage = normalizedMessage === "stage partial"
    ? "Stage completed with warnings"
    : normalizedMessage === "stage ok"
      ? "Stage complete"
      : normalizedMessage === "stage skipped"
        ? "Stage skipped"
        : message || (completedStage ? "Stage complete" : status === "failed" ? "Stage failed" : "Stage started");
  return {
    stage: row.stage,
    status,
    percent,
    completed: completedStage ? 1 : 0,
    total: 1,
    currentStep: null,
    message: fallbackMessage,
    updatedAt: nullableString(row.occurred_at),
  };
}

function parseDiscoverySourceProgress(
  row: {
    stage: string | null;
    event_type: string | null;
    message: string | null;
    occurred_at: string | null;
  },
  status: DashboardSummary["progress"][number]["status"],
  message: string,
): DashboardSummary["progress"][number] | null {
  const lowerMessage = message.toLowerCase();
  const sourceIndex = DISCOVERY_SOURCE_PROGRESS.findIndex(([source]) =>
    lowerMessage.includes(`discovery source ${source}`),
  );
  if (sourceIndex < 0) {
    return null;
  }
  const sourceProgress = DISCOVERY_SOURCE_PROGRESS[sourceIndex];
  if (!sourceProgress) {
    return null;
  }
  const started = row.event_type === "StageStarted";
  const completed = Math.max(0, sourceIndex + (started ? 0 : 1));
  const total = DISCOVERY_SOURCE_PROGRESS.length + 1;
  return {
    stage: "discover",
    status: status === "failed" ? "failed" : "running",
    percent: Math.max(0, Math.min(100, Math.round((completed / total) * 100))),
    completed,
    total,
    currentStep: sourceProgress[1],
    message,
    updatedAt: nullableString(row.occurred_at),
  };
}

function progressStatus(value: unknown, eventType: string | null): DashboardSummary["progress"][number]["status"] {
  if (value === "succeeded" || value === "failed" || value === "running" || value === "partial") {
    return value;
  }
  if (eventType === "StageFailed") {
    return "failed";
  }
  if (eventType === "StageCompleted") {
    return "succeeded";
  }
  return "running";
}

function listActivityFromEvents(
  db: SqliteDatabase,
  query: ActivityListQuery,
): PaginatedResponse<ActivityEventSummary> {
  if (!tableExists(db, "job_events")) {
    return paginateWithTotal([], 0, 1, query.pageSize, query.sort, query.dir, activityFilterPayload(query));
  }
  const eventColumns = columnNames(db, "job_events");
  const eventTypeSelect = eventColumns.has("event_type") ? "e.event_type" : "'Event' AS event_type";
  const eventTypePredicate = eventColumns.has("event_type") ? "COALESCE(e.event_type, '')" : "'Event'";
  const hideDeletedJoin = tableExists(db, "jobhunter_deleted_jobs")
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = e.job_url AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
    : "";
  const hideHiddenJoin = tableExists(db, "jobhunter_hidden_jobs")
    ? " LEFT JOIN jobhunter_hidden_jobs h ON h.job_url = e.job_url AND h.unhidden_at IS NULL"
    : "";
  const activityClauses = [
    "(e.job_url IS NULL OR e.job_url = '' OR jp.job_id IS NOT NULL)",
    tableExists(db, "jobhunter_deleted_jobs") ? "d.job_url IS NULL" : "",
    tableExists(db, "jobhunter_hidden_jobs") ? "h.job_url IS NULL" : "",
  ].filter(Boolean);
  const params: SqliteValue[] = [DEFAULT_TENANT];
  if (query.level) {
    activityClauses.push("LOWER(COALESCE(e.level, '')) = LOWER(?)");
    params.push(query.level);
  }
  if (query.stage) {
    activityClauses.push("LOWER(COALESCE(e.stage, '')) = LOWER(?)");
    params.push(query.stage);
  }
  if (query.eventType) {
    activityClauses.push(`LOWER(${eventTypePredicate}) = LOWER(?)`);
    params.push(query.eventType);
  }
  const normalizedQuery = query.q.trim();
  if (normalizedQuery) {
    const search = `%${normalizedQuery.toLowerCase()}%`;
    activityClauses.push(`(
      LOWER(COALESCE(e.level, '')) LIKE ?
      OR LOWER(COALESCE(e.stage, '')) LIKE ?
      OR LOWER(${eventTypePredicate}) LIKE ?
      OR LOWER(COALESCE(e.message, '')) LIKE ?
      OR LOWER(COALESCE(jp.title, '')) LIKE ?
      OR LOWER(COALESCE(jp.employer, '')) LIKE ?
      OR LOWER(COALESCE(e.job_url, '')) LIKE ?
      OR LOWER(CAST(e.event_id AS TEXT)) LIKE ?
      OR LOWER(COALESCE(e.occurred_at, '')) LIKE ?
    )`);
    params.push(search, search, search, search, search, search, search, search, search);
  }
  const activityWhere = `WHERE ${activityClauses.join(" AND ")}`;
  const fromSql = `
    FROM job_events e
    LEFT JOIN job_list_projections jp ON jp.tenant_id = ? AND jp.job_id = e.job_url
    ${hideDeletedJoin}
    ${hideHiddenJoin}
    ${activityWhere}`;
  const total = countRows(db, `SELECT COUNT(*) AS count ${fromSql}`, params);
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, pages);
  const offset = (page - 1) * query.pageSize;
  const direction = query.dir === "asc" ? "ASC" : "DESC";
  const sortColumn = SQL_ACTIVITY_SORT_COLUMNS[query.sort] ?? "e.occurred_at";
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
    ${fromSql}
    ORDER BY ${sortColumn} ${direction}, e.event_id ${direction}
    LIMIT ? OFFSET ?`;
  const items = allRows<Record<string, unknown>>(db, sql, [
    ...params,
    query.pageSize,
    offset,
  ]).map(activityRowToSummary);
  return paginateWithTotal(
    items,
    total,
    page,
    query.pageSize,
    query.sort,
    query.dir,
    activityFilterPayload(query),
  );
}

function getActivityEventFromEvents(db: SqliteDatabase, eventId: string): ActivityEventSummary | null {
  if (!tableExists(db, "job_events")) return null;
  const eventColumns = columnNames(db, "job_events");
  const eventTypeSelect = eventColumns.has("event_type") ? "e.event_type" : "'Event' AS event_type";
  const hideDeletedJoin = tableExists(db, "jobhunter_deleted_jobs")
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = e.job_url AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
    : "";
  const hideHiddenJoin = tableExists(db, "jobhunter_hidden_jobs")
    ? " LEFT JOIN jobhunter_hidden_jobs h ON h.job_url = e.job_url AND h.unhidden_at IS NULL"
    : "";
  const activityClauses = [
    "e.event_id = ?",
    "(e.job_url IS NULL OR e.job_url = '' OR jp.job_id IS NOT NULL)",
    tableExists(db, "jobhunter_deleted_jobs") ? "d.job_url IS NULL" : "",
    tableExists(db, "jobhunter_hidden_jobs") ? "h.job_url IS NULL" : "",
  ].filter(Boolean);
  const row = getRow<Record<string, unknown>>(
    db,
    `SELECT
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
     WHERE ${activityClauses.join(" AND ")}
     LIMIT 1`,
    [DEFAULT_TENANT, eventId],
  );
  return row ? activityRowToSummary(row) : null;
}

function activityFilterPayload(query: ActivityListQuery): Record<string, unknown> {
  return {
    q: query.q,
    level: query.level,
    stage: query.stage,
    eventType: query.eventType,
  };
}

function activityRowToSummary(row: Record<string, unknown>): ActivityEventSummary {
  return {
    eventId: stringField(row.event_id),
    eventType: stringField(row.event_type) || "Event",
    jobKey: nullableString(row.job_url),
    title: nullableString(row.title),
    company: nullableString(row.employer),
    stage: stringField(row.stage) || "system",
    level: stringField(row.level) || "info",
    message: stringField(row.message) || "event",
    at: nullableString(row.occurred_at),
  };
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
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = arp.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
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
    ? " LEFT JOIN jobhunter_deleted_jobs d ON d.job_url = arp.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
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
    events: parseApplyRunTimelineEvents(row.events_json),
  }));
}

function parseApplyRunTimelineEvents(value: string | null): DashboardSummary["applyRuns"][number]["events"] {
  let parsed: unknown = [];
  try {
    parsed = value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecord).map((event) => {
    const type = stringField(event.event_type ?? event.eventType ?? event.type) || "event";
    const at = nullableString(event.occurred_at ?? event.occurredAt ?? event.at);
    const level = stringField(event.level) || "info";
    const message = nullableString(event.message);
    return { at, type, level, message };
  });
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
