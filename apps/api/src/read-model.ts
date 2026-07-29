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
  ApplyReviewQueueResponse,
  BulletCoverageAudit,
  BulletProvenanceEntry,
  BulkJobMutationFilter,
  DashboardConversionFunnel,
  DashboardSummary,
  DigestAcknowledgeResponse,
  DailyDigest,
  DigestState,
  EvidenceGap,
  EvidenceMapEntry,
  EvidenceMapResponse,
  EmployerAnalysis,
  JobCompensationAudit,
  JobCompensationSummary,
  JobDeletedFilter,
  JobAuditEntry,
  JobDetail,
  InterviewPrep,
  JobListQuery,
  JobSummary,
  OutcomeAnalyticsSummary,
  PaginatedResponse,
  PreparationSummary,
  ProfileShape,
  RequirementFitReport,
  ScoreBreakdown,
  SettingsResponse,
  Stage,
  StageState,
  StageSummary,
  VoicePassAudit,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowRunTimelineEvent,
  WorkflowRunsListQuery,
} from "./contracts.js";
import {
  DIGEST_DAY_BOUNDARY,
  DIGEST_FOLLOW_UP_THRESHOLD_DAYS,
  PIPELINE_RUN_STAGES,
  ProfileSchema,
  STAGES,
  WORKFLOW_RUN_STATUSES,
} from "./contracts.js";
import { buildApplyAudit, type ApplyAuditLatestRun } from "./apply-audit.js";
import { evaluateRepeatApplication } from "./repeat-application.js";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import { emptyPolitenessOutcomes, politenessOutcomesBySource } from "./source-politeness.js";
import type { SourcePolitenessOutcomes } from "@jobctrl/contracts";
import { normalizeJobLocation } from "./location-normalization.js";
import { refreshProjections } from "./projections.js";
import {
  resumeTemplateStateForArtifact,
  resumeTemplateStateForJob,
} from "./resume-templates.js";
import { readWorkerHealth } from "./worker-health.js";
import { readJobCtrlSettings } from "./settings-config.js";

const DEFAULT_TENANT = "local";
const DEFAULT_PROFILE_ID = "default";
const CLOSED_ACTIVE_STATES = ["closed", "expired", "removed", "location_incompatible"] as const satisfies readonly ActiveState[];
// Dashboard presentation policy: only old running rows are candidates for
// "stuck", and only while the worker itself is unavailable. The threshold is
// exposed in the response so the UI can state the exact rule.
const DASHBOARD_STUCK_AFTER_SECONDS = 150;
const DASHBOARD_STUCK_ITEM_LIMIT = 8;

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
  needs_verification: 2,
  blocked: 3,
  running: 4,
  queued: 5,
  pending: 6,
  stale: 7,
  canceled: 8,
  skipped: 9,
  succeeded: 10,
};

function sqlRankCase(column: string, ranks: Record<string, number>, fallback: number): string {
  const arms = Object.entries(ranks)
    .map(([value, rank]) => `WHEN '${value}' THEN ${rank}`)
    .join(" ");
  return `(CASE ${column} ${arms} ELSE ${fallback} END)`;
}

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
  compensation_summary_json: string | null;
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
  compensation_summary_json: string | null;
  compensation_audit_json: string | null;
  score_breakdown_json: string | null;
  score_keywords_json: string;
  score_reasoning: string;
  score_version: number | null;
  scored_at: string | null;
  score_criteria_json: string | null;
  score_trace_json: string | null;
  score_correction_json: string | null;
  stages_json: string;
  employer_analysis_json: string | null;
  requirement_fit_report_json: string | null;
  interview_prep_json: string | null;
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
  layout_boxes_json: string | null;
  bullet_provenance_json: string | null;
  coverage_audit_json: string | null;
  voice_pass_json: string | null;
}

interface ProfileEvidencePointer {
  entryId: string;
  evidenceId: string;
  sourceText: string;
  normalizedSourceText: string;
  senioritySignal: boolean;
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
  outcome_conversion_json: string;
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

interface WorkflowRunProjectionRow extends Record<string, unknown> {
  workflow_id: string;
  tenant_id: string;
  workflow_type: string;
  status: string;
  input_summary_json: string;
  error_code: string | null;
  error_message: string | null;
  retryable: number;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  temporal_run_id: string | null;
  events_json: string;
  // Apply enrichment (LEFT JOIN apply_run_projections) — present only for
  // apply-type runs.
  apply_job_id?: string | null;
  job_title?: string | null;
  job_employer?: string | null;
  apply_dry_run?: number | null;
  apply_model?: string | null;
  apply_result?: string | null;
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

interface EvidenceUsageProjectionRow extends Record<string, unknown> {
  projection_kind: "entry" | "gap";
  projection_id: string;
  payload_json: string;
  last_updated_at: string;
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

const IN_MEMORY_JOB_SORT_FIELDS = new Set([
  "source",
  "compensation_min_eur",
  "compensation_max_eur",
  "compensation_posted",
  "compensation_market",
  "compensation_confidence",
  "compensation_warnings",
  "apply_status",
]);

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
  const work = dashboardWorkSummary(db);
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
    work,
    funnel: parseFunnel(dashboard.funnel_json),
    conversion: buildConversionSummary(dashboard.outcome_conversion_json),
    activity: recentActivity(db),
    progress: listPipelineProgress(db),
    sourceHealth: listSourceHealth(db),
    operationalMetrics,
    applyRuns: recentApplyRuns(db),
    preparation: buildPreparationSummary(db, DEFAULT_TENANT),
  };
}

interface DashboardWorkRow extends Record<string, unknown> {
  job_id: string;
  title: string;
  employer: string;
  current_stage: string;
  current_substage: string;
  current_state: string;
  stage_started_at: string | null;
  stage_updated_at: string | null;
}

function dashboardWorkSummary(db: SqliteDatabase): DashboardSummary["work"] {
  const empty: DashboardSummary["work"] = {
    active: 0,
    stuck: 0,
    stuckAfterSeconds: DASHBOARD_STUCK_AFTER_SECONDS,
    stuckItems: [],
  };
  if (!tableExists(db, "job_list_projections")) return empty;

  const activeFilter = jobSqlFilter(db, digestBaseJobQuery());
  const hasStageState = tableExists(db, "job_stage_states");
  const stageColumns = hasStageState
    ? "stage_state.started_at AS stage_started_at, stage_state.updated_at AS stage_updated_at"
    : "NULL AS stage_started_at, NULL AS stage_updated_at";
  const stageJoin = hasStageState
    ? `LEFT JOIN job_stage_states AS stage_state
         ON stage_state.job_url = job_list_projections.job_id
        AND stage_state.stage = job_list_projections.current_substage`
    : "";
  const rows = allRows<DashboardWorkRow>(
    db,
    `SELECT job_id, title, employer, current_stage, current_substage, current_state,
            ${stageColumns}
       FROM job_list_projections
       ${stageJoin}
       ${activeFilter.where}
        AND current_state IN ('queued', 'running')`,
    activeFilter.params,
  );

  const nowMs = Date.now();
  const cutoffMs = nowMs - DASHBOARD_STUCK_AFTER_SECONDS * 1_000;
  const workerUnavailable = dashboardWorkerUnavailable(db, nowMs);
  const stuckRows: DashboardWorkRow[] = [];
  let active = 0;
  for (const row of rows) {
    if (
      row.current_state === "running" &&
      hasStageState &&
      workerUnavailable &&
      dashboardWorkTimestampMs(row.stage_updated_at ?? row.stage_started_at) <= cutoffMs
    ) {
      stuckRows.push(row);
    } else {
      active += 1;
    }
  }

  stuckRows.sort(
    (left, right) =>
      dashboardWorkTimestampMs(left.stage_updated_at ?? left.stage_started_at) -
      dashboardWorkTimestampMs(right.stage_updated_at ?? right.stage_started_at),
  );
  return {
    active,
    stuck: stuckRows.length,
    stuckAfterSeconds: DASHBOARD_STUCK_AFTER_SECONDS,
    stuckItems: stuckRows.slice(0, DASHBOARD_STUCK_ITEM_LIMIT).map((row) => ({
      jobKey: row.job_id,
      title: row.title || "Untitled",
      company: row.employer || "Unknown company",
      stage: isStage(row.current_substage)
        ? row.current_substage
        : isStage(row.current_stage)
          ? row.current_stage
          : "discover",
      updatedAt: row.stage_updated_at ?? row.stage_started_at,
    })),
  };
}

function dashboardWorkTimestampMs(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function dashboardWorkerUnavailable(db: SqliteDatabase, nowMs: number): boolean {
  return readWorkerHealth(db.name, new Date(nowMs)).status !== "healthy";
}

export function buildOutcomeAnalyticsSummary(db: SqliteDatabase): OutcomeAnalyticsSummary {
  refreshProjections(db, DEFAULT_TENANT);
  const dashboardRow = getRow<DashboardProjectionRow>(
    db,
    "SELECT * FROM dashboard_projections WHERE tenant_id = ?",
    [DEFAULT_TENANT],
  );
  const dashboard = dashboardRow ?? defaultDashboardRow();
  return buildOutcomeAnalyticsFromConversion(
    dashboard.outcome_conversion_json,
    dashboard.generated_at || new Date().toISOString(),
  );
}

export interface DigestBudgetSnapshot {
  status: "ok" | "over_budget";
  estimatedUsd: number;
  dailyBudgetUsd: number;
  remainingUsd: number | null;
  unlimited: boolean;
}

export interface BuildDigestOptions {
  budget?: DigestBudgetSnapshot;
  applyReviewQueue?: ApplyReviewQueueResponse;
  minFitScore?: number;
  now?: Date;
}

export interface AcknowledgeDigestOptions {
  acknowledgedAt?: string;
  now?: Date;
}

export function ensureDigestStateTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS digest_state (
      tenant_id              TEXT PRIMARY KEY DEFAULT 'local',
      last_acknowledged_at   TEXT,
      updated_at             TEXT NOT NULL
    );
  `);
}

export function readDigestState(db: SqliteDatabase): DigestState {
  ensureDigestStateTable(db);
  const row = getRow<{ last_acknowledged_at: string | null; updated_at: string | null }>(
    db,
    "SELECT last_acknowledged_at, updated_at FROM digest_state WHERE tenant_id = ?",
    [DEFAULT_TENANT],
  );
  return {
    lastAcknowledgedAt: nullableString(row?.last_acknowledged_at),
    updatedAt: nullableString(row?.updated_at),
  };
}

export function acknowledgeDigest(
  db: SqliteDatabase,
  options: AcknowledgeDigestOptions = {},
): DigestAcknowledgeResponse {
  ensureDigestStateTable(db);
  const previous = readDigestState(db).lastAcknowledgedAt;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const requestedAcknowledgedAt = options.acknowledgedAt ?? nowIso;
  const acknowledgedAt = boundedAcknowledgeTimestamp(requestedAcknowledgedAt, nowIso);
  const nextAcknowledgedAt =
    previous && Date.parse(previous) > Date.parse(acknowledgedAt) ? previous : acknowledgedAt;

  db.prepare(
    `INSERT INTO digest_state (tenant_id, last_acknowledged_at, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       last_acknowledged_at = excluded.last_acknowledged_at,
       updated_at = excluded.updated_at`,
  ).run(DEFAULT_TENANT, nextAcknowledgedAt, nowIso);

  recordDigestReviewedEvent(db, {
    acknowledgedAt: nextAcknowledgedAt,
    previousAcknowledgedAt: previous,
    reviewedAt: nowIso,
  });

  return {
    ok: true,
    state: readDigestState(db),
  };
}

export function buildDigest(db: SqliteDatabase, options: BuildDigestOptions = {}): DailyDigest {
  refreshProjections(db, DEFAULT_TENANT);
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const since = readDigestState(db).lastAcknowledgedAt;
  const highFitThreshold = normalizeDigestThreshold(options.minFitScore);
  const queueItems = options.applyReviewQueue?.items ?? [];
  const preparation = buildPreparationSummary(db, DEFAULT_TENANT);
  return {
    ok: true,
    generatedAt,
    since,
    highFitThreshold,
    newMatches: countDigestNewMatches(db, since, highFitThreshold),
    blockedSources: digestBlockedSources(db),
    reviewNeededMaterials: {
      count: queueItems.filter(isReviewNeededMaterial).length,
    },
    staleScores: {
      count: preparation.outdatedScoreCount,
    },
    pendingApprovals: {
      count: queueItems.filter((item) => item.review.state === "pending").length,
    },
    followUpsDue: {
      count: countFollowUpsDue(db, now),
      derived: true,
      thresholdDays: DIGEST_FOLLOW_UP_THRESHOLD_DAYS,
      dayBoundary: DIGEST_DAY_BOUNDARY,
    },
    budget: digestBudget(options.budget),
    deepLinks: digestDeepLinks(since),
  };
}

function boundedAcknowledgeTimestamp(candidate: string, nowIso: string): string {
  const candidateTime = Date.parse(candidate);
  const nowTime = Date.parse(nowIso);
  if (!Number.isFinite(candidateTime)) return nowIso;
  if (candidateTime > nowTime) return nowIso;
  return candidate;
}

function recordDigestReviewedEvent(
  db: SqliteDatabase,
  payload: {
    acknowledgedAt: string;
    previousAcknowledgedAt: string | null;
    reviewedAt: string;
  },
): void {
  if (!tableExists(db, "job_events")) return;
  const columns = columnNames(db, "job_events");
  const values: Record<string, SqliteValue> = {
    job_url: null,
    stage: null,
    event_type: "DigestReviewed",
    level: "info",
    message: "Digest reviewed.",
    occurred_at: payload.reviewedAt,
    payload_json: JSON.stringify({
      tenantId: DEFAULT_TENANT,
      ...payload,
    }),
  };
  const entries = Object.entries(values).filter(([name]) => columns.has(name));
  if (!entries.length) return;
  db.prepare(
    `INSERT INTO job_events (${entries.map(([name]) => name).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`,
  ).run(...entries.map(([, value]) => value));
}

function normalizeDigestThreshold(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 7;
  return Math.min(10, Math.max(1, Math.trunc(Number(value))));
}

function digestBudget(budget: DigestBudgetSnapshot | undefined): DailyDigest["budget"] {
  if (!budget) {
    return {
      status: "ok",
      estimatedUsd: 0,
      dailyBudgetUsd: 0,
      remainingUsd: null,
      unlimited: true,
    };
  }
  return {
    status: budget.status,
    estimatedUsd: Number(budget.estimatedUsd),
    dailyBudgetUsd: Number(budget.dailyBudgetUsd),
    remainingUsd: budget.remainingUsd === null ? null : Number(budget.remainingUsd),
    unlimited: Boolean(budget.unlimited),
  };
}

function digestDeepLinks(since: string | null): DailyDigest["deepLinks"] {
  const newMatches = new URLSearchParams({
    deleted: "active",
    sort: "discovered_at",
    dir: "desc",
  });
  if (since) {
    newMatches.set("discoveredSince", since);
    newMatches.set("scoredSince", since);
  }
  const staleScores = new URLSearchParams({
    deleted: "active",
    state: "stale",
    sort: "fit_score",
    dir: "desc",
  });
  return {
    newMatches: `/jobs?${newMatches.toString()}`,
    blockedSources: "/discovery",
    reviewNeededMaterials: "/apply-review",
    staleScores: `/jobs?${staleScores.toString()}`,
    pendingApprovals: "/apply-review",
    followUpsDue: "/jobs?applyStatus=applied",
    budget: "/settings",
  };
}

function isReviewNeededMaterial(item: ApplyReviewQueueResponse["items"][number]): boolean {
  const hasMaterial = item.materials.hasResume || item.materials.hasCoverLetter || item.materials.hasPdf;
  return hasMaterial && !item.materials.ready;
}

function digestBlockedSources(db: SqliteDatabase): DailyDigest["blockedSources"] {
  const sources = listSourceHealth(db)
    .filter(
      (source) =>
        source.recommendedState === "quarantined" ||
        source.recommendedState === "disabled" ||
        source.consecutiveFailures >= 3,
    )
    .map((source) => ({
      sourceId: source.sourceId,
      recommendedState: source.recommendedState,
      consecutiveFailures: source.consecutiveFailures,
    }));
  return { count: sources.length, sources };
}

function countDigestNewMatches(
  db: SqliteDatabase,
  since: string | null,
  highFitThreshold: number,
): DailyDigest["newMatches"] {
  const activeFilter = jobSqlFilter(db, digestBaseJobQuery());
  const sinceClause = since ? " AND (discovered_at >= ? OR scored_at >= ?)" : "";
  const sinceParams: SqliteValue[] = since ? [since, since] : [];
  const where = `${activeFilter.where}${sinceClause}`;
  const params = [...activeFilter.params, ...sinceParams];
  return {
    count: countRows(db, `SELECT COUNT(*) AS count FROM job_list_projections${where}`, params),
    highFitCount: countRows(
      db,
      `SELECT COUNT(*) AS count FROM job_list_projections${where} AND COALESCE(fit_score, -1) >= ?`,
      [...params, highFitThreshold],
    ),
  };
}

function digestBaseJobQuery(): JobListQuery {
  return {
    page: 1,
    pageSize: 1,
    sort: "discovered_at",
    dir: "desc",
    q: "",
    deleted: "active",
    applyStatus: "all",
    source: "",
    company: "",
    discoveredSince: undefined,
    scoredSince: undefined,
  };
}

const FOLLOW_UP_STOP_OUTCOMES = new Set([
  "recruiter_reply",
  "interview",
  "assessment",
  "offer",
  "rejection",
  "withdrawn",
  "bounced",
]);

function countFollowUpsDue(db: SqliteDatabase, now: Date): number {
  if (!tableExists(db, "application_outcomes")) return 0;
  const cutoff = new Date(now.getTime() - DIGEST_FOLLOW_UP_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = allRows<{
    job_key: string;
    kind: string;
    occurred_at: string;
    recorded_at: string | null;
  }>(
    db,
    `SELECT job_key, kind, occurred_at, recorded_at
       FROM application_outcomes
      WHERE tenant_id = ?
      ORDER BY job_key ASC, occurred_at ASC, recorded_at ASC`,
    [DEFAULT_TENANT],
  );
  const byJob = new Map<string, { appliedAt: string | null; lastActivityAt: string | null; stopped: boolean }>();
  for (const row of rows) {
    const jobKey = row.job_key;
    const current = byJob.get(jobKey) ?? {
      appliedAt: null,
      lastActivityAt: null,
      stopped: false,
    };
    const occurredAt = row.occurred_at || row.recorded_at || "";
    if (!occurredAt) continue;
    if (!current.lastActivityAt || occurredAt > current.lastActivityAt) {
      current.lastActivityAt = occurredAt;
    }
    if (row.kind === "applied_confirmation") {
      if (!current.appliedAt || occurredAt > current.appliedAt) {
        current.appliedAt = occurredAt;
        current.stopped = false;
      }
    } else if (
      current.appliedAt &&
      occurredAt > current.appliedAt &&
      FOLLOW_UP_STOP_OUTCOMES.has(row.kind)
    ) {
      current.stopped = true;
    }
    byJob.set(jobKey, current);
  }
  let count = 0;
  for (const item of byJob.values()) {
    if (item.appliedAt && !item.stopped && item.lastActivityAt && item.lastActivityAt <= cutoff) {
      count += 1;
    }
  }
  return count;
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
    discoveredSince: undefined,
    scoredSince: undefined,
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
       FROM job_materials_artifacts
       WHERE status = 'approved'
         AND artifact_type = 'tailored_resume'
       GROUP BY job_url
     )
     SELECT a.job_url, a.metadata_json
       FROM job_materials_artifacts a
       JOIN latest ON latest.job_url = a.job_url AND latest.max_generation = a.generation
      WHERE a.artifact_type = 'tailored_resume'
        AND a.status = 'approved'`,
    [],
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
    discoveredSince: undefined,
    scoredSince: undefined,
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

  if (!query.q && !IN_MEMORY_JOB_SORT_FIELDS.has(query.sort)) {
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
    const summaries = rows.map((row) => rowToJobSummary(row, db));
    return paginateWithTotal(summaries, total, page, query.pageSize, query.sort, query.dir, jobFilterPayload(query));
  }

  // Free-text search and projected-JSON sort fields use the in-memory path.
  // The projection table is already denormalised, and this keeps compensation
  // sorting tied to the typed projected summary instead of SQLite JSON quirks.
  const allMatching = allRows<JobListProjectionRow>(
    db,
    `SELECT ${projectionSelect} FROM job_list_projections${filter.where}`,
    filter.params,
  );
  const normalizedQuery = query.q.toLowerCase();
  const filtered = allMatching
    .map((row) => rowToJobSummary(row, db))
    .filter((job) => !query.q || filterJob(job, query, normalizedQuery));
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
    .map((row) => rowToJobSummary(row, db))
    .filter((job) => filterJob(job, query, normalizedQuery))
    .map((job) => job.jobKey);
}

export function listEvidenceMap(db: SqliteDatabase): EvidenceMapResponse {
  refreshProjections(db, DEFAULT_TENANT);
  if (!tableExists(db, "evidence_usage_projections")) {
    return { ok: true, entries: [], gaps: [], generatedAt: new Date(0).toISOString() };
  }
  const rows = allRows<EvidenceUsageProjectionRow>(
    db,
    `SELECT projection_kind, projection_id, payload_json, last_updated_at
       FROM evidence_usage_projections
      WHERE tenant_id = ?
      ORDER BY projection_kind, LOWER(projection_id)`,
    [DEFAULT_TENANT],
  );
  const entries: EvidenceMapEntry[] = [];
  const gaps: EvidenceGap[] = [];
  let generatedAt = new Date(0).toISOString();
  for (const row of rows) {
    const payload = parseJsonRecord(row.payload_json);
    if (!payload) {
      continue;
    }
    if (row.last_updated_at && row.last_updated_at > generatedAt) {
      generatedAt = row.last_updated_at;
    }
    if (row.projection_kind === "entry") {
      entries.push(payload as unknown as EvidenceMapEntry);
    } else if (row.projection_kind === "gap") {
      gaps.push(payload as unknown as EvidenceGap);
    }
  }
  return { ok: true, entries, gaps, generatedAt };
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
  const jobSummary = rowToJobSummary(listRow, db);
  const latestApplyRun = latestApplyRunForJob(db, listRow.job_id);
  const activeApplyRun = activeApplyRunForJob(db, listRow.job_id);
  return {
    ok: true,
    job: {
      ...jobSummary,
      descriptionPreview: detailRow?.description_preview ?? "",
      scoreReasoning: detailRow?.score_reasoning ?? listRow.score_reasoning,
    },
    applyAudit: buildApplyAudit({
      applicationUrl: applyAuditApplicationUrl(listRow),
      hasResume: Boolean(listRow.has_resume),
      hasCoverLetter: Boolean(listRow.has_cover_letter),
      hasPdf: Boolean(listRow.has_pdf),
      currentStage: jobSummary.currentSubstage,
      currentState: jobSummary.currentState,
      currentErrorCode: jobSummary.errorCode,
      currentErrorMessage: jobSummary.errorMessage,
      latestApplyRun,
      scoreBreakdown: jobSummary.scoreBreakdown,
      reviewEvidenceAvailable: Boolean(
        jobSummary.scoreBreakdown ||
          artifacts.length ||
          auditHistory.length ||
          detailRow?.description_preview,
      ),
    }),
    repeatApplication: evaluateRepeatApplication(db, listRow.job_id),
    activeApplyRun,
    stages,
    artifacts,
    auditHistory,
    employerAnalysis: parseEmployerAnalysis(detailRow?.employer_analysis_json ?? null),
    requirementFitReport: parseRequirementFitReport(detailRow?.requirement_fit_report_json ?? null),
    interviewPrep: parseInterviewPrep(detailRow?.interview_prep_json ?? null),
    compensationAudit: parseCompensationAudit(detailRow?.compensation_audit_json ?? null),
  };
}

function latestApplyRunForJob(db: SqliteDatabase, jobId: string): ApplyAuditLatestRun | null {
  if (!tableExists(db, "apply_run_projections")) {
    return null;
  }
  const row = getRow<ApplyRunProjectionRow>(
    db,
    `SELECT * FROM apply_run_projections
     WHERE tenant_id = ? AND job_id = ?
     ORDER BY COALESCE(started_at, finished_at, '') DESC, run_id DESC
     LIMIT 1`,
    [DEFAULT_TENANT, jobId],
  );
  if (!row) {
    return null;
  }
  return applyRunProjectionToAuditRun(row);
}

/**
 * Cancellation is a job-scoped operation, so its target must not be derived
 * from the dashboard's intentionally bounded cross-job history. Read every
 * projection row for this one job and retain the newest non-terminal run.
 */
function activeApplyRunForJob(db: SqliteDatabase, jobId: string): ApplyAuditLatestRun | null {
  if (!tableExists(db, "apply_run_projections")) {
    return null;
  }
  const rows = allRows<ApplyRunProjectionRow>(
    db,
    `SELECT * FROM apply_run_projections
     WHERE tenant_id = ? AND job_id = ?
     ORDER BY COALESCE(started_at, finished_at, '') DESC, run_id DESC`,
    [DEFAULT_TENANT, jobId],
  );
  return rows
    .map(applyRunProjectionToAuditRun)
    .find((run) => ACTIVE_APPLY_RUN_STATUSES.has(run.status)) ?? null;
}

const ACTIVE_APPLY_RUN_STATUSES = new Set(["starting", "in_progress", "queued", "running"]);

function applyRunProjectionToAuditRun(row: ApplyRunProjectionRow): ApplyAuditLatestRun {
  return {
    runId: stringField(row.run_id),
    status: normalizeWorkflowRunStatus(row.status),
    result: nullableString(row.result),
    dryRun: Boolean(row.dry_run),
    startedAt: nullableString(row.started_at),
    finishedAt: nullableString(row.finished_at),
  };
}

function applyAuditApplicationUrl(row: JobListProjectionRow): string | null {
  return nullableString(row.application_url) ?? nullableString(row.job_id);
}

/**
 * Parse the projected canonical employer analysis (Phase 1). The projection
 * builder is the single owner of this shape; the read model only deserialises
 * the stored JSON, never recomputes it.
 */
function parseEmployerAnalysis(value: string | null): EmployerAnalysis | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as EmployerAnalysis;
  } catch {
    return null;
  }
}

function parseRequirementFitReport(value: string | null): RequirementFitReport | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as RequirementFitReport;
  } catch {
    return null;
  }
}

function parseInterviewPrep(value: string | null): InterviewPrep | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as InterviewPrep;
  } catch {
    return null;
  }
}

function parseCompensationSummary(value: string | null): JobCompensationSummary | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as JobCompensationSummary;
  } catch {
    return null;
  }
}

function parseCompensationAudit(value: string | null): JobCompensationAudit | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as JobCompensationAudit;
  } catch {
    return null;
  }
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
               OR JSON_EXTRACT(payload_json, '$.surviving_job_id') = ?
             )
           )
        ORDER BY occurred_at ASC, event_id ASC`,
      [jobId, jobId, jobId, jobId, jobId, jobId],
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
    case "PostingContentSnapshotCaptured": {
      const snapshotQuarantined = payloadBoolean(payload, "quarantined");
      const quarantineReason = payloadText(payload, "quarantineReason", "quarantine_reason");
      const quarantineLabel =
        quarantineReason && quarantineReason !== "none" ? humanizeToken(quarantineReason) : "";
      return makeAuditEntry({
        ...base,
        category: "enrichment",
        tone: snapshotQuarantined ? "warning" : "success",
        title: "Content snapshot captured",
        description: snapshotQuarantined
          ? "A low-confidence posting snapshot was stored and quarantined from tailoring; the job stays scoreable and visible."
          : "A posting content snapshot was stored for future comparisons.",
        actor: "system",
        details: auditDetails(
          ["Source", payloadText(payload, "sourceId", "source_id")],
          ["Version", payloadText(payload, "snapshotVersion", "snapshot_version")],
          ["Extraction tier", humanizeToken(payloadText(payload, "extractionTier", "extraction_tier"))],
          ["Confidence", humanizeToken(payloadText(payload, "confidence"))],
          ["Quarantine", quarantineLabel],
        ),
      });
    }
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
  const deletedJoin = tableExists(db, "jobctrl_deleted_jobs")
    ? " LEFT JOIN jobctrl_deleted_jobs d ON d.job_url = ap.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
    : "";
  const hiddenJoin = tableExists(db, "jobctrl_hidden_jobs")
    ? " LEFT JOIN jobctrl_hidden_jobs h ON h.job_url = ap.job_id AND h.unhidden_at IS NULL"
    : "";
  const deletedWhere = tableExists(db, "jobctrl_deleted_jobs") ? " AND d.job_url IS NULL" : "";
  const hiddenWhere = tableExists(db, "jobctrl_hidden_jobs") ? " AND h.job_url IS NULL" : "";
  const rows = allRows<ArtifactProjectionRow>(
    db,
    `SELECT ap.* FROM artifact_list_projections ap${deletedJoin}${hiddenJoin}
     WHERE ap.tenant_id = ?${deletedWhere}${hiddenWhere}`,
    [DEFAULT_TENANT],
  );
  const artifacts = rows.map((row) => rowToArtifactSummary(row, db)).filter((artifact) => {
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
    artifact: rowToArtifactSummary(row, db),
    layoutBoxes: parseResumeLayoutBoxes(row.layout_boxes_json),
    tailoringExplanation: tailoringExplanationForArtifact(db, row),
  };
}

function parseResumeLayoutBoxes(value: string | null): ArtifactDetail["layoutBoxes"] {
  let parsed: unknown = null;
  try {
    parsed = value ? JSON.parse(value) : null;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const boxes: ArtifactDetail["layoutBoxes"] = [];
  for (const raw of parsed) {
    if (!isRecord(raw)) continue;
    const pageNumber = positiveInteger(raw.pageNumber);
    const leftPct = boundedPercent(raw.leftPct);
    const topPct = boundedPercent(raw.topPct);
    const widthPct = boundedPercent(raw.widthPct);
    const heightPct = boundedPercent(raw.heightPct);
    const semanticId = safeAuditText(raw.semanticId, 160);
    const textExcerpt = safeAuditText(raw.textExcerpt, 500);
    if (
      !semanticId ||
      !textExcerpt ||
      pageNumber === null ||
      leftPct === null ||
      topPct === null ||
      widthPct === null ||
      heightPct === null
    ) {
      continue;
    }
    boxes.push({
      semanticId,
      pageNumber,
      lineNumber: nullableInteger(raw.lineNumber),
      textExcerpt,
      leftPct,
      topPct,
      widthPct,
      heightPct,
    });
  }
  return boxes;
}

/** Validate candidate profile data. Used by callers (e.g. tests, future
 * SDK helpers) that want to assert canonical shape before posting. */
export function parseProfileShape(value: unknown): ProfileShape | null {
  const parsed = ProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readSettingsConfig(
  paths: { configPath: string },
): SettingsResponse {
  const resolved = readJobCtrlSettings(paths.configPath);
  return {
    ok: true,
    ...resolved,
    paths,
  };
}

// ============================================================== mappings

function rowToJobSummary(row: JobListProjectionRow, db?: SqliteDatabase): JobSummary {
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
    compensationSummary: parseCompensationSummary(row.compensation_summary_json),
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
    resumeTemplate: db ? resumeTemplateStateForJob(db, jobKey) : null,
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
  "barcelona",
  "believe",
  "care",
  "chain",
  "clinic",
  "clinics",
  "combine",
  "company",
  "cool",
  "cutting",
  "deserves",
  "edge",
  "europe",
  "everyone",
  "expert",
  "fast",
  "growth",
  "head",
  "health",
  "impress",
  "innovator",
  "invisible",
  "join",
  "largest",
  "leading",
  "love",
  "office",
  "ortho",
  "orthodontics",
  "rapid",
  "revolutionizing",
  "since",
  "smile",
  "team",
  "teams",
  "tech",
  "they",
  "worldwide",
]);
const HIGH_SIGNAL_SINGLE_KEYWORDS = new Set([
  "ai",
  "ai-first",
  "ai-native",
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
  "management",
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
  "saas",
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

  // Phase 4 (AUDIT-01): the base explanation is parsed from this artifact's OWN
  // ``metadata_json`` projection column only. The legacy sibling-file fallback
  // (reading another artifact's ``metadata_json`` / a sibling ``.txt`` file on a
  // miss) and the TypeScript-side keyword recompute are removed — every audited
  // claim now has a single canonical source: the projection rows the projection
  // builder owns. Where a canonical row is absent we serve an honest null/empty.
  const explanation = parseTailoringExplanation(row.metadata_json);
  if (explanation === null) return null;
  // Phase 2: canonical per-bullet provenance from the ``bullet_provenance_json``
  // projection column (this row for a text resume; the sibling tailored-resume
  // projection ROW — not a file — for a PDF). Exclusively from canonical rows.
  explanation.bulletProvenance = bulletProvenanceForArtifact(db, row);
  // Phase 3: canonical generation-time keyword coverage (GROUND-06) + voice-pass
  // audit (VOICE-02) from their own projection columns (same row for a text
  // resume; the sibling tailored-resume projection row for a PDF). ``null`` when
  // the generation recorded none.
  explanation.coverageAudit = coverageAuditForArtifact(db, row);
  explanation.voicePass = voicePassForArtifact(db, row);
  // Phase 4: the legacy ``keywords`` summary block is now DERIVED from the
  // canonical coverage audit (computed against the rendered text at generation
  // time) instead of recomputed from the resume file / job description at read
  // time. Honest empty when no canonical coverage exists for this generation.
  explanation.keywords = keywordsBlockFromCoverageAudit(explanation.coverageAudit);
  attachCoverageKeywordsToBulletProvenance(explanation);
  backfillLegacyProfileEvidenceMapping(db, row, explanation);
  attachProfileSourceTextToBulletProvenance(db, row.tenant_id, explanation);
  const missingAuditFields = missingTailoringAuditFields(explanation);
  if (missingAuditFields.length) {
    explanation.quality.errors = [
      `Tailoring audit metadata incomplete: missing ${missingAuditFields.join(", ")}`,
      ...explanation.quality.errors,
    ];
  }
  return explanation;
}

/** The honest empty ``keywords`` block when an artifact recorded no coverage. */
function emptyKeywordsBlock(): ArtifactTailoringExplanation["keywords"] {
  return keywordsBlockFromCoverageAudit(null);
}

/**
 * Phase 4 — derive the legacy ``keywords`` summary block (planned/covered/missing
 * + counts) from the canonical coverage audit (``coverage_audit_json``), the
 * single source of truth computed against the rendered text at generation time.
 *
 * No read-time recompute and no job-description inference: when the generation
 * recorded no coverage the block is honestly empty with ``coverageRecorded:
 * false``. The canonical lists are already pruned + ordered by importance at
 * generation time, so there is no read-time filtering (``filtered`` is empty and
 * the displayed/total counts coincide up to the display cap).
 */
function keywordsBlockFromCoverageAudit(
  coverageAudit: BulletCoverageAudit | null,
): ArtifactTailoringExplanation["keywords"] {
  const displayLimit = 32;
  const planned = coverageAudit?.planned ?? [];
  const covered = coverageAudit?.covered ?? [];
  const declared = coverageAudit?.declared ?? [];
  const missing = coverageAudit?.missing ?? [];
  const displayedPlanned = planned.slice(0, displayLimit);
  const displayedCovered = covered.slice(0, displayLimit);
  const displayedDeclared = declared.slice(0, displayLimit);
  const displayedMissing = missing.slice(0, displayLimit);
  return {
    coverageRecorded: coverageAudit !== null,
    planned: displayedPlanned,
    covered: displayedCovered,
    declared: displayedDeclared,
    missing: displayedMissing,
    filtered: { planned: [], covered: [], missing: [] },
    counts: {
      planned: planned.length,
      covered: covered.length,
      declared: declared.length,
      missing: missing.length,
      displayedPlanned: displayedPlanned.length,
      displayedCovered: displayedCovered.length,
      displayedDeclared: displayedDeclared.length,
      displayedMissing: displayedMissing.length,
      filteredPlanned: 0,
      filteredCovered: 0,
      filteredMissing: 0,
    },
  };
}

function attachCoverageKeywordsToBulletProvenance(explanation: ArtifactTailoringExplanation): void {
  const coverage = explanation.coverageAudit;
  if (!coverage || !explanation.bulletProvenance.length) return;

  explanation.bulletProvenance = explanation.bulletProvenance.map((entry) => {
    const seen = new Set(entry.matchedKeywords.map((keyword) => keyword.toLowerCase()));
    const matchedKeywords = [...entry.matchedKeywords];
    for (const keyword of coverage.covered) {
      if (coverage.coveredBy[keyword] !== entry.bulletId) continue;
      const normalized = keyword.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      matchedKeywords.push(keyword);
    }
    return matchedKeywords.length === entry.matchedKeywords.length ? entry : { ...entry, matchedKeywords };
  });
}

/**
 * Phase 2 — read canonical per-bullet provenance for an artifact from the
 * ``bullet_provenance_json`` projection column. For a text resume the rows live
 * on the row itself; for a PDF they live on the sibling tailored-resume row of
 * the same generation. Returns [] when no provenance was recorded.
 */
function bulletProvenanceForArtifact(
  db: SqliteDatabase,
  row: ArtifactProjectionRow,
): BulletProvenanceEntry[] {
  let provenanceJson = row.bullet_provenance_json;
  if (!provenanceJson && TAILORING_PDF_ARTIFACT_TYPES.has(row.artifact_type)) {
    const sibling = getRow<{ bullet_provenance_json: string | null }>(
      db,
      `SELECT bullet_provenance_json
         FROM artifact_list_projections
        WHERE tenant_id = ?
          AND job_id = ?
          AND artifact_type IN ('tailored_resume', 'tailored_resume_txt')
          AND bullet_provenance_json IS NOT NULL
          AND TRIM(bullet_provenance_json) != ''
          AND (? IS NULL OR generation = ? OR generation IS NULL)
        ORDER BY CASE WHEN generation = ? THEN 0 ELSE 1 END, created_at DESC
        LIMIT 1`,
      [row.tenant_id, row.job_id, row.generation, row.generation, row.generation],
    );
    provenanceJson = sibling?.bullet_provenance_json ?? null;
  }
  return parseBulletProvenance(provenanceJson);
}

function parseBulletProvenance(value: string | null): BulletProvenanceEntry[] {
  if (!value || !value.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: BulletProvenanceEntry[] = [];
  for (const raw of parsed) {
    const record = metadataRecord(raw);
    const bulletId = metadataText(record.bullet_id, 160);
    const section = metadataText(record.section, 80);
    const generatedText = metadataText(record.generated_text, 2000);
    const transformType = metadataText(record.transform_type, 80);
    const control = metadataText(record.control, 80);
    // Drop structurally-invalid rows rather than emit a half-populated entry: the
    // canonical writer always supplies these fields, so a missing one means junk.
    if (!bulletId || !section || !generatedText || !transformType || !control) continue;
    entries.push({
      bulletId,
      section,
      sourceId: metadataText(record.source_id, 160),
      evidenceIds: metadataTextList(record.evidence_ids, 32, 160),
      sourceText: metadataTextList(record.source_text ?? record.sourceText, 8, 1200),
      requirementIds: metadataTextList(record.requirement_ids, 32, 160),
      matchedKeywords: metadataTextList(record.matched_keywords, 32, 160),
      transformType,
      control,
      rationale: metadataText(record.rationale, 600) ?? "",
      generatedText,
    });
  }
  return entries;
}

function attachProfileSourceTextToBulletProvenance(
  db: SqliteDatabase,
  tenantId: string,
  explanation: ArtifactTailoringExplanation,
): void {
  const pointers = profileEvidencePointers(db, tenantId);
  if (!pointers.length) return;

  const byEvidenceId = new Map<string, ProfileEvidencePointer>();
  const byEntryId = new Map<string, ProfileEvidencePointer[]>();
  for (const pointer of pointers) {
    byEvidenceId.set(pointer.evidenceId, pointer);
    const entryPointers = byEntryId.get(pointer.entryId) ?? [];
    entryPointers.push(pointer);
    byEntryId.set(pointer.entryId, entryPointers);
  }

  explanation.bulletProvenance = explanation.bulletProvenance.map((entry) => {
    const sourceText: string[] = [];
    const sourceId = safeAuditText(entry.sourceId, 160);
    const sourceIdPointers = sourceId ? (byEntryId.get(sourceId) ?? []) : [];
    if (entry.section === "skills" && sourceIdPointers.length) {
      for (const pointer of sourceIdPointers) {
        sourceText.push(pointer.sourceText);
      }
    }
    if (!sourceText.length) {
      for (const evidenceId of entry.evidenceIds) {
        const pointer = byEvidenceId.get(evidenceId);
        if (pointer) sourceText.push(pointer.sourceText);
      }
    }
    if (sourceId) {
      const exactPointer = byEvidenceId.get(sourceId);
      if (exactPointer) sourceText.push(exactPointer.sourceText);
      if (!sourceText.length) {
        for (const pointer of sourceIdPointers) {
          sourceText.push(pointer.sourceText);
        }
      }
    }

    const resolvedSourceText = uniqueSourceTexts(sourceText.length ? sourceText : entry.sourceText).slice(0, 8);
    return { ...entry, sourceText: resolvedSourceText };
  });
}

function backfillLegacyProfileEvidenceMapping(
  db: SqliteDatabase,
  row: ArtifactProjectionRow,
  explanation: ArtifactTailoringExplanation,
): void {
  const pointers = profileEvidencePointers(db, row.tenant_id);
  if (!pointers.length) return;

  const discoveredIds: string[] = [];
  explanation.annotatedChanges = explanation.annotatedChanges.map((change) => {
    if (change.evidenceIds.length) {
      discoveredIds.push(...change.evidenceIds);
      return change;
    }
    const evidenceIds = matchProfileEvidencePointers(
      pointers,
      change.sourceId,
      [change.label, ...change.sourceText, ...change.tailoredText, change.rationale ?? ""],
    );
    if (!evidenceIds.length) return change;
    discoveredIds.push(...evidenceIds);
    return { ...change, evidenceIds };
  });

  explanation.bulletProvenance = explanation.bulletProvenance.map((entry) => {
    if (entry.evidenceIds.length) {
      discoveredIds.push(...entry.evidenceIds);
      return entry;
    }
    const evidenceIds = matchProfileEvidencePointers(
      pointers,
      entry.sourceId,
      [entry.generatedText, entry.rationale, ...entry.matchedKeywords],
    );
    if (!evidenceIds.length) return entry;
    discoveredIds.push(...evidenceIds);
    return { ...entry, evidenceIds };
  });

  const backfilledIds = uniqueEvidenceIds(discoveredIds).slice(0, 32);
  if (!backfilledIds.length) return;

  if (!explanation.evidence.requiredIds.length) {
    explanation.evidence.requiredIds = backfilledIds;
  }
  if (!explanation.evidence.seniorityIds.length) {
    const seniorityIds = backfilledIds.filter((id) => pointers.some((pointer) => pointer.evidenceId === id && pointer.senioritySignal));
    explanation.evidence.seniorityIds = seniorityIds.slice(0, 32);
  }
  if (!explanation.evidence.representedIds.length) {
    explanation.evidence.representedIds = backfilledIds;
  }
}

function profileEvidencePointers(db: SqliteDatabase, tenantId: string): ProfileEvidencePointer[] {
  const pointers: ProfileEvidencePointer[] = [];
  if (tableExists(db, "candidate_profile_achievement_evidence")) {
    const rows = allRows<{
      entry_id: string;
      evidence_id: string;
      source_text: string;
      scope: string;
      action: string;
      outcome: string;
      seniority_signal: string;
    }>(
      db,
      `SELECT evidence.entry_id,
              evidence.evidence_id,
              evidence.source_text,
              evidence.scope,
              evidence.action,
              evidence.outcome,
              evidence.seniority_signal
         FROM candidate_profile_achievement_evidence AS evidence
        WHERE evidence.tenant_id = ?
          AND evidence.profile_id = ?
          AND TRIM(evidence.evidence_id) != ''
          AND TRIM(evidence.source_text) != ''
        ORDER BY evidence.entry_id, evidence.evidence_index`,
      [tenantId, DEFAULT_PROFILE_ID],
    );
    for (const evidence of rows) {
      const sourceText = safeAuditText(evidence.source_text, 1200);
      const evidenceId = safeEvidenceId(evidence.evidence_id);
      const entryId = safeAuditText(evidence.entry_id, 160);
      if (!sourceText || !evidenceId || !entryId) continue;
      pointers.push({
        entryId,
        evidenceId,
        sourceText,
        normalizedSourceText: normalizeEvidenceText(sourceText),
        senioritySignal: hasSenioritySignal([
          evidence.scope,
          evidence.action,
          evidence.outcome,
          evidence.seniority_signal,
          sourceText,
        ]),
      });
    }
  }
  if (tableExists(db, "candidate_profile_experience_entries") && tableExists(db, "candidate_profile_experience_bullets")) {
    const rows = allRows<{
      entry_id: string;
      title: string;
      company: string;
      bullet_index: number;
      bullet_text: string;
    }>(
      db,
      `SELECT entries.entry_id,
              entries.title,
              entries.company,
              bullets.bullet_index,
              bullets.bullet_text
         FROM candidate_profile_experience_entries AS entries
         JOIN candidate_profile_experience_bullets AS bullets
           ON bullets.tenant_id = entries.tenant_id
          AND bullets.profile_id = entries.profile_id
          AND bullets.entry_id = entries.entry_id
        WHERE entries.tenant_id = ?
          AND entries.profile_id = ?
          AND TRIM(bullets.bullet_text) != ''
        ORDER BY entries.position_index, bullets.bullet_index`,
      [tenantId, DEFAULT_PROFILE_ID],
    );
    for (const bullet of rows) {
      const entryId = safeAuditText(bullet.entry_id, 160);
      const sourceText = safeAuditText(bullet.bullet_text, 1200);
      if (!entryId || !sourceText) continue;
      pointers.push({
        entryId,
        evidenceId: legacyBulletEvidenceId(entryId, Number(bullet.bullet_index ?? 0) + 1),
        sourceText,
        normalizedSourceText: normalizeEvidenceText(sourceText),
        senioritySignal: hasSenioritySignal([bullet.title, bullet.company, sourceText]),
      });
    }
  }
  addSkillSourcePointers(db, tenantId, pointers);
  return pointers;
}

function addSkillSourcePointers(db: SqliteDatabase, tenantId: string, pointers: ProfileEvidencePointer[]): void {
  const hasSkillCategoryLabels = tableExists(db, "candidate_profile_skill_categories");
  const grouped = new Map<string, { label: string; skills: string[] }>();
  if (tableExists(db, "candidate_profile_skill_items")) {
    const rows = allRows<{
      category_id: string;
      label: string;
      skill_index: number;
      skill_text: string;
    }>(
      db,
      hasSkillCategoryLabels
        ? `SELECT skills.category_id,
                  COALESCE(NULLIF(categories.label, ''), skills.category_id) AS label,
                  skills.item_index AS skill_index,
                  skills.item_text AS skill_text
             FROM candidate_profile_skill_items AS skills
             LEFT JOIN candidate_profile_skill_categories AS categories
               ON categories.tenant_id = skills.tenant_id
              AND categories.profile_id = skills.profile_id
              AND categories.category_id = skills.category_id
            WHERE skills.tenant_id = ?
              AND skills.profile_id = ?
              AND TRIM(skills.category_id) != ''
              AND TRIM(skills.item_text) != ''
            ORDER BY categories.position_index, skills.item_index`
        : `SELECT category_id,
                  category_id AS label,
                  item_index AS skill_index,
                  item_text AS skill_text
             FROM candidate_profile_skill_items
            WHERE tenant_id = ?
              AND profile_id = ?
              AND TRIM(category_id) != ''
              AND TRIM(item_text) != ''
            ORDER BY category_id, item_index`,
      [tenantId, DEFAULT_PROFILE_ID],
    );
    appendSkillSourceGroups(grouped, rows);
  }
  if (tableExists(db, "candidate_profile_required_skills")) {
    const rows = allRows<{
      category_id: string;
      label: string;
      skill_index: number;
      skill_text: string;
    }>(
      db,
      hasSkillCategoryLabels
        ? `SELECT skills.category_id,
                  COALESCE(NULLIF(categories.label, ''), skills.category_id) AS label,
                  skills.skill_index,
                  skills.skill_text
             FROM candidate_profile_required_skills AS skills
             LEFT JOIN candidate_profile_skill_categories AS categories
               ON categories.tenant_id = skills.tenant_id
              AND categories.profile_id = skills.profile_id
              AND categories.category_id = skills.category_id
            WHERE skills.tenant_id = ?
              AND skills.profile_id = ?
              AND TRIM(skills.category_id) != ''
              AND TRIM(skills.skill_text) != ''
            ORDER BY skills.category_id, skills.skill_index`
        : `SELECT category_id,
                  category_id AS label,
                  skill_index,
                  skill_text
             FROM candidate_profile_required_skills
            WHERE tenant_id = ?
              AND profile_id = ?
              AND TRIM(category_id) != ''
              AND TRIM(skill_text) != ''
            ORDER BY category_id, skill_index`,
      [tenantId, DEFAULT_PROFILE_ID],
    );
    appendSkillSourceGroups(grouped, rows, { onlyMissingCategories: true });
  }
  for (const [categoryId, group] of grouped) {
    const sourceText = `${group.label}: ${uniqueSourceTexts(group.skills).join(", ")}`;
    pointers.push({
      entryId: categoryId,
      evidenceId: skillCategoryEvidenceId(categoryId),
      sourceText,
      normalizedSourceText: normalizeEvidenceText(sourceText),
      senioritySignal: hasSenioritySignal([categoryId, sourceText]),
    });
  }
}

function appendSkillSourceGroups(
  grouped: Map<string, { label: string; skills: string[] }>,
  rows: readonly { category_id: string; label: string; skill_index: number; skill_text: string }[],
  options: { onlyMissingCategories?: boolean } = {},
): void {
  for (const row of rows) {
    const categoryId = safeAuditText(row.category_id, 160);
    if (!categoryId || (options.onlyMissingCategories && grouped.has(categoryId))) continue;
    const label = safeAuditText(row.label, 160) || profileSkillCategoryLabel(categoryId);
    const skillText = safeAuditText(row.skill_text, 220);
    if (!skillText) continue;
    const group = grouped.get(categoryId) ?? { label, skills: [] };
    group.skills.push(skillText);
    grouped.set(categoryId, group);
  }
}

function uniqueSourceTexts(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of texts) {
    const text = safeAuditText(raw, 1200);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function skillCategoryEvidenceId(categoryId: string): string {
  return `skills_${safeEvidenceId(categoryId) || "category"}`;
}

function profileSkillCategoryLabel(categoryId: string): string {
  const words = categoryId.replace(/[_-]+/g, " ").trim();
  if (!words) return "Skills";
  return words.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function matchProfileEvidencePointers(
  pointers: readonly ProfileEvidencePointer[],
  sourceId: string | null,
  rawTexts: readonly string[],
): string[] {
  const normalizedSourceId = safeAuditText(sourceId, 160);
  const texts = rawTexts.map((text) => normalizeEvidenceText(text)).filter(Boolean);
  const textTokenSets = texts.map((text) => new Set(evidenceTokens(text)));
  const scored: Array<{ id: string; score: number }> = [];
  for (const pointer of pointers) {
    let score = 0;
    if (normalizedSourceId && pointer.entryId === normalizedSourceId) score += 6;
    if (normalizedSourceId && pointer.evidenceId === normalizedSourceId) score += 8;
    for (const text of texts) {
      if (text && pointer.normalizedSourceText && text.includes(pointer.normalizedSourceText)) score += 6;
      if (text && pointer.normalizedSourceText && pointer.normalizedSourceText.includes(text) && text.length >= 24) score += 4;
    }
    const pointerTokens = evidenceTokens(pointer.normalizedSourceText);
    const overlap = Math.max(
      0,
      ...textTokenSets.map((tokens) => pointerTokens.filter((token) => tokens.has(token)).length),
    );
    if (overlap >= 2) score += overlap;
    if (score >= 6 || overlap >= 4) {
      scored.push({ id: pointer.evidenceId, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return uniqueEvidenceIds(scored.map((item) => item.id)).slice(0, 6);
}

function uniqueEvidenceIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const safe = safeEvidenceId(id);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    out.push(safe);
  }
  return out;
}

function safeEvidenceId(value: unknown): string {
  return safeAuditText(value, 160).replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
}

function legacyBulletEvidenceId(entryId: string, oneBasedBulletIndex: number): string {
  return `${safeEvidenceId(entryId) || "experience"}_bullet_${Math.max(1, Math.trunc(oneBasedBulletIndex || 1))}`;
}

const PROFILE_EVIDENCE_SENIORITY_TERMS = [
  "own",
  "owned",
  "ownership",
  "scope",
  "influence",
  "influenced",
  "cross-team",
  "stakeholder",
  "stakeholders",
  "led",
  "lead",
  "mentor",
  "mentored",
  "architect",
  "architected",
  "strategy",
  "technical leadership",
];

function hasSenioritySignal(values: readonly unknown[]): boolean {
  const text = values.map((value) => safeAuditText(value, 300)).join(" ").toLowerCase();
  return PROFILE_EVIDENCE_SENIORITY_TERMS.some((term) => text.includes(term));
}

function normalizeEvidenceText(value: unknown): string {
  return (safeAuditText(value, 1200).toLowerCase().match(KEYWORD_TOKEN_RE) ?? []).join(" ");
}

function evidenceTokens(value: string): string[] {
  return (value.match(KEYWORD_TOKEN_RE) ?? [])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !LOW_SIGNAL_KEYWORDS.has(token) && !/^\d+$/.test(token));
}

/**
 * Read an artifact's value for a set-level provenance projection column
 * (``coverage_audit_json`` / ``voice_pass_json``), falling back to the sibling
 * tailored-resume row of the same generation for a PDF artifact (whose own row
 * carries no provenance) — mirroring ``bulletProvenanceForArtifact``.
 */
function provenanceSetColumnForArtifact(
  db: SqliteDatabase,
  row: ArtifactProjectionRow,
  column: "coverage_audit_json" | "voice_pass_json",
): string | null {
  const direct = row[column];
  if (typeof direct === "string" && direct.trim()) return direct;
  if (direct || !TAILORING_PDF_ARTIFACT_TYPES.has(row.artifact_type)) return null;
  const sibling = getRow<Record<string, string | null>>(
    db,
    `SELECT ${column}
       FROM artifact_list_projections
      WHERE tenant_id = ?
        AND job_id = ?
        AND artifact_type IN ('tailored_resume', 'tailored_resume_txt')
        AND ${column} IS NOT NULL
        AND TRIM(${column}) != ''
        AND (? IS NULL OR generation = ? OR generation IS NULL)
      ORDER BY CASE WHEN generation = ? THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1`,
    [row.tenant_id, row.job_id, row.generation, row.generation, row.generation],
  );
  return sibling?.[column] ?? null;
}

/**
 * Phase 3 — read canonical generation-time keyword coverage (GROUND-06) for an
 * artifact from the ``coverage_audit_json`` projection column. Returns ``null``
 * when no Phase-3 coverage was recorded for this generation.
 */
function coverageAuditForArtifact(
  db: SqliteDatabase,
  row: ArtifactProjectionRow,
): BulletCoverageAudit | null {
  return parseCoverageAudit(provenanceSetColumnForArtifact(db, row, "coverage_audit_json"));
}

function parseCoverageAudit(value: string | null): BulletCoverageAudit | null {
  if (!value || !value.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const record = metadataRecord(parsed);
  const covered = metadataTextList(record.covered, 256, 160);
  // ``declared`` / ``declared_by`` are absent on pre-A6b persisted rows: default to
  // empty so an old two-bucket generation still reads cleanly.
  const declared = metadataTextList(record.declared, 256, 160);
  const missing = metadataTextList(record.missing, 256, 160);
  const planned = metadataTextList(record.planned, 256, 160);
  const coveredBy = parseKeywordBulletMap(record.covered_by);
  const declaredBy = parseKeywordBulletMap(record.declared_by);
  return {
    computedAgainst: metadataText(record.computed_against, 64) ?? "rendered_text",
    planned,
    covered,
    declared,
    missing,
    coveredBy,
    declaredBy,
    counts: {
      planned: planned.length,
      covered: covered.length,
      declared: declared.length,
      missing: missing.length,
    },
  };
}

function parseKeywordBulletMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(metadataRecord(value))) {
    const text = metadataText(val, 160);
    if (text) out[key] = text;
  }
  return out;
}

/**
 * Phase 3 — read the canonical voice-pass audit (VOICE-02) for an artifact from
 * the ``voice_pass_json`` projection column. Returns ``null`` when no voice pass
 * was recorded for this generation.
 */
function voicePassForArtifact(db: SqliteDatabase, row: ArtifactProjectionRow): VoicePassAudit | null {
  return parseVoicePass(provenanceSetColumnForArtifact(db, row, "voice_pass_json"));
}

function parseVoicePass(value: string | null): VoicePassAudit | null {
  if (!value || !value.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const record = metadataRecord(parsed);
  const proxyDelta = metadataRecord(record.proxy_delta);
  return {
    ran: record.ran === true,
    accepted: record.accepted === true,
    model: metadataText(record.model, 120) ?? "",
    promptVersion: metadataText(record.prompt_version, 64) ?? "",
    proxyDelta,
    reason: metadataText(record.reason, 600) ?? "",
  };
}

/**
 * Parse the non-coverage tailoring audit fields from an artifact's own
 * ``metadata_json`` (targetSeniority, safety, evidence, quality, judge,
 * adversarial review, annotated changes, models). Phase 4: this NO LONGER
 * computes the ``keywords`` coverage block — that is derived from the canonical
 * coverage audit by ``tailoringExplanationForArtifact``. The ``keywords`` /
 * ``bulletProvenance`` / ``coverageAudit`` / ``voicePass`` fields are returned
 * empty here and populated by the caller from canonical projection columns.
 */
function parseTailoringExplanation(value: string | null): ArtifactTailoringExplanation | null {
  const metadata = parseJsonRecord(value);
  if (!metadata) return null;

  const qualityPlan = metadataRecord(metadata.quality_plan);
  const requirementLedControls = metadataRecord(qualityPlan.requirement_led_controls);
  const autoApprovalPolicy = metadataRecord(requirementLedControls.auto_approval_policy);
  const requirementClaimPolicy = metadataText(requirementLedControls.claim_policy);
  const autoApprovableClaimLabels = metadataTextList(autoApprovalPolicy.auto_approvable_claim_labels);
  const legacyAllowAdjacentDrafts = metadataBoolean(qualityPlan.allow_adjacent_achievement_drafts);
  const qualityChecks = metadataRecord(metadata.quality_checks);
  const evidenceSupport = metadataRecord(qualityChecks.evidence_support);
  const judge = metadataRecord(metadata.judge);
  const adversarialReview = parseAdversarialReview(metadata.adversarial_review);
  const reviewFeedback = metadataRecord(metadata.review_feedback);
  const judgeMinScore = metadataNumber(metadata.judge_min_score);
  const qualityMessages = {
    errors: metadataTextList(qualityChecks.errors, 8, 220),
    warnings: metadataTextList(qualityChecks.warnings, 8, 220),
    notes: metadataTextList(qualityChecks.notes, 8, 220),
  };

  const explanation: ArtifactTailoringExplanation = {
    targetSeniority: metadataText(qualityPlan.target_seniority),
    claimMode:
      requirementClaimPolicy ??
      metadataText(qualityPlan.claim_mode),
    validationMode: metadataText(metadata.validation_mode),
    safety: {
      autoApprovableClaimModes:
        autoApprovableClaimLabels.length > 0
          ? autoApprovableClaimLabels
          : metadataTextList(qualityPlan.auto_approvable_claim_modes),
      allowAdjacentAchievementDrafts:
        legacyAllowAdjacentDrafts ??
        (requirementClaimPolicy === null
          ? null
          : requirementClaimPolicy === "draft_requires_confirmation"),
      qualityPassed: metadataBoolean(qualityChecks.passed),
    },
    // Phase 4: populated from the canonical coverage audit
    // (``coverage_audit_json``) by ``tailoringExplanationForArtifact`` — never
    // recomputed from the resume file / job description at read time.
    keywords: emptyKeywordsBlock(),
    evidence: {
      requiredIds: metadataTextList(qualityPlan.required_evidence_ids, 32),
      seniorityIds: metadataTextList(qualityPlan.seniority_evidence_ids, 32),
      representedIds: metadataTextList(evidenceSupport.represented_ids, 32),
      missingIds: metadataTextList(evidenceSupport.missing_ids, 32),
      verifiedMetricCount: metadataNumber(qualityPlan.verified_metric_count),
    },
    quality: {
      passed: metadataBoolean(qualityChecks.passed),
      errors: qualityMessages.errors,
      warnings: qualityMessages.warnings,
      notes: qualityMessages.notes,
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
    annotatedChanges: parseTailoringChangeAnnotations(metadata.change_annotations),
    // Phase 2/3: populated from canonical projection columns
    // (``bullet_provenance_json`` / ``coverage_audit_json`` / ``voice_pass_json``)
    // by ``tailoringExplanationForArtifact`` — never derived from ``metadata_json``.
    bulletProvenance: [],
    coverageAudit: null,
    voicePass: null,
    models: {
      candidateModels: metadataTextList(metadata.candidate_models, 6, 120),
      selectedModel: metadataText(metadata.selected_model, 120),
      selectedCandidate: metadataText(metadata.selected_candidate, 80),
      judgeModel: metadataText(metadata.judge_model, 120),
      attempts: metadataNumber(metadata.attempts),
    },
  };
  return explanation;
}

function missingTailoringAuditFields(explanation: ArtifactTailoringExplanation): string[] {
  const missing: string[] = [];
  if (!explanation.targetSeniority) missing.push("target seniority");
  if (!explanation.claimMode) missing.push("claim mode");
  if (!explanation.validationMode) missing.push("validation mode");
  if (!explanation.safety.autoApprovableClaimModes.length) missing.push("auto-approvable claim modes");
  if (explanation.safety.allowAdjacentAchievementDrafts === null) missing.push("adjacent draft policy");
  if (explanation.safety.qualityPassed === null && explanation.quality.passed === null) {
    missing.push("quality gate");
  }
  if (explanation.evidence.verifiedMetricCount === null) missing.push("verified metric count");
  if (!explanation.evidence.requiredIds.length && !explanation.evidence.seniorityIds.length) {
    missing.push("profile evidence mapping");
  }
  if (!explanation.annotatedChanges.length) missing.push("resume change annotations");
  if (explanation.judge.passed === null && !explanation.judge.verdict && explanation.judge.score === null) {
    missing.push("judge result");
  }
  if (explanation.judge.minScore === null) missing.push("judge threshold");
  if (!explanation.models.selectedModel) missing.push("selected model");
  if (!explanation.models.judgeModel) missing.push("judge model");
  if (!explanation.models.candidateModels.length) missing.push("candidate models");
  if (!explanation.models.selectedCandidate) missing.push("selected candidate");
  if (explanation.models.attempts === null) missing.push("attempt count");
  if (!explanation.adversarialReview) {
    missing.push("persona review");
  } else if (explanation.adversarialReview.ran) {
    if (!explanation.adversarialReview.personas.length) missing.push("persona judgments");
    if (!explanation.adversarialReview.audit?.promptMessages.length) missing.push("persona LLM request");
    if (!explanation.adversarialReview.audit?.response) missing.push("persona LLM response");
  }
  return missing;
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
    scoreRationale: metadataText(review.score_rationale ?? review.scoreRationale, 360),
    threshold: metadataNumber(review.threshold),
    blockers: metadataTextList(review.blockers, 8, 220),
    warnings: metadataTextList(review.warnings, 8, 220),
    repairInstructions: metadataTextList(review.repair_instructions, 8, 220),
    personas: Array.isArray(review.personas)
      ? review.personas.filter(isRecord).slice(0, 8).map(parseAdversarialPersona)
      : [],
    audit: parseAdversarialAudit(review.llm_audit ?? review.llmAudit),
    skippedReason: metadataText(review.skipped_reason, 180),
  };
}

function parseAdversarialPersona(
  persona: Record<string, unknown>,
): NonNullable<ArtifactTailoringExplanation["adversarialReview"]>["personas"][number] {
  const response = parseAdversarialPersonaResponse(persona.response, persona);
  return {
    persona: metadataText(persona.persona, 80) ?? "reviewer",
    verdict: metadataText(persona.verdict, 20),
    score: metadataNumber(persona.score),
    scoreRationale: metadataText(persona.score_rationale ?? persona.scoreRationale, 360),
    promptRubric: metadataText(persona.prompt_rubric ?? persona.promptRubric, 360),
    blockers: metadataTextList(persona.blockers, 8, 220),
    warnings: metadataTextList(persona.warnings, 8, 220),
    repairInstructions: metadataTextList(persona.repair_instructions, 8, 220),
    scoreBasis: metadataTextList(persona.score_basis ?? persona.scoreBasis, 8, 220),
    response,
  };
}

function parseAdversarialAudit(
  value: unknown,
): NonNullable<ArtifactTailoringExplanation["adversarialReview"]>["audit"] {
  const audit = metadataRecord(value);
  const rawPromptMessages = audit.prompt_messages ?? audit.promptMessages;
  const promptMessages = Array.isArray(rawPromptMessages)
    ? rawPromptMessages
        .filter(isRecord)
        .slice(0, 4)
        .flatMap((message) => {
          const role = metadataText(message.role, 40) ?? "user";
          const content = metadataPromptText(message.content, 2400);
          return content ? [{ role, content }] : [];
        })
    : [];
  const response = parseAdversarialResponse(audit.response);
  if (
    !promptMessages.length &&
    !response &&
    !metadataText(audit.model, 120) &&
    !metadataText(audit.schema_version ?? audit.schemaVersion, 120)
  ) {
    return null;
  }
  return {
    model: metadataText(audit.model, 120),
    schemaVersion: metadataText(audit.schema_version ?? audit.schemaVersion, 120),
    promptMessages,
    response,
  };
}

function parseAdversarialResponse(
  value: unknown,
): NonNullable<NonNullable<ArtifactTailoringExplanation["adversarialReview"]>["audit"]>["response"] {
  const response = metadataRecord(value);
  const personas = Array.isArray(response.personas)
    ? response.personas.filter(isRecord).slice(0, 8).map((persona) => ({
        verdict: metadataText(persona.verdict, 20),
        score: metadataNumber(persona.score),
        scoreRationale: metadataText(persona.score_rationale ?? persona.scoreRationale, 360),
        blockers: metadataTextList(persona.blockers, 8, 220),
        warnings: metadataTextList(persona.warnings, 8, 220),
        repairInstructions: metadataTextList(persona.repair_instructions, 8, 220),
      }))
    : [];
  const parsed = {
    verdict: metadataText(response.verdict, 20),
    score: metadataNumber(response.score),
    scoreRationale: metadataText(response.score_rationale ?? response.scoreRationale, 360),
    blockers: metadataTextList(response.blockers, 8, 220),
    warnings: metadataTextList(response.warnings, 8, 220),
    repairInstructions: metadataTextList(response.repair_instructions, 8, 220),
    personas,
  };
  if (
    !parsed.verdict &&
    parsed.score === null &&
    !parsed.scoreRationale &&
    !parsed.blockers.length &&
    !parsed.warnings.length &&
    !parsed.repairInstructions.length &&
    !parsed.personas.length
  ) {
    return null;
  }
  return parsed;
}

function parseAdversarialPersonaResponse(
  value: unknown,
  fallback: Record<string, unknown>,
): NonNullable<ArtifactTailoringExplanation["adversarialReview"]>["personas"][number]["response"] {
  const response = metadataRecord(value);
  const source = Object.keys(response).length ? response : fallback;
  const parsed = {
    verdict: metadataText(source.verdict, 20),
    score: metadataNumber(source.score),
    scoreRationale: metadataText(source.score_rationale ?? source.scoreRationale, 360),
    blockers: metadataTextList(source.blockers, 8, 220),
    warnings: metadataTextList(source.warnings, 8, 220),
    repairInstructions: metadataTextList(source.repair_instructions, 8, 220),
  };
  return parsed.verdict ||
    parsed.score !== null ||
    parsed.scoreRationale ||
    parsed.blockers.length ||
    parsed.warnings.length ||
    parsed.repairInstructions.length
    ? parsed
    : null;
}

function parseTailoringChangeAnnotations(
  value: unknown,
): ArtifactTailoringExplanation["annotatedChanges"] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(0, 12).map((item) => ({
    section: metadataText(item.section, 80) ?? "resume",
    label: metadataText(item.label, 120) ?? "Resume change",
    changeType: metadataText(item.change_type ?? item.changeType, 80) ?? "tailored",
    sourceId: metadataText(item.source_id ?? item.sourceId, 120),
    sourceText: metadataTextList(item.source_text ?? item.sourceText, 8, 360),
    tailoredText: metadataTextList(item.tailored_text ?? item.tailoredText, 8, 360),
    rationale: metadataText(item.rationale, 360),
    jobSignals: metadataKeywordList(item.job_signals ?? item.jobSignals, 8),
    controls: metadataTextList(item.controls, 10, 180),
    evidenceIds: metadataTextList(item.evidence_ids ?? item.evidenceIds, 12, 120),
    evidenceNotes: metadataTextList(item.evidence_notes ?? item.evidenceNotes, 8, 220),
  }));
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

function metadataPromptText(value: unknown, maxLength = 1800): string | null {
  if (value === null || value === undefined || typeof value === "object") return null;
  const normalized = String(value)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized || normalized === "null" || normalized === "undefined") return null;
  const redacted = normalized.replace(
    /(api[_-]?key|password|secret|token|bearer)\s*[:=]\s*\S+/gi,
    "$1: [redacted]",
  );
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
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

function rowToArtifactSummary(row: ArtifactProjectionRow, db?: SqliteDatabase): ArtifactSummary {
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
    resumeTemplate: db
      ? resumeTemplateStateForArtifact(db, row.job_id, row.metadata_json)
      : null,
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

/**
 * Minimum applied-count (sample size) a bucket needs before its conversion rates
 * are statistically meaningful. Below this, every rate is suppressed to ``null``
 * while the raw counts stay visible, so a single reply on a single application no
 * longer renders as a "100%" response rate.
 *
 * Owner-tunable. The default of 5 mirrors the sample-gating precedent elsewhere in
 * the read model — ``recommendedState`` in ``projections.ts`` (and its Python twin
 * in ``source_quality.py``) only acts on a source once ``sample >= 10``. Conversion
 * uses a lower floor because applied volume accrues far more slowly than the
 * discovery volume that gates source quality.
 */
export const MIN_CONVERSION_SAMPLE = 5;

/**
 * Derive the dashboard conversion section from the materialised
 * ``outcome_conversion_json`` counts. Rates are computed here (not stored) so the
 * cross-runtime projection stays integer-only; ``costPerInterview`` stays null
 * until per-run apply cost is projected into the read model (follow-up). Buckets
 * below ``MIN_CONVERSION_SAMPLE`` applied keep their raw counts but report ``null``
 * rates (see ``conversionRate``).
 */
function buildConversionSummary(json: string): DashboardSummary["conversion"] {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(json || "{}");
  } catch {
    parsed = {};
  }
  const record = isRecord(parsed) ? parsed : {};
  const bySource = Array.isArray(record.bySource) ? record.bySource : [];
  const byBand = Array.isArray(record.byBand) ? record.byBand : [];
  return {
    totals: conversionFunnelMetrics(record.totals),
    bySource: bySource.filter(isRecord).map((group) => ({
      source: String(group.source ?? "unknown"),
      ...conversionFunnelMetrics(group),
    })),
    byBand: byBand.filter(isRecord).map((group) => ({
      band: String(group.band ?? "unscored"),
      ...conversionFunnelMetrics(group),
    })),
  };
}

function buildOutcomeAnalyticsFromConversion(
  json: string,
  generatedAt: string,
): OutcomeAnalyticsSummary {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(json || "{}");
  } catch {
    parsed = {};
  }
  const record = isRecord(parsed) ? parsed : {};
  const bySource = Array.isArray(record.bySource) ? record.bySource : [];
  const byBand = Array.isArray(record.byBand) ? record.byBand : [];
  const byFitBand = Array.isArray(record.byFitBand) ? record.byFitBand : [];
  const byApplyMode = Array.isArray(record.byApplyMode) ? record.byApplyMode : [];
  const byTemplate = Array.isArray(record.byTemplate) ? record.byTemplate : [];
  const byPolicy = Array.isArray(record.byPolicy) ? record.byPolicy : [];
  return {
    ok: true,
    generatedAt,
    minSample: MIN_CONVERSION_SAMPLE,
    totals: outcomeAnalyticsMetrics(record.totals),
    bySource: bySource.filter(isRecord).map((group) => ({
      source: String(group.source ?? "unknown"),
      ...outcomeAnalyticsMetrics(group),
    })),
    byScoreBand: byBand.filter(isRecord).map((group) => ({
      scoreBand: outcomeAnalyticsScoreBand(group.band),
      ...outcomeAnalyticsMetrics(group),
    })),
    byFitBand: byFitBand.filter(isRecord).map((group) => ({
      fitBand: outcomeAnalyticsFitBand(group.fitBand),
      ...outcomeAnalyticsMetrics(group),
    })),
    byApplyMode: byApplyMode.filter(isRecord).map((group) => ({
      applyMode: outcomeAnalyticsApplyMode(group.applyMode),
      ...outcomeAnalyticsMetrics(group),
    })),
    byTemplate: byTemplate.filter(isRecord).map((group) => ({
      templateId: String(group.templateId ?? "unreported"),
      templateName: nullableString(group.templateName),
      ...outcomeAnalyticsMetrics(group),
    })),
    byPolicy: byPolicy.filter(isRecord).map((group) => {
      const tailoringPolicyVersion = nullableNumber(group.tailoringPolicyVersion);
      return {
        tailoringPolicyVersion,
        policyLabel: String(group.policyLabel ?? policyLabel(tailoringPolicyVersion)),
        ...outcomeAnalyticsMetrics(group),
      };
    }),
    timeToResponse: outcomeAnalyticsTimeToResponse(record.timeToResponseMinutes),
    suggestionAccuracy: outcomeAnalyticsSuggestionAccuracy(record.suggestionAccuracy),
  };
}

function outcomeAnalyticsMetrics(value: unknown): OutcomeAnalyticsSummary["totals"] {
  const metrics = conversionFunnelMetrics(value);
  return {
    n: metrics.applied,
    applied: metrics.applied,
    reply: metrics.reply,
    interview: metrics.interview,
    offer: metrics.offer,
    rejection: metrics.rejection,
    replyRate: metrics.replyRate,
    interviewRate: metrics.interviewRate,
    offerRate: metrics.offerRate,
    rejectionRate: metrics.rejectionRate,
  };
}

function outcomeAnalyticsScoreBand(value: unknown): OutcomeAnalyticsSummary["byScoreBand"][number]["scoreBand"] {
  const band = String(value ?? "unscored");
  if (["perfect", "strong", "moderate", "weak", "poor", "unscored"].includes(band)) {
    return band as OutcomeAnalyticsSummary["byScoreBand"][number]["scoreBand"];
  }
  return "unscored";
}

function outcomeAnalyticsFitBand(value: unknown): OutcomeAnalyticsSummary["byFitBand"][number]["fitBand"] {
  const band = String(value ?? "unreported");
  if (["excellent", "strong", "plausible", "stretch", "poor", "unreported"].includes(band)) {
    return band as OutcomeAnalyticsSummary["byFitBand"][number]["fitBand"];
  }
  return "unreported";
}

function outcomeAnalyticsApplyMode(value: unknown): OutcomeAnalyticsSummary["byApplyMode"][number]["applyMode"] {
  const mode = String(value ?? "manual_marked");
  if (["automated_live", "manual_marked", "external_confirmed"].includes(mode)) {
    return mode as OutcomeAnalyticsSummary["byApplyMode"][number]["applyMode"];
  }
  return "manual_marked";
}

function outcomeAnalyticsTimeToResponse(value: unknown): OutcomeAnalyticsSummary["timeToResponse"] {
  const samples = Array.isArray(value)
    ? value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item >= 0)
    : [];
  return {
    n: samples.length,
    medianMinutes: samples.length >= MIN_CONVERSION_SAMPLE ? median(samples) : null,
  };
}

function outcomeAnalyticsSuggestionAccuracy(value: unknown): OutcomeAnalyticsSummary["suggestionAccuracy"] {
  const counts = isRecord(value) ? value : {};
  const decided = Number(counts.decided ?? 0);
  const accepted = Number(counts.accepted ?? 0);
  const corrected = Number(counts.corrected ?? 0);
  const ignored = Number(counts.ignored ?? 0);
  return {
    n: decided,
    decided,
    accepted,
    corrected,
    ignored,
    acceptanceRate: conversionRate(accepted, decided),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function policyLabel(version: number | null): string {
  return version === null ? "Unreported" : `Policy v${version}`;
}

function conversionFunnelMetrics(value: unknown): DashboardConversionFunnel {
  const counts = isRecord(value) ? value : {};
  const applied = Number(counts.applied ?? 0);
  const reply = Number(counts.reply ?? 0);
  const interview = Number(counts.interview ?? 0);
  const offer = Number(counts.offer ?? 0);
  const rejection = Number(counts.rejection ?? 0);
  return {
    applied,
    reply,
    interview,
    offer,
    rejection,
    replyRate: conversionRate(reply, applied),
    interviewRate: conversionRate(interview, applied),
    offerRate: conversionRate(offer, applied),
    rejectionRate: conversionRate(rejection, applied),
    costPerInterview: null,
  };
}

function conversionRate(numerator: number, applied: number): number | null {
  if (applied < MIN_CONVERSION_SAMPLE) return null;
  return Math.round((numerator / applied) * 10000) / 10000;
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
    outcome_conversion_json: "{}",
    generated_at: "",
  };
}

function listSourceHealth(db: SqliteDatabase): DashboardSummary["sourceHealth"] {
  const operationalBySource = operationalSourceRollups(db);
  const politenessBySource = politenessOutcomesBySource(db);
  const seen = new Set<string>();
  if (!tableExists(db, "source_quality_stats")) {
    return [...operationalBySource.values()].map((source) =>
      sourceRollupToHealth(source, politenessBySource.get(source.sourceId ?? source.key)),
    );
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
      politeness: politenessBySource.get(row.source_id) ?? emptyPolitenessOutcomes(),
      updatedAt: row.updated_at,
    };
  });
  for (const source of operationalBySource.values()) {
    if (!source.sourceId || seen.has(source.sourceId)) continue;
    sourceHealth.push(sourceRollupToHealth(source, politenessBySource.get(source.sourceId)));
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

function sourceRollupToHealth(
  source: OperationalRollup,
  politeness: SourcePolitenessOutcomes | undefined,
): DashboardSummary["sourceHealth"][number] {
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
    politeness: politeness ?? emptyPolitenessOutcomes(),
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
  return rows.map((row) => rowToArtifactSummary(row, db)).filter((artifact) => !isSuppressedArtifactStatus(artifact.status));
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
    discoveredSince: undefined,
    scoredSince: undefined,
  };
}

function jobSqlFilter(db: SqliteDatabase, query: JobListQuery): { where: string; params: SqliteValue[] } {
  const clauses: string[] = ["tenant_id = ?"];
  const params: SqliteValue[] = [DEFAULT_TENANT];
  const hasHiddenTable = tableExists(db, "jobctrl_hidden_jobs");
  const closedPredicate = closedActiveStatePredicate(
    db,
    "job_list_projections.tenant_id",
    "job_list_projections.job_id",
  );
  if (query.deleted === "active") {
    clauses.push("deleted_at IS NULL");
    if (hasHiddenTable) {
      clauses.push("NOT EXISTS (SELECT 1 FROM jobctrl_hidden_jobs h WHERE h.job_url = job_id AND h.unhidden_at IS NULL)");
    }
    if (closedPredicate) {
      clauses.push(`NOT (${closedPredicate.sql})`);
      params.push(...closedPredicate.params);
    }
  } else if (query.deleted === "closed") {
    clauses.push("deleted_at IS NULL");
    if (hasHiddenTable) {
      clauses.push("NOT EXISTS (SELECT 1 FROM jobctrl_hidden_jobs h WHERE h.job_url = job_id AND h.unhidden_at IS NULL)");
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
      clauses.push("NOT EXISTS (SELECT 1 FROM jobctrl_hidden_jobs h WHERE h.job_url = job_id AND h.unhidden_at IS NULL)");
    }
  } else if (query.deleted === "hidden") {
    clauses.push(
      hasHiddenTable
        ? "EXISTS (SELECT 1 FROM jobctrl_hidden_jobs h WHERE h.job_url = job_id AND h.unhidden_at IS NULL)"
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
  if (query.discoveredSince && query.scoredSince) {
    clauses.push(
      "((discovered_at IS NOT NULL AND discovered_at >= ?) OR (scored_at IS NOT NULL AND scored_at >= ?))",
    );
    params.push(query.discoveredSince, query.scoredSince);
  } else if (query.discoveredSince) {
    clauses.push("discovered_at IS NOT NULL AND discovered_at >= ?");
    params.push(query.discoveredSince);
  } else if (query.scoredSince) {
    clauses.push("scored_at IS NOT NULL AND scored_at >= ?");
    params.push(query.scoredSince);
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
  const hiddenSelect = tableExists(db, "jobctrl_hidden_jobs")
    ? `(SELECT h.hidden_at
          FROM jobctrl_hidden_jobs h
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
             JOIN jobs j
               ON j.tenant_id = o.tenant_id
              AND j.job_id = o.job_id
            WHERE o.tenant_id = job_list_projections.tenant_id
              AND j.url = job_list_projections.job_id
            ORDER BY o.observed_at DESC, o.source_observation_id DESC
            LIMIT 1)`;
}

function postingSourceUrlSqlExpression(db: SqliteDatabase): string {
  if (!tableExists(db, "job_canonical_identities")) return "NULL";
  return `(SELECT c.canonical_url
             FROM job_canonical_identities c
             JOIN jobs j
               ON j.tenant_id = c.tenant_id
              AND j.job_id = c.job_id
            WHERE c.tenant_id = job_list_projections.tenant_id
              AND j.url = job_list_projections.job_id
            LIMIT 1)`;
}

function postingSourceAtsKindSqlExpression(db: SqliteDatabase): string {
  if (!tableExists(db, "job_canonical_identities")) return "NULL";
  return `(SELECT c.ats_kind
             FROM job_canonical_identities c
             JOIN jobs j
               ON j.tenant_id = c.tenant_id
              AND j.job_id = c.job_id
            WHERE c.tenant_id = job_list_projections.tenant_id
              AND j.url = job_list_projections.job_id
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
    discoveredSince: query.discoveredSince ?? null,
    scoredSince: query.scoredSince ?? null,
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
  if (query.discoveredSince && query.scoredSince) {
    const discoveredMatches = timestampAtOrAfter(job.discoveredAt, query.discoveredSince);
    const scoredMatches = timestampAtOrAfter(job.scoredAt, query.scoredSince);
    if (!discoveredMatches && !scoredMatches) return false;
  } else {
    if (query.discoveredSince && !timestampAtOrAfter(job.discoveredAt, query.discoveredSince)) return false;
    if (query.scoredSince && !timestampAtOrAfter(job.scoredAt, query.scoredSince)) return false;
  }
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

function timestampAtOrAfter(value: string | null | undefined, since: string): boolean {
  if (!value) return false;
  const valueTime = Date.parse(value);
  const sinceTime = Date.parse(since);
  return Number.isFinite(valueTime) && Number.isFinite(sinceTime) && valueTime >= sinceTime;
}

function timestampBefore(value: string | null | undefined, before: string): boolean {
  if (!value) return false;
  const valueTime = Date.parse(value);
  const beforeTime = Date.parse(before);
  return Number.isFinite(valueTime) && Number.isFinite(beforeTime) && valueTime < beforeTime;
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
    source: [jobSourceSortValue(left), jobSourceSortValue(right)],
    compensation_min_eur: [
      postedCompensationAmountEur(left.compensationSummary, "min"),
      postedCompensationAmountEur(right.compensationSummary, "min"),
    ],
    compensation_max_eur: [
      postedCompensationAmountEur(left.compensationSummary, "max"),
      postedCompensationAmountEur(right.compensationSummary, "max"),
    ],
    compensation_posted: [
      postedCompensationSortValue(left.compensationSummary, left.salary),
      postedCompensationSortValue(right.compensationSummary, right.salary),
    ],
    compensation_market: [
      marketCompensationSortValue(left.compensationSummary),
      marketCompensationSortValue(right.compensationSummary),
    ],
    compensation_confidence: [
      marketConfidenceSortValue(left.compensationSummary),
      marketConfidenceSortValue(right.compensationSummary),
    ],
    compensation_warnings: [
      left.compensationSummary?.warningCount ?? 0,
      right.compensationSummary?.warningCount ?? 0,
    ],
    location: [left.location, right.location],
    fit_score: [left.fitScore ?? -1, right.fitScore ?? -1],
    current_stage: [left.currentStage, right.currentStage],
    current_state: [
      `${STATE_RANK[left.currentState] ?? 999}:${left.currentSubstage}`,
      `${STATE_RANK[right.currentState] ?? 999}:${right.currentSubstage}`,
    ],
    apply_status: [left.applyStatus ?? "", right.applyStatus ?? ""],
  };
  const [leftValue, rightValue] = values[field] ?? values.discovered_at!;
  const compared = compareValues(leftValue, rightValue);
  return compared ? compared * multiplier : left.jobKey.localeCompare(right.jobKey);
}

function jobSourceSortValue(job: JobSummary): string {
  return (job.postingSource || job.discoverySource || job.source || "").toLowerCase();
}

function postedCompensationSortValue(
  summary: JobCompensationSummary | null,
  fallbackSalary: string,
): number {
  const amount = postedCompensationAmountEur(summary, "min");
  if (amount !== null) return amount;
  if (summary?.posted.displayRange || summary?.legacyRawSalary || fallbackSalary) return -1;
  if (summary?.posted.parseState === "ambiguous") return -2;
  if (summary?.posted.parseState === "unparseable") return -3;
  if (summary?.posted.parseState === "missing") return -4;
  return Number.NEGATIVE_INFINITY;
}

function postedCompensationAmountEur(
  summary: JobCompensationSummary | null,
  bound: "min" | "max",
): number | null {
  const range = summary?.posted.range;
  return compensationRangeAmountEur(range, bound);
}

function marketCompensationSortValue(summary: JobCompensationSummary | null): number {
  const amount = compensationRangeAmountEur(summary?.market.range ?? null, "min");
  if (amount !== null) return amount;
  switch (summary?.market.estimateState) {
    case "estimated_range":
      return -1;
    case "insufficient_evidence":
      return -2;
    case "source_unavailable":
      return -3;
    case "unsupported":
      return -4;
    case "not_requested":
    default:
      return Number.NEGATIVE_INFINITY;
  }
}

function marketConfidenceSortValue(summary: JobCompensationSummary | null): number {
  const market = summary?.market;
  if (!market || market.recordStatus === "not_requested") return Number.NEGATIVE_INFINITY;
  if (Number.isFinite(market.confidenceScore)) return Number(market.confidenceScore);
  switch (market.confidenceBand) {
    case "high":
      return 0.9;
    case "medium":
      return 0.62;
    case "low":
      return 0.3;
    case "none":
      return 0;
  }
}

function compensationRangeAmountEur(
  range: JobCompensationSummary["posted"]["range"] | null | undefined,
  bound: "min" | "max",
): number | null {
  const normalized = bound === "min" ? range?.annualizedMinimumEur : range?.annualizedMaximumEur;
  if (Number.isFinite(normalized)) return Number(normalized);
  if (range?.currency?.toUpperCase() !== "EUR") return null;
  const annualized = bound === "min" ? range.annualizedMinimumAmount : range.annualizedMaximumAmount;
  if (Number.isFinite(annualized)) return Number(annualized);
  if (range.period !== "year") return null;
  const source = bound === "min" ? range.minimumAmount : range.maximumAmount;
  return Number.isFinite(source) ? Number(source) : null;
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
  const workflowRunStatus = loadPipelineWorkflowRunStatus(db);
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
      byStage.set(stage, progressWithWorkflowStatus(progress, workflowRunStatus));
    }
  }
  return [...byStage.values()];
}

interface PipelineWorkflowRunStatus {
  status: string;
  errorMessage: string | null;
  finishedAt: string | null;
}

function loadPipelineWorkflowRunStatus(db: SqliteDatabase): Map<string, PipelineWorkflowRunStatus> {
  if (!tableExists(db, "workflow_run_projections")) {
    return new Map();
  }
  const lifecycleFolds = loadWorkflowRunLifecycleFolds(db);
  const rows = allRows<{
    workflow_id: string;
    status: string;
    error_message: string | null;
    finished_at: string | null;
  }>(
    db,
    `SELECT workflow_id, status, error_message, finished_at
       FROM workflow_run_projections
      WHERE tenant_id = ?`,
    [DEFAULT_TENANT],
  );
  return new Map(
    rows.map((row) => {
      const fold = lifecycleFolds.get(row.workflow_id);
      return [
        row.workflow_id,
        {
          status: normalizeWorkflowRunStatus(fold ? fold.status : row.status),
          errorMessage: fold ? fold.errorMessage : nullableString(row.error_message),
          finishedAt: fold ? fold.finishedAt : nullableString(row.finished_at),
        },
      ];
    }),
  );
}

function progressWithWorkflowStatus(
  progress: DashboardSummary["progress"][number],
  workflowRunStatus: Map<string, PipelineWorkflowRunStatus>,
): DashboardSummary["progress"][number] {
  const workflowId = progress.workflowId || progress.runId;
  let workflow = workflowId ? workflowRunStatus.get(workflowId) : undefined;
  if (!workflow && progress.stage === "discover") {
    // Discover progress events emitted on the Temporal path may carry only a
    // per-source discovery run id (`discovery:<family>:<hex>`), never the
    // owning workflow id — which is deterministic per tenant. Without this
    // fallback the discover card can keep reporting a stale mid-crawl
    // percentage (the incident's frozen "running 67%") after the workflow
    // itself terminalized.
    workflow = workflowRunStatus.get(`discover-${DEFAULT_TENANT}`);
  }
  if (!workflow) {
    return progress;
  }
  const status = pipelineProgressStatusForWorkflow(workflow.status);
  if (!status) {
    return progress;
  }
  if (progressIsNewerThanTerminal(progress.updatedAt, workflow.finishedAt)) {
    return progress;
  }
  const message = workflow.errorMessage
    ? `Workflow ${workflow.status}: ${workflow.errorMessage}`
    : `Workflow ${workflow.status}`;
  const workflowSucceeded = status === "succeeded";
  const preservePartialWarning = workflowSucceeded && progress.status === "partial";
  return {
    ...progress,
    status: preservePartialWarning ? "partial" : status,
    percent: workflowSucceeded ? 100 : progress.percent,
    completed: workflowSucceeded ? progress.total : progress.completed,
    message: preservePartialWarning ? progress.message || message : message,
    updatedAt: workflow.finishedAt ?? progress.updatedAt,
  };
}

// Workflow ids are reused across executions (discover-{tenant}, apply-{jobKey})
// and workflow_run_projections keeps the prior execution's terminal state until
// the new run's WorkflowStarted folds in. Stage activity recorded after
// finished_at can only belong to a newer live execution, so a stale terminal
// must not override it.
function progressIsNewerThanTerminal(
  progressUpdatedAt: string | null | undefined,
  workflowFinishedAt: string | null,
): boolean {
  if (!progressUpdatedAt || !workflowFinishedAt) {
    return false;
  }
  const progressMs = Date.parse(progressUpdatedAt);
  const finishedMs = Date.parse(workflowFinishedAt);
  if (Number.isNaN(progressMs) || Number.isNaN(finishedMs)) {
    return false;
  }
  return progressMs > finishedMs;
}

function pipelineProgressStatusForWorkflow(
  status: string,
): DashboardSummary["progress"][number]["status"] | null {
  if (status === "starting" || status === "in_progress") {
    return null;
  }
  if (status === "succeeded" || status === "dry_run_complete") {
    return "succeeded";
  }
  return "failed";
}

const COMPLETE_STAGE_MESSAGES = new Set(["stage ok", "stage partial", "stage skipped"]);
const DISCOVERY_SOURCE_PROGRESS = [
  ["jobspy", "Broad boards"],
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
  const recoveredUnitsValue = Object.hasOwn(detail, "recoveredUnits")
    ? detail.recoveredUnits
    : detail.recovered_units;
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
      ...(recoveredUnitsValue !== undefined
        ? { recoveredUnits: nullableNumber(recoveredUnitsValue) }
        : {}),
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
  const hideDeletedJoin = tableExists(db, "jobctrl_deleted_jobs")
    ? " LEFT JOIN jobctrl_deleted_jobs d ON d.job_url = e.job_url AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
    : "";
  const hideHiddenJoin = tableExists(db, "jobctrl_hidden_jobs")
    ? " LEFT JOIN jobctrl_hidden_jobs h ON h.job_url = e.job_url AND h.unhidden_at IS NULL"
    : "";
  const activityClauses = [
    "(e.job_url IS NULL OR e.job_url = '' OR jp.job_id IS NOT NULL)",
    tableExists(db, "jobctrl_deleted_jobs") ? "d.job_url IS NULL" : "",
    tableExists(db, "jobctrl_hidden_jobs") ? "h.job_url IS NULL" : "",
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
  const hideDeletedJoin = tableExists(db, "jobctrl_deleted_jobs")
    ? " LEFT JOIN jobctrl_deleted_jobs d ON d.job_url = e.job_url AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
    : "";
  const hideHiddenJoin = tableExists(db, "jobctrl_hidden_jobs")
    ? " LEFT JOIN jobctrl_hidden_jobs h ON h.job_url = e.job_url AND h.unhidden_at IS NULL"
    : "";
  const activityClauses = [
    "e.event_id = ?",
    "(e.job_url IS NULL OR e.job_url = '' OR jp.job_id IS NOT NULL)",
    tableExists(db, "jobctrl_deleted_jobs") ? "d.job_url IS NULL" : "",
    tableExists(db, "jobctrl_hidden_jobs") ? "h.job_url IS NULL" : "",
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
 * Read-side re-fold of the `Workflow*` lifecycle stream (truthfulness backstop).
 *
 * `workflow_run_projections` is materialised by the Python `ProjectionBuilder`,
 * whose fold is *globally* first-terminal-wins: once a run is terminal it drops
 * later `Workflow*` events, and a `WorkflowStarted` only regresses `status` to
 * `in_progress` when the run is not already terminal — yet it always advances
 * `started_at`. When a NEW Temporal execution reuses a `workflowId` whose prior
 * execution already terminalized (e.g. the reconciler closed `discover-local`
 * with `reconciled_not_found`, then the pipeline restarts under the same id),
 * that guard freezes the stored row on the OLD run's terminal outcome while
 * `started_at` jumps to the new run — a chimera the API would otherwise serve.
 *
 * The read model re-derives the current execution's real verdict from the
 * canonical `job_events` here with *run-scoped* precedence:
 *   - a `WorkflowStarted` for a run that is not already open begins a fresh
 *     execution and clears the prior run's terminal error/finish;
 *   - duplicate start markers for an open run are idempotent (keep `startedAt`);
 *   - first-terminal-wins holds only *within* an open run, so a reconciler
 *     `describe` COMPLETED racing a finalize `WorkflowFailed` cannot flip the
 *     verdict (preserves the M-1 backstop).
 * Runs with no `Workflow*` events (legacy seeds) fall back to the stored row.
 */
const WORKFLOW_LIFECYCLE_EVENT_TYPES = [
  "WorkflowStarted",
  "WorkflowCompleted",
  "WorkflowFailed",
  "WorkflowCanceled",
  "WorkflowTimedOut",
  "WorkflowTerminated",
] as const;

const WORKFLOW_TERMINAL_STATUS_BY_EVENT: Record<string, WorkflowRunStatus> = {
  WorkflowCompleted: "succeeded",
  WorkflowFailed: "failed",
  WorkflowCanceled: "canceled",
  WorkflowTimedOut: "timed_out",
  WorkflowTerminated: "terminated",
};

interface WorkflowLifecycleFold {
  status: WorkflowRunStatus;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

interface WorkflowLifecycleEvent {
  eventType: string;
  occurredAt: string | null;
  payload: Record<string, unknown>;
}

function loadWorkflowRunLifecycleFolds(db: SqliteDatabase): Map<string, WorkflowLifecycleFold> {
  const folds = new Map<string, WorkflowLifecycleFold>();
  if (!tableExists(db, "job_events")) {
    return folds;
  }
  const placeholders = WORKFLOW_LIFECYCLE_EVENT_TYPES.map(() => "?").join(", ");
  const rows = allRows<{ event_type: string; occurred_at: string | null; payload_json: string | null }>(
    db,
    `SELECT event_type, occurred_at, payload_json
       FROM job_events
      WHERE event_type IN (${placeholders})
      ORDER BY event_id ASC`,
    [...WORKFLOW_LIFECYCLE_EVENT_TYPES],
  );
  const byWorkflow = new Map<string, WorkflowLifecycleEvent[]>();
  for (const row of rows) {
    const payload = parseJsonRecord(row.payload_json);
    if (!payload) {
      continue;
    }
    const workflowId = stringField(payload.workflowId ?? payload.workflow_id);
    if (!workflowId) {
      continue;
    }
    const events = byWorkflow.get(workflowId) ?? [];
    events.push({ eventType: row.event_type, occurredAt: nullableString(row.occurred_at), payload });
    byWorkflow.set(workflowId, events);
  }
  for (const [workflowId, events] of byWorkflow) {
    folds.set(workflowId, foldWorkflowRunEvents(events));
  }
  return folds;
}

function workflowLifecycleRunId(payload: Record<string, unknown>): string | null {
  return nullableString(payload.temporalRunId ?? payload.temporal_run_id);
}

/**
 * Mirror of the Python writer's `_starts_new_execution` guard: a
 * `WorkflowStarted` reopens a terminalized fold only when it belongs to a NEW
 * Temporal execution. When both sides carry a run id, a differing id is
 * authoritative (so a late-replayed duplicate start for the SAME run can never
 * un-terminalize it); with run ids absent, fall back to wall-clock ordering.
 */
function startsNewWorkflowExecution(args: {
  foldedRunId: string | null;
  foldedFinishedAt: string | null;
  eventRunId: string | null;
  eventOccurredAt: string | null;
}): boolean {
  if (args.eventRunId && args.foldedRunId) {
    return args.eventRunId !== args.foldedRunId;
  }
  const started = args.eventOccurredAt ? Date.parse(args.eventOccurredAt) : Number.NaN;
  const finished = args.foldedFinishedAt ? Date.parse(args.foldedFinishedAt) : Number.NaN;
  if (Number.isNaN(started) || Number.isNaN(finished)) {
    return false;
  }
  return started > finished;
}

function foldWorkflowRunEvents(events: readonly WorkflowLifecycleEvent[]): WorkflowLifecycleFold {
  let phase: "none" | "in_progress" | "terminal" = "none";
  let status: WorkflowRunStatus = "in_progress";
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let retryable = false;
  let startedAt: string | null = null;
  let finishedAt: string | null = null;
  let durationMs: number | null = null;
  let runId: string | null = null;

  for (const event of events) {
    const payload = event.payload;
    if (event.eventType === "WorkflowStarted") {
      const eventRunId = workflowLifecycleRunId(payload);
      const eventStartedAt = nullableString(payload.startedAt) ?? event.occurredAt;
      const recoversMissingHistory =
        phase === "terminal" &&
        status === "terminated" &&
        errorCode === "reconciled_not_found" &&
        payload.recoveredFromMissingHistory === true &&
        eventRunId !== null &&
        eventRunId === runId;
      // A start carrying a NEW run id while the fold is still open means the
      // previous execution died without a recorded terminal (Temporal id reuse
      // only admits a new run once the old one closed server-side); the fold
      // must adopt the live execution — Python fold parity.
      const adoptsNewExecution =
        phase === "in_progress" && eventRunId !== null && runId !== null && eventRunId !== runId;
      const reopens =
        phase === "none" ||
        adoptsNewExecution ||
        recoversMissingHistory ||
        (phase === "terminal" &&
          startsNewWorkflowExecution({
            foldedRunId: runId,
            foldedFinishedAt: finishedAt,
            eventRunId,
            // Parity with Python _starts_new_execution: the wall-clock
            // fallback compares the event's occurredAt (record time), never
            // payload.startedAt.
            eventOccurredAt: event.occurredAt,
          }));
      if (reopens) {
        status = "in_progress";
        errorCode = null;
        errorMessage = null;
        retryable = false;
        finishedAt = null;
        durationMs = null;
        startedAt = eventStartedAt ?? startedAt;
        runId = eventRunId;
        phase = "in_progress";
      } else if (phase === "in_progress" && !runId && eventRunId) {
        // A duplicate start for the open run may carry the id the first lacked.
        runId = eventRunId;
      }
      continue;
    }
    const terminalStatus = WORKFLOW_TERMINAL_STATUS_BY_EVENT[event.eventType];
    if (!terminalStatus || phase === "terminal") {
      continue;
    }
    const terminalRunId = workflowLifecycleRunId(payload);
    // Run-scoped in the terminal direction too: a late terminal from a
    // superseded execution (the reconciler closing a dead run after a newer
    // WorkflowStarted already folded) must not clobber the live run.
    if (terminalRunId && runId && terminalRunId !== runId) {
      continue;
    }
    status = terminalStatus;
    phase = "terminal";
    finishedAt = nullableString(payload.finishedAt) ?? event.occurredAt ?? finishedAt;
    durationMs = nullableNumber(payload.durationMs) ?? durationMs;
    errorCode = nullableString(payload.errorCode) ?? errorCode;
    errorMessage = nullableString(payload.errorMessage ?? payload.message) ?? errorMessage;
    retryable = "retryable" in payload ? Boolean(payload.retryable) : retryable;
    runId = terminalRunId ?? runId;
  }
  return { status, errorCode, errorMessage, retryable, startedAt, finishedAt, durationMs };
}

function applyWorkflowLifecycleFold(
  row: WorkflowRunProjectionRow,
  fold: WorkflowLifecycleFold | undefined,
): WorkflowRunProjectionRow {
  if (!fold) {
    return row;
  }
  return {
    ...row,
    status: fold.status,
    error_code: fold.errorCode,
    error_message: fold.errorMessage,
    retryable: fold.retryable ? 1 : 0,
    started_at: fold.startedAt,
    finished_at: fold.finishedAt,
    duration_ms: fold.durationMs,
  };
}

/**
 * Workflow Runs view source (Temporal loop closure — P0).
 *
 * Reads the unified `workflow_run_projections` table (materialised by the
 * Python `ProjectionBuilder` from the `Workflow*` lifecycle events) so every
 * workflow type — pipeline orchestrator, apply, and future workflows — appears
 * in one list, then re-folds each row's lifecycle from `job_events` (see
 * `loadWorkflowRunLifecycleFolds`) so a stale terminal outcome from a superseded
 * execution never leaks onto a run the current execution has restarted.
 * Apply rows are enriched with job context via a LEFT JOIN to
 * `apply_run_projections` (the apply-specific detail projection); non-apply
 * rows show their workflow type instead of a job title. The `runId` equals
 * the Temporal `workflow_id`, so the Temporal Web UI deep-link uses it
 * verbatim.
 */
export function listWorkflowRuns(
  db: SqliteDatabase,
  query: WorkflowRunsListQuery,
): PaginatedResponse<WorkflowRunSummary> {
  refreshProjections(db, DEFAULT_TENANT);
  if (!tableExists(db, "workflow_run_projections")) {
    return paginate([], query.page, query.pageSize, query.sort, query.dir, workflowRunsFilterPayload(query));
  }
  const hasApply = tableExists(db, "apply_run_projections");
  const applyJoin = hasApply
    ? ` LEFT JOIN apply_run_projections arp ON arp.run_id = wrp.workflow_id`
    : "";
  const applySelect = hasApply
    ? `, arp.job_id AS apply_job_id, arp.job_title AS job_title,
       arp.job_employer AS job_employer, arp.dry_run AS apply_dry_run,
       arp.model AS apply_model, arp.result AS apply_result`
    : "";
  // Deleted / hidden filters apply to the enriched apply job only; non-apply
  // rows have a NULL apply_job_id and pass through untouched.
  const deletedJoin =
    hasApply && tableExists(db, "jobctrl_deleted_jobs")
      ? " LEFT JOIN jobctrl_deleted_jobs d ON d.job_url = arp.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
      : "";
  const hiddenJoin =
    hasApply && tableExists(db, "jobctrl_hidden_jobs")
      ? " LEFT JOIN jobctrl_hidden_jobs h ON h.job_url = arp.job_id AND h.unhidden_at IS NULL"
      : "";
  const where: string[] = ["wrp.tenant_id = ?"];
  const params: SqliteValue[] = [DEFAULT_TENANT];
  if (deletedJoin) {
    where.push("d.job_url IS NULL");
  }
  if (hiddenJoin) {
    where.push("h.job_url IS NULL");
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const rows = allRows<WorkflowRunProjectionRow>(
    db,
    `SELECT wrp.*${applySelect} FROM workflow_run_projections wrp${applyJoin}${deletedJoin}${hiddenJoin}${whereSql}
     ORDER BY wrp.started_at DESC, wrp.workflow_id DESC`,
    params,
  );
  const lifecycleFolds = loadWorkflowRunLifecycleFolds(db);
  const all = rows
    .map((row) => rowToWorkflowRunSummary(applyWorkflowLifecycleFold(row, lifecycleFolds.get(stringField(row.workflow_id)))))
    .filter((run) => filterWorkflowRun(run, query));
  all.sort((left, right) => compareWorkflowRuns(left, right, query.sort, query.dir));
  return paginate(all, query.page, query.pageSize, query.sort, query.dir, workflowRunsFilterPayload(query));
}

function filterWorkflowRun(run: WorkflowRunSummary, query: WorkflowRunsListQuery): boolean {
  if (query.status !== "all" && run.status !== query.status) return false;
  if (query.workflowType && run.workflowType !== query.workflowType) return false;
  if (query.startedSince && !timestampAtOrAfter(run.startedAt, query.startedSince)) return false;
  if (query.startedBefore && !timestampBefore(run.startedAt, query.startedBefore)) return false;
  return true;
}

function workflowRunsFilterPayload(query: WorkflowRunsListQuery): Record<string, unknown> {
  return {
    status: query.status,
    workflowType: query.workflowType ?? null,
    startedSince: query.startedSince ?? null,
    startedBefore: query.startedBefore ?? null,
  };
}

/**
 * Workflow run detail (Temporal loop closure — P0). Reads one
 * `workflow_run_projections` row (enriched with apply job context when the
 * run is an apply workflow) and returns the full `WorkflowRunDetail` shape,
 * including the folded lifecycle timeline. Returns `null` when the run id is
 * unknown.
 */
export function getWorkflowRunDetail(
  db: SqliteDatabase,
  runId: string,
): WorkflowRunDetail | null {
  refreshProjections(db, DEFAULT_TENANT);
  if (!tableExists(db, "workflow_run_projections")) {
    return null;
  }
  const hasApply = tableExists(db, "apply_run_projections");
  const applyJoin = hasApply
    ? ` LEFT JOIN apply_run_projections arp ON arp.run_id = wrp.workflow_id`
    : "";
  const applySelect = hasApply
    ? `, arp.job_id AS apply_job_id, arp.job_title AS job_title,
       arp.job_employer AS job_employer, arp.dry_run AS apply_dry_run,
       arp.model AS apply_model, arp.result AS apply_result`
    : "";
  const rawRow = getRow<WorkflowRunProjectionRow>(
    db,
    `SELECT wrp.*${applySelect} FROM workflow_run_projections wrp${applyJoin}
     WHERE wrp.tenant_id = ? AND wrp.workflow_id = ?`,
    [DEFAULT_TENANT, runId],
  );
  if (!rawRow) {
    return null;
  }
  // Correct the run-scoped verdict from the canonical lifecycle stream while
  // leaving `events_json` untouched so the timeline keeps the full history
  // (including the superseded execution's terminal events).
  const row = applyWorkflowLifecycleFold(rawRow, loadWorkflowRunLifecycleFolds(db).get(runId));
  const summary = rowToWorkflowRunSummary(row);
  return {
    workflowId: summary.workflowId,
    runId: summary.runId,
    workflowType: summary.workflowType,
    status: summary.status,
    jobKey: summary.jobKey,
    title: summary.title,
    company: summary.company,
    dryRun: summary.dryRun,
    model: summary.model,
    result: summary.result,
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    retryable: Boolean(row.retryable),
    inputSummary: parseInputSummary(row.input_summary_json),
    temporalRunId: nullableString(row.temporal_run_id),
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    durationMs: summary.durationMs,
    events: parseWorkflowRunTimeline(row.events_json),
  };
}

function parseInputSummary(value: unknown): Record<string, unknown> {
  const raw = nullableString(value);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseWorkflowRunTimeline(value: unknown): WorkflowRunTimelineEvent[] {
  const raw = nullableString(value);
  if (!raw) return [];
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecord).map((event) => ({
    eventType: stringField(event.eventType ?? event.event_type) || "event",
    occurredAt: nullableString(event.occurredAt ?? event.occurred_at),
    status: nullableString(event.status),
    message: nullableString(event.message),
  }));
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

function rowToWorkflowRunSummary(row: WorkflowRunProjectionRow): WorkflowRunSummary {
  const workflowId = stringField(row.workflow_id);
  const workflowType = stringField(row.workflow_type);
  const inputSummary = parseInputSummary(row.input_summary_json);
  const isStandingApplyLoop =
    workflowType === "ApplyWorkflow" &&
    (inputSummary.autoApplyLoop === true || inputSummary.auto_apply_loop === true) &&
    inputSummary.continuous === true;
  // Apply rows carry job context via the LEFT JOIN; non-apply rows have a
  // NULL apply_job_id and surface their workflow type instead of a job title.
  const hasApplyJob = Boolean(stringField(row.apply_job_id));
  const dryRun = hasApplyJob
    ? Boolean(row.apply_dry_run)
    : inputSummaryDryRun(inputSummary);
  return {
    workflowId,
    runId: workflowId,
    workflowType,
    jobKey: stringField(row.apply_job_id),
    title:
      (isStandingApplyLoop ? "Standing apply loop" : "") ||
      stringField(row.job_title) ||
      (hasApplyJob ? "Untitled" : workflowType || "Workflow run"),
    company:
      (isStandingApplyLoop ? "Auto apply" : "") ||
      stringField(row.job_employer) || (hasApplyJob ? "Unknown company" : ""),
    status: normalizeWorkflowRunStatus(row.status),
    result: nullableString(row.apply_result),
    dryRun,
    model: nullableString(row.apply_model),
    startedAt: nullableString(row.started_at),
    finishedAt: nullableString(row.finished_at),
    durationMs: nullableNumber(row.duration_ms),
  };
}

function inputSummaryDryRun(value: unknown): boolean {
  const summary = isRecord(value) ? value : parseInputSummary(value);
  return summary.dryRun === true || summary.dry_run === true;
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
  const deletedJoin = tableExists(db, "jobctrl_deleted_jobs")
    ? " LEFT JOIN jobctrl_deleted_jobs d ON d.job_url = arp.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
    : "";
  const hiddenJoin = tableExists(db, "jobctrl_hidden_jobs")
    ? " LEFT JOIN jobctrl_hidden_jobs h ON h.job_url = arp.job_id AND h.unhidden_at IS NULL"
    : "";
  const deletedWhere = tableExists(db, "jobctrl_deleted_jobs") ? " AND d.job_url IS NULL" : "";
  const hiddenWhere = tableExists(db, "jobctrl_hidden_jobs") ? " AND h.job_url IS NULL" : "";
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
    value === "needs_verification" ||
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

function nullableInteger(value: unknown): number | null {
  const numberValue = nullableNumber(value);
  if (numberValue === null) return null;
  return Number.isInteger(numberValue) ? numberValue : Math.trunc(numberValue);
}

function positiveInteger(value: unknown): number | null {
  const numberValue = nullableInteger(value);
  return numberValue !== null && numberValue > 0 ? numberValue : null;
}

function boundedPercent(value: unknown): number | null {
  const numberValue = nullableNumber(value);
  if (numberValue === null || numberValue < 0) return null;
  return Math.min(100, numberValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
