import { createHash } from "node:crypto";

import type {
  DiscoveryExecutionSummary,
  PipelineActiveItem,
  PipelineCapacity,
  PipelineEta,
  PipelineExecutionCohortSummary,
  PipelineOperationsFreshness,
  PipelineOperationsSnapshot,
  PipelineOperationalStage,
  PipelineProjectionCoverage,
  PipelineStageCounts,
} from "./contracts.js";
import { allRows, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import {
  estimatePipelineEta,
  type PipelineEtaEstimatorInput,
  type PipelineEtaStageInput,
} from "./pipeline-eta.js";
import { refreshProjections } from "./projections.js";
import { readWorkerRuntimeTelemetry, type WorkerRuntimeTelemetrySnapshot } from "./worker-runtime-telemetry.js";
import { readLlmSpendHealth } from "./worker-health.js";

const DEFAULT_TENANT = "local";
const ETA_SAMPLE_LIMIT = 50;
const ETA_SAMPLE_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;
const CURRENT_DISCOVERY_EXECUTION_DECODER_VERSION = 2;

const JOB_STAGES = ["enrich", "score", "tailor", "cover"] as const;
const STEP_STAGES = ["source_planning", "source_family", "reconciliation", "pdf_render"] as const;
const OPERATIONAL_STAGES = [...STEP_STAGES, ...JOB_STAGES] as const;

const STAGE_LABELS: Record<(typeof OPERATIONAL_STAGES)[number], string> = {
  source_planning: "Plan sources",
  source_family: "Crawl sources",
  reconciliation: "Reconciliation",
  pdf_render: "Render PDF",
  enrich: "Enrich",
  score: "Score",
  tailor: "Tailor",
  cover: "Cover letter",
};

const RUNTIME_ACTIVITY_STAGE: Record<string, string> = {
  discovery_enrichment: "enrich",
  score: "score",
  score_job: "score",
  tailor: "tailor",
  tailor_job: "tailor",
  cover: "cover",
  cover_letter: "cover",
  render_pdf: "pdf_render",
  plan_discovery_sources: "source_planning",
  discovery_source_family: "source_family",
  discovery_preparation_fanout: "reconciliation",
};

const STEP_ACTIVITY_TYPES: Record<string, string> = {
  source_planning: "plan_discovery_sources",
  source_family: "discovery_source_family",
  enrichment_pass: "discovery_enrichment",
  preparation_fanout: "discovery_preparation_fanout",
  existing_backlog_sweep: "discovery_preparation_fanout",
  pdf_render: "render_pdf",
};

interface WorkflowRow extends Record<string, unknown> {
  workflow_id: string;
  temporal_run_id: string | null;
  workflow_type: string;
  status: string;
  input_summary_json: string | null;
  error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface MembershipRow extends Record<string, unknown> {
  job_url: string;
  cohort_kind: "observed_this_run" | "existing_backlog";
  preparation_workflow_id: string | null;
  work_plan_state: "pending" | "planned" | "not_eligible" | "failed";
  required_steps_json: string | null;
}

interface StageStateRow extends Record<string, unknown> {
  job_url: string;
  stage: string;
  state: string | null;
  duration_ms: number | null;
  finished_at: string | null;
  retryable: number | null;
}

interface PipelineStepRow extends Record<string, unknown> {
  step_kind: string;
  item_key: string;
  state: string;
  attempt: number;
  retryable: number;
  duration_ms: number | null;
  finished_at: string | null;
  started_at: string | null;
  detail_count: number | null;
}

interface DiscoveryExecutionRecoveryRow extends Record<string, unknown> {
  state: string;
  mode: string;
  decoder_version: number;
  history_event_id: number;
  expected_membership_count: number;
  persisted_membership_count: number;
  expected_step_count: number;
  persisted_step_count: number;
  key_digest: string;
  last_error_code: string | null;
  updated_at: string;
}

interface JobDisplayRow extends Record<string, unknown> {
  url: string;
  title: string | null;
  company: string | null;
}

interface MetricRow extends Record<string, unknown> {
  stage: string;
  outcome: string;
  duration_ms: number | null;
  occurred_at: string;
}

interface SelectedExecution {
  row: WorkflowRow;
  phase: DiscoveryExecutionSummary["phase"];
  membershipClosed: boolean;
  current: Cohort;
  sweep: Cohort;
  steps: PipelineStepRow[];
  selectedAs: DiscoveryExecutionSummary["selectedAs"];
}

interface Cohort {
  members: MembershipRow[];
  stageStates: Map<string, Map<string, StageStateRow>>;
  preparationWorkflowStatuses: Map<string, string>;
  preparationWorkflowRunIds: Map<string, string>;
  summary: PipelineExecutionCohortSummary;
}

interface PipelineOperationsOptions {
  dbPath: string;
  configPath: string;
  now?: Date;
  tenantId?: string;
}

interface EtaSample {
  source: "job_stage_state" | "pipeline_step_projection" | "operational_attempt_metric";
  succeeded: boolean;
  durationMs: number | null;
  completedAt: string;
}

interface GlobalRetryability {
  hasUnboundedRetryableDemand: boolean;
}

type SelectedRuntimeScope = "current_execution" | "execution_sweep";

interface SelectedRuntimeAttribution {
  currentStageCounts: Map<(typeof OPERATIONAL_STAGES)[number], number>;
  sweepStageCounts: Map<(typeof OPERATIONAL_STAGES)[number], number>;
  selectedActivityCount: number;
}

interface RuntimePreparationLineage {
  tenantId: string;
  workflowId: string;
  runId: string;
  cohort: MembershipRow["cohort_kind"] | null;
}

interface EtaRuntimeContext {
  runtimeActiveWork: boolean;
  scope: "known" | "unknown";
}

/**
 * Build the current (not historical) Discover operations view.  The execution
 * identity is always the persisted workflow-id/run-id pair; a workflow id by
 * itself is intentionally never selected because Temporal workflow ids repeat.
 */
export function buildPipelineOperationsSnapshot(
  db: SqliteDatabase,
  options: PipelineOperationsOptions,
): PipelineOperationsSnapshot {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const tenantId = options.tenantId ?? DEFAULT_TENANT;
  refreshProjections(db, tenantId);
  const telemetry = readWorkerRuntimeTelemetry(options.dbPath, { now });
  const budgetAvailable = readLlmSpendHealth(options.dbPath, options.configPath, now).status !== "over_budget";
  const capacity = buildCapacity(telemetry, selectedInternalParallelism(db, tenantId));
  const activeStageCounts = buildActiveStageCounts(telemetry);
  const freshness = buildFreshness(telemetry);
  const executions = loadExecutions(db, tenantId);
  const selected = selectExecution(db, tenantId, executions);

  if (!selected) {
    const overallEta = estimatePipelineEta({
      asOf: generatedAt,
      scope: "unknown",
      membershipOpen: false,
      telemetryFresh: telemetry.status === "available",
      workerAvailable: telemetry.status === "available" && telemetry.configuredSlots > 0,
      budgetAvailable,
      blocked: false,
      dispatchObserved: dispatchObserved(telemetry),
      runtimeActiveWork: runtimeActiveWork(telemetry),
      configuredSlots: telemetry.status === "available" ? telemetry.configuredSlots : null,
      stages: [],
      remainingPaths: [],
      contention: { kind: "unknown" },
    }) as PipelineEta;
    return {
      generatedAt,
      etaEstimatorVersion: "pipeline-eta-v1",
      freshness,
      execution: null,
      capacity,
      sourceFamilies: null,
      reconciliation: null,
      projectionCoverage: unselectedExecutionCoverageRequired(telemetry)
        ? recoveringProjectionCoverage(0, 0)
        : null,
      stages: buildGlobalStages(db, tenantId, capacity, generatedAt, telemetry, budgetAvailable, now),
      activeStageCounts,
      activeItems: [],
      activeItemsTotal: null,
      activeItemsTruncated: null,
      overallEta,
    };
  }

  const runtimeAttribution = buildSelectedRuntimeAttribution(db, tenantId, selected, telemetry);
  const projectionCoverage = loadProjectionCoverage(db, tenantId, selected);
  const selectedCapacity = buildCapacity(telemetry, internalParallelism(selected.row));
  const currentCounts = stageCountsForCohort(selected.current, selected.steps);
  const sweepCounts = stageCountsForCohort(selected.sweep, selected.steps);
  const globalCounts = globalStageCounts(db, tenantId, selected);
  const globalRetryability = loadGlobalRetryability(db, tenantId, selected);
  const sourceFamilies = sourceFamilyProgress(
    db,
    tenantId,
    selected,
    sweepCounts,
    globalCounts,
    globalRetryability,
    generatedAt,
    telemetry,
    budgetAvailable,
    now,
    runtimeAttribution,
    projectionCoverage,
  );
  const reconciliation = reconciliationProgress(selected);
  const active = buildActiveItems(db, selected, telemetry);
  const etaInput = buildEtaInput(
    db,
    tenantId,
    selected,
    currentCounts,
    sweepCounts,
    globalCounts,
    globalRetryability,
    telemetry,
    budgetAvailable,
    generatedAt,
    now,
    runtimeAttribution,
    projectionCoverage,
  );
  const overallEta = estimatePipelineEta(etaInput) as PipelineEta;
  const stages = buildStages({
    db,
    tenantId,
    selected,
    capacity: selectedCapacity,
    currentCounts,
    sweepCounts,
    globalCounts,
    globalRetryability,
    telemetry,
    budgetAvailable,
    generatedAt,
    now,
    runtimeAttribution,
    projectionCoverage,
  });

  return {
    generatedAt,
    etaEstimatorVersion: "pipeline-eta-v1",
    freshness,
    execution: executionSummary(selected),
    capacity: selectedCapacity,
    sourceFamilies,
    reconciliation,
    projectionCoverage,
    stages,
    activeStageCounts,
    activeItems: active.items,
    activeItemsTotal: active.total,
    activeItemsTruncated: active.truncated,
    overallEta,
  };
}

function loadExecutions(db: SqliteDatabase, tenantId: string): WorkflowRow[] {
  if (!tableExists(db, "workflow_run_projections")) return [];
  return allRows<WorkflowRow>(
    db,
    `SELECT workflow_id, temporal_run_id, workflow_type, status, input_summary_json,
            error_code, started_at, finished_at
       FROM workflow_run_projections
      WHERE tenant_id = ?
        AND workflow_type = 'DiscoverWorkflow'
        AND temporal_run_id IS NOT NULL
        AND trim(temporal_run_id) <> ''
      ORDER BY COALESCE(started_at, finished_at) DESC, workflow_id DESC`,
    [tenantId],
  );
}

function selectExecution(
  db: SqliteDatabase,
  tenantId: string,
  rows: WorkflowRow[],
): SelectedExecution | null {
  const candidates = rows
    .map((row) => materializeExecution(db, tenantId, row))
    .filter((candidate): candidate is Omit<SelectedExecution, "selectedAs"> => candidate !== null);
  const active = candidates.find(
    (candidate) => candidate.phase === "discovering" || candidate.phase === "draining",
  );
  if (active) return { ...active, selectedAs: "active_or_draining" };
  const terminal = candidates[0];
  return terminal ? { ...terminal, selectedAs: "latest_terminal" } : null;
}

function materializeExecution(
  db: SqliteDatabase,
  tenantId: string,
  row: WorkflowRow,
): Omit<SelectedExecution, "selectedAs"> | null {
  const runId = nullableText(row.temporal_run_id);
  if (!runId) return null;
  const memberships = loadMemberships(db, tenantId, row.workflow_id, runId);
  const stageStates = loadStageStates(db, memberships.map((membership) => membership.job_url));
  const preparationWorkflows = loadPreparationWorkflows(db, tenantId, memberships);
  const steps = loadPipelineSteps(db, tenantId, row.workflow_id, runId);
  const current = cohort(
    memberships.filter((membership) => membership.cohort_kind === "observed_this_run"),
    stageStates,
    steps,
    preparationWorkflows.statuses,
    preparationWorkflows.runIds,
  );
  const sweep = cohort(
    memberships.filter((membership) => membership.cohort_kind === "existing_backlog"),
    stageStates,
    steps,
    preparationWorkflows.statuses,
    preparationWorkflows.runIds,
  );
  const membershipClosed = hasTerminalFanout(steps, isTerminalWorkflowStatus(row.status));
  const phase = phaseFor(row.status, current, sweep, steps, membershipClosed);
  return { row, phase, membershipClosed, current, sweep, steps };
}

function loadMemberships(
  db: SqliteDatabase,
  tenantId: string,
  workflowId: string,
  runId: string,
): MembershipRow[] {
  if (!tableExists(db, "discovery_execution_jobs")) return [];
  return allRows<MembershipRow>(
    db,
    `SELECT job_url, cohort_kind, preparation_workflow_id, work_plan_state, required_steps_json
       FROM discovery_execution_jobs
      WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?`,
    [tenantId, workflowId, runId],
  );
}

function loadStageStates(db: SqliteDatabase, jobUrls: string[]): Map<string, Map<string, StageStateRow>> {
  const grouped = new Map<string, Map<string, StageStateRow>>();
  if (jobUrls.length === 0 || !tableExists(db, "job_stage_states")) return grouped;
  for (const group of chunks(jobUrls, 500)) {
    const placeholders = group.map(() => "?").join(", ");
    const rows = allRows<StageStateRow>(
      db,
      `SELECT job_url, stage, state, duration_ms, finished_at, retryable
         FROM job_stage_states
        WHERE job_url IN (${placeholders})`,
      group,
    );
    for (const row of rows) {
      const stages = grouped.get(row.job_url) ?? new Map<string, StageStateRow>();
      stages.set(row.stage, row);
      grouped.set(row.job_url, stages);
    }
  }
  return grouped;
}

function loadPreparationWorkflows(
  db: SqliteDatabase,
  tenantId: string,
  memberships: MembershipRow[],
): { statuses: Map<string, string>; runIds: Map<string, string> } {
  const statuses = new Map<string, string>();
  const runIds = new Map<string, string>();
  if (!tableExists(db, "workflow_run_projections")) return { statuses, runIds };
  const workflowIds = [...new Set(
    memberships
      .map((member) => nullableText(member.preparation_workflow_id))
      .filter((workflowId): workflowId is string => workflowId !== null),
  )];
  for (const group of chunks(workflowIds, 500)) {
    const rows = allRows<{ workflow_id: string; status: string; temporal_run_id: string | null }>(
      db,
      `SELECT workflow_id, status, temporal_run_id
         FROM workflow_run_projections
        WHERE tenant_id = ? AND workflow_id IN (${group.map(() => "?").join(", ")})`,
      [tenantId, ...group],
    );
    for (const row of rows) {
      statuses.set(row.workflow_id, row.status);
      const runId = nullableText(row.temporal_run_id);
      if (runId) runIds.set(row.workflow_id, runId);
    }
  }
  return { statuses, runIds };
}

function loadPipelineSteps(
  db: SqliteDatabase,
  tenantId: string,
  workflowId: string,
  runId: string,
): PipelineStepRow[] {
  if (!tableExists(db, "pipeline_step_projections")) return [];
  return allRows<PipelineStepRow>(
    db,
    `SELECT step_kind, item_key, state, attempt, retryable, duration_ms, finished_at,
            started_at, detail_count
       FROM pipeline_step_projections
      WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?`,
    [tenantId, workflowId, runId],
  );
}

function cohort(
  members: MembershipRow[],
  stageStates: Map<string, Map<string, StageStateRow>>,
  steps: PipelineStepRow[] = [],
  preparationWorkflowStatuses = new Map<string, string>(),
  preparationWorkflowRunIds = new Map<string, string>(),
): Cohort {
  return {
    members,
    stageStates,
    preparationWorkflowStatuses,
    preparationWorkflowRunIds,
    summary: cohortSummary(members, stageStates, steps, preparationWorkflowStatuses),
  };
}

function cohortSummary(
  members: MembershipRow[],
  stageStates: Map<string, Map<string, StageStateRow>>,
  steps: PipelineStepRow[],
  preparationWorkflowStatuses: Map<string, string>,
): PipelineExecutionCohortSummary {
  let planned = 0;
  let notEligible = 0;
  let pending = 0;
  let failedPlan = 0;
  let terminal = 0;
  let remaining = 0;
  for (const member of members) {
    if (member.work_plan_state === "planned") {
      planned += 1;
      if (plannedMemberResolved(member, stageStates.get(member.job_url), steps, preparationWorkflowStatuses)) terminal += 1;
      else remaining += 1;
      continue;
    }
    if (member.work_plan_state === "not_eligible") {
      notEligible += 1;
      terminal += 1;
    } else if (member.work_plan_state === "failed") {
      failedPlan += 1;
      terminal += 1;
    } else {
      pending += 1;
      remaining += 1;
    }
  }
  return { members: members.length, planned, notEligible, pending, failedPlan, terminal, remaining };
}

function plannedMemberResolved(
  member: MembershipRow,
  states: Map<string, StageStateRow> | undefined,
  pipelineSteps: PipelineStepRow[],
  preparationWorkflowStatuses: Map<string, string>,
): boolean {
  const required = requiredSteps(member);
  if (required.length === 0) return false;
  return required.every((stage) => {
    const terminalOwner = memberPreparationWorkflowFailed(member, preparationWorkflowStatuses);
    if (stage === "pdf") return isTerminalStepState(pdfStepForMember(member, pipelineSteps), terminalOwner);
    return isTerminalStageState(states?.get(stage), terminalOwner);
  });
}

function hasTerminalFanout(steps: PipelineStepRow[], discoverWorkflowTerminal: boolean): boolean {
  return steps.some(
    (step) =>
      step.step_kind === "preparation_fanout" &&
      step.item_key === "terminal" &&
      isTerminalStepState(step, discoverWorkflowTerminal),
  );
}

function hasTerminalFanoutIssue(steps: PipelineStepRow[], discoverWorkflowTerminal: boolean): boolean {
  return steps.some(
    (step) =>
      step.step_kind === "preparation_fanout" &&
      step.item_key === "terminal" &&
      isTerminalStepFailure(step, discoverWorkflowTerminal),
  );
}

function phaseFor(
  status: string,
  current: Cohort,
  sweep: Cohort,
  steps: PipelineStepRow[],
  membershipClosed: boolean,
): DiscoveryExecutionSummary["phase"] {
  if (status === "in_progress" || status === "starting") return "discovering";
  if (status === "canceled") return "canceled";
  if (status === "failed" || status === "timed_out" || status === "terminated") return "failed";
  if (status === "succeeded" || status === "dry_run_complete") {
    if (hasPlannedMismatch(current) || hasPlannedMismatch(sweep)) return "completed_with_issues";
    if (hasUnresolvedPlannedMember(current, steps) || hasUnresolvedPlannedMember(sweep, steps)) {
      return "draining";
    }
    if (
      !membershipClosed ||
      current.summary.failedPlan > 0 ||
      current.summary.pending > 0 ||
      sweep.summary.failedPlan > 0 ||
      sweep.summary.pending > 0 ||
      hasTerminalFanoutIssue(steps, isTerminalWorkflowStatus(status)) ||
      hasTerminalIssue(current, steps) ||
      hasTerminalIssue(sweep, steps)
    ) {
      return "completed_with_issues";
    }
    return "completed";
  }
  return "discovering";
}

function hasPlannedMismatch(cohortValue: Cohort): boolean {
  return cohortValue.members.some(
    (member) => member.work_plan_state === "planned" && requiredSteps(member).length === 0,
  );
}

function hasUnresolvedPlannedMember(cohortValue: Cohort, steps: PipelineStepRow[]): boolean {
  return cohortValue.members.some(
    (member) =>
      member.work_plan_state === "planned" &&
      !plannedMemberResolved(
        member,
        cohortValue.stageStates.get(member.job_url),
        steps,
        cohortValue.preparationWorkflowStatuses,
      ),
  );
}

function hasTerminalIssue(cohortValue: Cohort, steps: PipelineStepRow[]): boolean {
  return cohortValue.members.some((member) => {
    if (member.work_plan_state !== "planned") return member.work_plan_state === "failed";
    const states = cohortValue.stageStates.get(member.job_url);
    return requiredSteps(member).some((stage) => {
      const terminalOwner = memberPreparationWorkflowFailed(member, cohortValue.preparationWorkflowStatuses);
      if (stage === "pdf") return isTerminalStepFailure(pdfStepForMember(member, steps), terminalOwner);
      const state = states?.get(stage);
      return state !== undefined && !isSuccessfulStageState(state) && !isRetryableStageFailure(state, terminalOwner);
    });
  });
}

function executionSummary(selected: SelectedExecution): DiscoveryExecutionSummary {
  const runId = nullableText(selected.row.temporal_run_id);
  if (!runId) {
    throw new Error("Selected discovery execution must have a persisted Temporal run id");
  }
  return {
    discoverWorkflowId: selected.row.workflow_id,
    discoverRunId: runId,
    selectedAs: selected.selectedAs,
    workflowStatus: workflowStatus(selected.row.status),
    phase: selected.phase,
    membershipClosed: selected.membershipClosed,
    startedAt: nullableText(selected.row.started_at),
    finishedAt: nullableText(selected.row.finished_at),
    errorCode: safeCode(selected.row.error_code),
    currentExecution: selected.current.summary,
    sweptExistingBacklog: selected.sweep.summary,
  };
}

function workflowStatus(value: string): DiscoveryExecutionSummary["workflowStatus"] {
  if (["in_progress", "succeeded", "failed", "canceled", "timed_out", "terminated"].includes(value)) {
    return value as DiscoveryExecutionSummary["workflowStatus"];
  }
  return "in_progress";
}

function buildFreshness(telemetry: WorkerRuntimeTelemetrySnapshot): PipelineOperationsFreshness {
  if (telemetry.status === "available") {
    if (telemetry.taskQueueObservation.status === "unsupported") {
      return {
        status: "unsupported",
        asOf: telemetry.asOf,
        staleAfterSeconds: telemetry.staleAfterSeconds,
        reason: telemetry.taskQueueObservation.reasonCode,
      };
    }
    return { status: "fresh", asOf: telemetry.asOf, staleAfterSeconds: telemetry.staleAfterSeconds };
  }
  if (telemetry.status === "stale") {
    return {
      status: "stale",
      asOf: telemetry.asOf,
      staleAfterSeconds: telemetry.staleAfterSeconds,
      reason: telemetry.reason,
    };
  }
  return {
    status: "unavailable",
    asOf: telemetry.asOf,
    staleAfterSeconds: telemetry.staleAfterSeconds,
    reason: telemetry.reason,
  };
}

function buildActiveStageCounts(
  telemetry: WorkerRuntimeTelemetrySnapshot,
): PipelineOperationsSnapshot["activeStageCounts"] {
  if (telemetry.status !== "available") return null;
  const counts = new Map<(typeof OPERATIONAL_STAGES)[number], number>();
  for (const [activityType, count] of Object.entries(telemetry.activeCountsByType)) {
    const stage = RUNTIME_ACTIVITY_STAGE[activityType];
    if (!stage || !isOperationalStage(stage) || typeof count !== "number" || count <= 0) continue;
    counts.set(stage, (counts.get(stage) ?? 0) + count);
  }
  return OPERATIONAL_STAGES.flatMap((stage) => {
    const count = counts.get(stage) ?? 0;
    return count > 0 ? [{ stage, count }] : [];
  });
}

function buildSelectedRuntimeAttribution(
  db: SqliteDatabase,
  tenantId: string,
  selected: SelectedExecution,
  telemetry: WorkerRuntimeTelemetrySnapshot,
): SelectedRuntimeAttribution {
  const result: SelectedRuntimeAttribution = {
    currentStageCounts: new Map(),
    sweepStageCounts: new Map(),
    selectedActivityCount: 0,
  };
  if (telemetry.status !== "available") return result;

  const members = selected.current.members.concat(selected.sweep.members);
  const lineages = loadRuntimePreparationLineages(db, tenantId, telemetry);
  for (const detail of telemetry.activeDetails) {
    const stage = RUNTIME_ACTIVITY_STAGE[detail.activityType];
    const exactDiscoveryActivity =
      detail.workflowRef === selected.row.workflow_id &&
      detail.executionRef === selected.row.temporal_run_id;
    let scope: SelectedRuntimeScope | null = exactDiscoveryActivity ? "current_execution" : null;
    let selectedActivity = exactDiscoveryActivity;

    if (!selectedActivity && detail.workflowRef && detail.executionRef) {
      const member = members.find((candidate) => {
        const workflowId = nullableText(candidate.preparation_workflow_id);
        return workflowId !== null &&
          workflowId === detail.workflowRef &&
          preparationWorkflowRunId(selected, workflowId) === detail.executionRef;
      });
      if (member) {
        selectedActivity = true;
        scope = member.cohort_kind === "existing_backlog" ? "execution_sweep" : "current_execution";
      } else {
        const lineage = lineages.get(runtimeIdentityKey(detail.workflowRef, detail.executionRef));
        if (lineage && runtimeLineageMatchesSelected(lineage, selected, tenantId)) {
          selectedActivity = true;
          scope = lineage.cohort === "existing_backlog"
            ? "execution_sweep"
            : lineage.cohort === "observed_this_run"
              ? "current_execution"
              : null;
        }
      }
    }

    if (!selectedActivity) continue;
    result.selectedActivityCount += 1;
    if (!stage || !isOperationalStage(stage) || scope === null) continue;
    incrementRuntimeStageCount(
      scope === "execution_sweep" ? result.sweepStageCounts : result.currentStageCounts,
      stage,
    );
  }
  return result;
}

function loadRuntimePreparationLineages(
  db: SqliteDatabase,
  tenantId: string,
  telemetry: WorkerRuntimeTelemetrySnapshot,
): Map<string, RuntimePreparationLineage> {
  const result = new Map<string, RuntimePreparationLineage>();
  if (!tableExists(db, "workflow_run_projections")) return result;
  const workflowIds = [...new Set(
    telemetry.activeDetails
      .map((detail) => detail.workflowRef)
      .filter((workflowId): workflowId is string => workflowId !== null),
  )];
  for (const group of chunks(workflowIds, 500)) {
    const rows = allRows<{
      workflow_id: string;
      temporal_run_id: string | null;
      input_summary_json: string | null;
    }>(
      db,
      `SELECT workflow_id, temporal_run_id, input_summary_json
         FROM workflow_run_projections
        WHERE tenant_id = ?
          AND workflow_type = 'JobPreparationWorkflow'
          AND workflow_id IN (${group.map(() => "?").join(", ")})`,
      [tenantId, ...group],
    );
    for (const row of rows) {
      const runId = nullableText(row.temporal_run_id);
      const summary = parseRecord(row.input_summary_json);
      const execution = summary?.discoveryExecution;
      if (!runId || execution === null || typeof execution !== "object" || Array.isArray(execution)) continue;
      const record = execution as Record<string, unknown>;
      const workflowId = nullableText(record.workflowId);
      const temporalRunId = nullableText(record.temporalRunId);
      const executionTenant = nullableText(record.tenantId);
      if (!workflowId || !temporalRunId || !executionTenant) continue;
      const cohortValue = summary?.discoveryCohortKind;
      const cohort = cohortValue === "observed_this_run" || cohortValue === "existing_backlog"
        ? cohortValue
        : null;
      result.set(runtimeIdentityKey(row.workflow_id, runId), {
        tenantId: executionTenant,
        workflowId,
        runId: temporalRunId,
        cohort,
      });
    }
  }
  return result;
}

function runtimeLineageMatchesSelected(
  lineage: RuntimePreparationLineage,
  selected: SelectedExecution,
  tenantId: string,
): boolean {
  return lineage.workflowId === selected.row.workflow_id &&
    lineage.runId === selected.row.temporal_run_id &&
    lineage.tenantId === tenantId;
}

function runtimeIdentityKey(workflowId: string, runId: string): string {
  return `${workflowId}\u0000${runId}`;
}

function incrementRuntimeStageCount(
  counts: Map<(typeof OPERATIONAL_STAGES)[number], number>,
  stage: (typeof OPERATIONAL_STAGES)[number],
): void {
  counts.set(stage, (counts.get(stage) ?? 0) + 1);
}

function loadProjectionCoverage(
  db: SqliteDatabase,
  tenantId: string,
  selected: SelectedExecution,
): PipelineProjectionCoverage {
  const membershipKeys = [...new Set(
    selected.current.members.concat(selected.sweep.members).map((member) => member.job_url),
  )];
  const stepKeys = [...new Set(
    selected.steps.map((step) => JSON.stringify([step.step_kind, step.item_key])),
  )]
    .map((value) => JSON.parse(value) as [string, string]);
  const persistedMembershipCount = membershipKeys.length;
  const persistedStepCount = stepKeys.length;

  if (!tableExists(db, "discovery_execution_recoveries")) {
    return recoveringProjectionCoverage(persistedMembershipCount, persistedStepCount);
  }
  const rows = allRows<DiscoveryExecutionRecoveryRow>(
    db,
    `SELECT state, mode, decoder_version, history_event_id,
            expected_membership_count, persisted_membership_count,
            expected_step_count, persisted_step_count, key_digest,
            last_error_code, updated_at
       FROM discovery_execution_recoveries
      WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?
      LIMIT 1`,
    [tenantId, selected.row.workflow_id, selected.row.temporal_run_id],
  );
  const row = rows[0];
  if (!row) return recoveringProjectionCoverage(persistedMembershipCount, persistedStepCount);

  const mode: "native" | "reconstructed" | null =
    row.mode === "native" || row.mode === "reconstructed" ? row.mode : null;
  const decoderVersion = positiveIntegerOrNull(row.decoder_version);
  const historyEventId = nonnegativeIntegerOrNull(row.history_event_id);
  const expectedMembershipCount = nonnegativeIntegerOrNull(row.expected_membership_count);
  const expectedStepCount = nonnegativeIntegerOrNull(row.expected_step_count);
  const updatedAt = nullableText(row.updated_at);
  const currentDigest = recoveryKeyDigest(membershipKeys, stepKeys);
  const checkpointMatches =
    mode !== null &&
    decoderVersion === CURRENT_DISCOVERY_EXECUTION_DECODER_VERSION &&
    historyEventId !== null &&
    expectedMembershipCount === persistedMembershipCount &&
    expectedStepCount === persistedStepCount &&
    nonnegativeIntegerOrNull(row.persisted_membership_count) === persistedMembershipCount &&
    nonnegativeIntegerOrNull(row.persisted_step_count) === persistedStepCount &&
    row.key_digest === currentDigest &&
    updatedAt !== null;

  if (row.state === "ready" && checkpointMatches) {
    return {
      status: "ready",
      mode,
      decoderVersion,
      historyEventId,
      membershipCount: persistedMembershipCount,
      stepCount: persistedStepCount,
      updatedAt,
    };
  }

  const common = {
    mode,
    decoderVersion,
    historyEventId,
    expectedMembershipCount,
    persistedMembershipCount,
    expectedStepCount,
    persistedStepCount,
    updatedAt,
  };
  if (row.state === "retrying") {
    return {
      status: "retrying",
      ...common,
      errorCode: nullableText(row.last_error_code) ?? "pipeline-history-repair-failed",
    };
  }
  if (row.state === "incomplete") {
    return {
      status: "incomplete",
      ...common,
      // The recovery table keeps NOT NULL bookkeeping counts for every row,
      // but a terminally truncated legacy history cannot prove its original
      // denominator. Expose only the exact persisted partial set.
      expectedMembershipCount: null,
      expectedStepCount: null,
      errorCode: nullableText(row.last_error_code) ?? "pipeline-history-incomplete",
    };
  }
  return { status: "recovering", ...common };
}

function recoveringProjectionCoverage(
  persistedMembershipCount: number,
  persistedStepCount: number,
): PipelineProjectionCoverage {
  return {
    status: "recovering",
    mode: null,
    decoderVersion: null,
    historyEventId: null,
    expectedMembershipCount: null,
    persistedMembershipCount,
    expectedStepCount: null,
    persistedStepCount,
    updatedAt: null,
  };
}

function recoveryKeyDigest(
  membershipKeys: readonly string[],
  stepKeys: ReadonlyArray<readonly [string, string]>,
): string {
  const memberships = membershipKeys.map(utf8Hex).sort();
  const steps = stepKeys
    .map((stepKey) => utf8Hex(JSON.stringify(stepKey)))
    .sort();
  return createHash("sha256")
    .update(JSON.stringify({ memberships, steps }))
    .digest("hex");
}

function utf8Hex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonnegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function buildCapacity(
  telemetry: WorkerRuntimeTelemetrySnapshot,
  internalParallelism: number | null,
): PipelineCapacity {
  if (telemetry.status !== "available") {
    return {
      status: telemetry.status,
      asOf: telemetry.asOf,
      staleAfterSeconds: telemetry.staleAfterSeconds,
      taskQueue: telemetry.taskQueue,
      reason: telemetry.reason,
      approximateTaskQueue: telemetry.taskQueueObservation,
    };
  }
  const common = {
    status: "available" as const,
    asOf: telemetry.asOf,
    staleAfterSeconds: telemetry.staleAfterSeconds,
    taskQueue: telemetry.taskQueue,
    freshWorkerCount: telemetry.freshWorkerCount,
    staleWorkerCount: telemetry.staleWorkerCount,
    invalidWorkerCount: telemetry.invalidWorkerCount,
    configuredSlots: telemetry.configuredSlots,
    activeSlots: telemetry.activeSlots,
    availableSlots: telemetry.availableSlots,
    executorThreads: telemetry.executorThreads,
    slotSaturation: telemetry.slotSaturation,
    approximateTaskQueue: telemetry.taskQueueObservation,
  };
  return internalParallelism === null
    ? { ...common, kind: "shared_activity_pool" }
    : { ...common, kind: "shared_activity_pool_with_internal_parallelism", internalParallelism };
}

function selectedInternalParallelism(db: SqliteDatabase, tenantId: string): number | null {
  const row = loadExecutions(db, tenantId)[0];
  return row ? internalParallelism(row) : null;
}

function internalParallelism(row: WorkflowRow): number | null {
  const parsed = parseRecord(row.input_summary_json);
  const workers = parsed?.workers;
  return typeof workers === "number" && Number.isSafeInteger(workers) && workers > 0 ? workers : null;
}

function stageCountsForCohort(
  cohortValue: Cohort,
  steps: PipelineStepRow[],
): Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts> {
  const counts = new Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>();
  counts.set("source_planning", projectionCounts(steps.filter((step) => step.step_kind === "source_planning")));
  counts.set("source_family", sourceFamilyCounts(steps));
  counts.set("reconciliation", reconciliationCounts(steps));
  counts.set("pdf_render", pdfCounts(cohortValue, steps));
  for (const stage of JOB_STAGES) {
    counts.set(stage, jobStageCounts(cohortValue, stage));
  }
  return counts;
}

function sourceFamilyCounts(steps: PipelineStepRow[]): PipelineStageCounts {
  const families = steps.filter((step) => step.step_kind === "source_family");
  const planned = maxDetailCount(steps.filter((step) => step.step_kind === "source_planning"));
  return projectionCounts(families, planned);
}

function reconciliationCounts(steps: PipelineStepRow[]): PipelineStageCounts {
  const components = reconciliationComponents(steps);
  return addCounts(components.enrichment_pass, components.preparation_fanout);
}

function reconciliationComponents(steps: PipelineStepRow[]): {
  enrichment_pass: PipelineStageCounts;
  preparation_fanout: PipelineStageCounts;
} {
  return {
    enrichment_pass: projectionCounts(steps.filter((step) => step.step_kind === "enrichment_pass")),
    preparation_fanout: projectionCounts(steps.filter((step) => step.step_kind === "preparation_fanout")),
  };
}

function addCounts(left: PipelineStageCounts, right: PipelineStageCounts): PipelineStageCounts {
  return {
    eligible: left.eligible + right.eligible,
    waiting: left.waiting + right.waiting,
    processing: left.processing + right.processing,
    succeeded: left.succeeded + right.succeeded,
    skipped: left.skipped + right.skipped,
    blocked: left.blocked + right.blocked,
    failed: left.failed + right.failed,
    exhausted: left.exhausted + right.exhausted,
    canceled: left.canceled + right.canceled,
    needsVerification: left.needsVerification + right.needsVerification,
    stale: left.stale + right.stale,
    unknown: left.unknown + right.unknown,
  };
}

function pdfCounts(cohortValue: Cohort, steps: PipelineStepRow[]): PipelineStageCounts {
  const counts = emptyCounts();
  for (const member of cohortValue.members) {
    if (member.work_plan_state !== "planned" || !requiredSteps(member).includes("pdf")) continue;
    counts.eligible += 1;
    const step = pdfStepForMember(member, steps);
    if (step) addPipelineStepState(counts, step.state);
    else counts.unknown += 1;
  }
  return counts;
}

function projectionCounts(rows: PipelineStepRow[], expectedEligible?: number | null): PipelineStageCounts {
  const counts = emptyCounts();
  const expected = expectedEligible ?? rows.length;
  counts.eligible = Math.max(expected, rows.length);
  for (const row of rows) {
    addPipelineStepState(counts, row.state);
  }
  const known = outcomeSum(counts);
  if (known < counts.eligible) counts.unknown += counts.eligible - known;
  return counts;
}

function addPipelineStepState(counts: PipelineStageCounts, state: string): void {
  if (state === "queued") counts.waiting += 1;
  else if (state === "running") counts.processing += 1;
  else if (state === "succeeded") counts.succeeded += 1;
  else if (state === "failed") counts.failed += 1;
  else counts.unknown += 1;
}

function pdfStepForMember(member: MembershipRow, steps: PipelineStepRow[]): PipelineStepRow | undefined {
  const workflowId = nullableText(member.preparation_workflow_id);
  if (!workflowId || !workflowId.startsWith("prep-")) return undefined;
  const idempotencyKey = workflowId.slice("prep-".length);
  if (!idempotencyKey) return undefined;
  const itemKey = `pdf:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
  return steps.find((step) => step.step_kind === "pdf_render" && step.item_key === itemKey);
}

function isTerminalStepState(step: PipelineStepRow | undefined, terminalOwnerFailed = false): boolean {
  return step?.state === "succeeded" || isTerminalStepFailure(step, terminalOwnerFailed);
}

function isTerminalStepFailure(step: PipelineStepRow | undefined, terminalOwnerFailed = false): boolean {
  return step?.state === "failed" && (Number(step.retryable) !== 1 || terminalOwnerFailed);
}

function jobStageCounts(cohortValue: Cohort, stage: (typeof JOB_STAGES)[number]): PipelineStageCounts {
  const counts = emptyCounts();
  for (const member of cohortValue.members) {
    const eligible =
      stage === "enrich"
        ? member.work_plan_state !== "not_eligible"
        : member.work_plan_state === "planned" && requiredSteps(member).includes(stage);
    if (!eligible) continue;
    counts.eligible += 1;
    addStageState(counts, cohortValue.stageStates.get(member.job_url)?.get(stage)?.state ?? null);
  }
  return counts;
}

function addStageState(counts: PipelineStageCounts, state: string | null): void {
  switch (state) {
    case "pending":
    case "queued":
      counts.waiting += 1;
      break;
    case "running":
      counts.processing += 1;
      break;
    case "succeeded":
      counts.succeeded += 1;
      break;
    case "skipped":
      counts.skipped += 1;
      break;
    case "blocked":
      counts.blocked += 1;
      break;
    case "failed":
      counts.failed += 1;
      break;
    case "exhausted":
      counts.exhausted += 1;
      break;
    case "canceled":
      counts.canceled += 1;
      break;
    case "needs_verification":
      counts.needsVerification += 1;
      break;
    case "stale":
      counts.stale += 1;
      break;
    default:
      counts.unknown += 1;
  }
}

function globalStageCounts(
  db: SqliteDatabase,
  tenantId: string,
  selected: SelectedExecution,
): Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts> {
  const counts = new Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>();
  for (const stage of OPERATIONAL_STAGES) counts.set(stage, emptyCounts());
  if (!tableExists(db, "job_stage_states")) return counts;
  const excluded = selected.current.members.concat(selected.sweep.members).map((member) => member.job_url);
  const where = ["jss.stage IN ('enrich', 'score', 'tailor', 'cover')"];
  const params: SqliteValue[] = [];
  if (excluded.length > 0) {
    where.push(`jss.job_url NOT IN (${excluded.map(() => "?").join(", ")})`);
    params.push(...excluded);
  }
  const rows = allRows<StageStateRow>(
    db,
    `SELECT jss.job_url, jss.stage, jss.state, jss.duration_ms, jss.finished_at
       FROM job_stage_states jss
      WHERE ${where.join(" AND ")}`,
    params,
  );
  for (const row of rows) {
    const target = counts.get(row.stage as (typeof OPERATIONAL_STAGES)[number]);
    if (!target) continue;
    target.eligible += 1;
    addStageState(target, row.state);
  }
  return counts;
}

function loadGlobalRetryability(
  db: SqliteDatabase,
  tenantId: string,
  selected: SelectedExecution,
): GlobalRetryability {
  if (!tableExists(db, "job_stage_states")) return { hasUnboundedRetryableDemand: false };
  const excluded = selected.current.members.concat(selected.sweep.members).map((member) => member.job_url);
  const where = ["stage IN ('enrich', 'score', 'tailor', 'cover')", "state = 'failed'", "retryable = 1"];
  const params: SqliteValue[] = [];
  if (excluded.length > 0) {
    where.push(`job_url NOT IN (${excluded.map(() => "?").join(", ")})`);
    params.push(...excluded);
  }
  const rows = allRows<{ job_url: string }>(
    db,
    `SELECT job_url FROM job_stage_states WHERE ${where.join(" AND ")}`,
    params,
  );
  if (rows.length === 0) return { hasUnboundedRetryableDemand: false };

  const owners = loadUniqueGlobalPreparationOwners(
    db,
    tenantId,
    [...new Set(rows.map((row) => row.job_url))],
  );
  const statuses = loadPreparationWorkflowStatusById(
    db,
    tenantId,
    [...new Set([...owners.values()].filter((workflowId): workflowId is string => workflowId !== null))],
  );
  for (const row of rows) {
    const workflowId = owners.get(row.job_url);
    // A global stage row has no workflow/run identity. Even a unique workflow
    // id cannot safely bind it to a nonterminal folded projection, so only a
    // proven failed terminal owner can remove its retryable queue-ahead risk.
    if (!workflowId || !isFailedTerminalWorkflowStatus(statuses.get(workflowId))) {
      return { hasUnboundedRetryableDemand: true };
    }
  }
  return { hasUnboundedRetryableDemand: false };
}

function loadUniqueGlobalPreparationOwners(
  db: SqliteDatabase,
  tenantId: string,
  jobUrls: string[],
): Map<string, string | null> {
  const owners = new Map<string, string | null>(jobUrls.map((jobUrl) => [jobUrl, null] as const));
  if (jobUrls.length === 0 || !tableExists(db, "discovery_execution_jobs")) return owners;
  const candidates = new Map(jobUrls.map((jobUrl) => [jobUrl, new Set<string>()] as const));
  const ambiguous = new Set<string>();
  for (const group of chunks(jobUrls, 500)) {
    const rows = allRows<{ job_url: string; preparation_workflow_id: string | null }>(
      db,
      `SELECT job_url, preparation_workflow_id
         FROM discovery_execution_jobs
        WHERE tenant_id = ? AND job_url IN (${group.map(() => "?").join(", ")})`,
      [tenantId, ...group],
    );
    for (const row of rows) {
      const workflowId = nullableText(row.preparation_workflow_id);
      if (!workflowId) {
        ambiguous.add(row.job_url);
        continue;
      }
      candidates.get(row.job_url)?.add(workflowId);
    }
  }
  for (const jobUrl of jobUrls) {
    const workflowIds = candidates.get(jobUrl);
    if (!ambiguous.has(jobUrl) && workflowIds?.size === 1) {
      const workflowId = workflowIds.values().next().value;
      if (workflowId !== undefined) owners.set(jobUrl, workflowId);
    }
  }
  return owners;
}

function loadPreparationWorkflowStatusById(
  db: SqliteDatabase,
  tenantId: string,
  workflowIds: string[],
): Map<string, string> {
  const statuses = new Map<string, string>();
  if (workflowIds.length === 0 || !tableExists(db, "workflow_run_projections")) return statuses;
  for (const group of chunks(workflowIds, 500)) {
    const rows = allRows<{ workflow_id: string; status: string }>(
      db,
      `SELECT workflow_id, status
         FROM workflow_run_projections
        WHERE tenant_id = ?
          AND workflow_type = 'JobPreparationWorkflow'
          AND workflow_id IN (${group.map(() => "?").join(", ")})`,
      [tenantId, ...group],
    );
    for (const row of rows) statuses.set(row.workflow_id, row.status);
  }
  return statuses;
}

function buildStages(input: {
  db: SqliteDatabase;
  tenantId: string;
  selected: SelectedExecution;
  capacity: PipelineCapacity;
  currentCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>;
  sweepCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>;
  globalCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>;
  globalRetryability: GlobalRetryability;
  telemetry: WorkerRuntimeTelemetrySnapshot;
  budgetAvailable: boolean;
  generatedAt: string;
  now: Date;
  runtimeAttribution: SelectedRuntimeAttribution;
  projectionCoverage: PipelineProjectionCoverage;
}): PipelineOperationalStage[] {
  const result: PipelineOperationalStage[] = [];
  const selectedScope = input.projectionCoverage.status === "ready" ? "known" : "unknown";
  for (const stage of OPERATIONAL_STAGES) {
    const current = input.currentCounts.get(stage) ?? emptyCounts();
    const sweep = input.sweepCounts.get(stage) ?? emptyCounts();
    const global = input.globalCounts.get(stage) ?? emptyCounts();
    const stageEta = estimateForStage(
      input.db,
      input.tenantId,
      stage,
      current,
      input.selected,
      input.telemetry,
      input.budgetAvailable,
      input.generatedAt,
      input.now,
      retryableRemainingForStage(input.selected, input.selected.current, stage, true),
      true,
      {
        runtimeActiveWork: selectedRuntimeStageActiveWork(
          input.runtimeAttribution,
          "current_execution",
          stage,
        ),
        scope: selectedScope,
      },
      currentStageContention(
        input.selected,
        stage,
        input.sweepCounts,
        input.globalCounts,
        input.globalRetryability,
        input.telemetry,
      ),
    );
    result.push({
      stage,
      label: STAGE_LABELS[stage],
      scope: "current_execution",
      currentExecution: current,
      existingBacklog: { kind: "not_separate", reason: "current_execution_scope" },
      capacity: input.capacity,
      eta: stageEta,
      asOf: input.generatedAt,
    });
    result.push({
      stage,
      label: STAGE_LABELS[stage],
      scope: "execution_sweep",
      currentExecution: emptyCounts(),
      existingBacklog: isJobStage(stage) || stage === "pdf_render"
        ? { kind: "domain_jobs", counts: sweep }
        : { kind: "not_separate", reason: "no_separate_sweep_queue" },
      capacity: input.capacity,
      eta: estimatePipelineEta({
        ...stageEtaInput(
          input.db,
          input.tenantId,
          stage,
          sweep,
          input.selected,
          input.telemetry,
          input.budgetAvailable,
          input.generatedAt,
          input.now,
          retryableRemainingForStage(input.selected, input.selected.sweep, stage, false),
          false,
          {
            runtimeActiveWork: selectedRuntimeStageActiveWork(
              input.runtimeAttribution,
              "execution_sweep",
              stage,
            ),
            scope: selectedScope,
          },
        ),
        membershipOpen: false,
      }) as PipelineEta,
      asOf: input.generatedAt,
    });
    result.push({
      stage,
      label: STAGE_LABELS[stage],
      scope: "global_outside_execution",
      currentExecution: emptyCounts(),
      existingBacklog: isJobStage(stage)
        ? { kind: "domain_jobs", counts: global }
        : { kind: "not_separate", reason: "no_global_domain_queue" },
      capacity: input.capacity,
      eta: estimatePipelineEta({
        ...stageEtaInput(
          input.db,
          input.tenantId,
          stage,
          global,
          input.selected,
          input.telemetry,
          input.budgetAvailable,
          input.generatedAt,
          input.now,
          0,
          false,
        ),
        membershipOpen: false,
      }) as PipelineEta,
      asOf: input.generatedAt,
    });
  }
  return result;
}

function buildGlobalStages(
  db: SqliteDatabase,
  tenantId: string,
  capacity: PipelineCapacity,
  generatedAt: string,
  telemetry: WorkerRuntimeTelemetrySnapshot,
  budgetAvailable: boolean,
  now: Date,
): PipelineOperationalStage[] {
  const noSelection: SelectedExecution = {
    row: {
      workflow_id: "none",
      temporal_run_id: "none",
      workflow_type: "DiscoverWorkflow",
      status: "succeeded",
      input_summary_json: null,
      error_code: null,
      started_at: null,
      finished_at: null,
    },
    phase: "completed",
    membershipClosed: true,
    current: cohort([], new Map()),
    sweep: cohort([], new Map()),
    steps: [],
    selectedAs: "latest_terminal",
  };
  const global = globalStageCounts(db, tenantId, noSelection);
  return OPERATIONAL_STAGES.map((stage) => {
    const counts = global.get(stage) ?? emptyCounts();
    return {
      stage,
      label: STAGE_LABELS[stage],
      scope: "global_outside_execution",
      currentExecution: emptyCounts(),
      existingBacklog: isJobStage(stage)
        ? { kind: "domain_jobs" as const, counts }
        : { kind: "not_separate" as const, reason: "no_global_domain_queue" },
      capacity,
      eta: estimatePipelineEta(
        stageEtaInput(db, tenantId, stage, counts, noSelection, telemetry, budgetAvailable, generatedAt, now, 0, false),
      ) as PipelineEta,
      asOf: generatedAt,
    };
  });
}

function sourceFamilyProgress(
  db: SqliteDatabase,
  tenantId: string,
  selected: SelectedExecution,
  sweepCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>,
  globalCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>,
  globalRetryability: GlobalRetryability,
  generatedAt: string,
  telemetry: WorkerRuntimeTelemetrySnapshot,
  budgetAvailable: boolean,
  now: Date,
  runtimeAttribution: SelectedRuntimeAttribution,
  projectionCoverage: PipelineProjectionCoverage,
): PipelineOperationsSnapshot["sourceFamilies"] {
  const sourceRows = selected.steps.filter((step) => step.step_kind === "source_family");
  const sourcePlanRows = selected.steps.filter((step) => step.step_kind === "source_planning");
  if (sourceRows.length === 0 && sourcePlanRows.length === 0) return null;
  const planned = Math.max(maxDetailCount(sourcePlanRows) ?? 0, sourceRows.length);
  const counts = projectionCounts(sourceRows, planned);
  return {
    planned,
    counts,
    eta: estimatePipelineEta({
      ...basicEtaInput(
        selected,
        telemetry,
        budgetAvailable,
        generatedAt,
        selectedRuntimeStageActiveWork(runtimeAttribution, "current_execution", "source_family"),
      ),
      scope: projectionCoverage.status === "ready" ? "known" : "unknown",
      membershipOpen: false,
      stages: [
        {
          stage: "source_family",
          remainingCurrentStage: etaRemainingCount(
            counts,
            retryablePipelineSteps(sourceRows, isTerminalWorkflowStatus(selected.row.status)),
          ),
          primaryEvidence: "pipeline_step_projection",
          samples: pipelineStepHistorySamples(db, tenantId, "source_family", now),
        },
      ],
      remainingPaths: [],
      contention: sourceContention(selected, sweepCounts, globalCounts, globalRetryability, telemetry),
    }) as PipelineEta,
    asOf: generatedAt,
  };
}

function reconciliationProgress(
  selected: SelectedExecution,
): PipelineOperationsSnapshot["reconciliation"] {
  const components = reconciliationComponents(selected.steps);
  const enrichment = components.enrichment_pass;
  const preparationFanout = components.preparation_fanout;
  if (enrichment.eligible === 0 && preparationFanout.eligible === 0) return null;
  return {
    enrichment,
    preparationFanout,
    asOf: latestStepObservation(
      selected.steps.filter(
        (step) => step.step_kind === "enrichment_pass" || step.step_kind === "preparation_fanout",
      ),
    ),
  };
}

function buildActiveItems(
  db: SqliteDatabase,
  selected: SelectedExecution,
  telemetry: WorkerRuntimeTelemetrySnapshot,
): { items: PipelineActiveItem[]; total: number | null; truncated: boolean | null } {
  if (telemetry.status !== "available") return { items: [], total: null, truncated: null };
  const byWorkflow = new Map(
    selected.current.members
      .concat(selected.sweep.members)
      .filter((member): member is MembershipRow & { preparation_workflow_id: string } =>
        nullableText(member.preparation_workflow_id) !== null,
      )
      .map((member) => [member.preparation_workflow_id, member]),
  );
  const display = loadJobDisplays(
    db,
    [...byWorkflow.values()].map((member) => member.job_url),
  );
  const runtimeItems: PipelineActiveItem[] = telemetry.activeDetails.map((detail) => {
    const member = detail.workflowRef ? byWorkflow.get(detail.workflowRef) : undefined;
    const stage = RUNTIME_ACTIVITY_STAGE[detail.activityType];
    if (member && stage && isJobStage(stage)) {
      const job = display.get(member.job_url);
      return {
        kind: "resolved_job" as const,
        activityType: detail.activityType,
        workflowId: detail.workflowRef,
        executionId: detail.executionRef,
        attempt: detail.attempt,
        startedAt: detail.startedAt,
        // The runtime operational ref, not the DB job URL, is the safe display key.
        jobKey: detail.operationalRef.opaqueId,
        title: job?.title ?? null,
        company: job?.company ?? null,
        stage,
      };
    }
    return {
      kind: "unresolved_runtime_activity" as const,
      activityType: detail.activityType,
      workflowId: detail.workflowRef,
      executionId: detail.executionRef,
      attempt: detail.attempt,
      startedAt: detail.startedAt,
      opaqueId: detail.operationalRef.opaqueId,
      stage: stage && isOperationalStage(stage) ? stage : null,
    };
  });
  const consumedRuntimeItemIndexes = new Set<number>();
  const projectionItems: PipelineActiveItem[] = [];
  for (const step of selected.steps
    .filter((step) => step.state === "running")
    .sort((left, right) => Date.parse(left.started_at ?? "") - Date.parse(right.started_at ?? ""))) {
    const activityType = STEP_ACTIVITY_TYPES[step.step_kind] ?? step.step_kind;
    const pdfMember =
      step.step_kind === "pdf_render"
        ? selected.current.members
            .concat(selected.sweep.members)
            .find((member) => pdfStepForMember(member, [step]) !== undefined)
        : undefined;
    const runtimeIndex = runtimeItems.findIndex(
      (item, index) =>
        !consumedRuntimeItemIndexes.has(index) &&
        isExactRuntimeProjectionMatch(item, activityType, selected, step.step_kind === "pdf_render", pdfMember),
    );
    // Fresh runtime telemetry is the active-work authority. Projection rows
    // only enrich a runtime item whose safe workflow identity proves the pair.
    if (runtimeIndex < 0) continue;
    const runtimeItem = runtimeItems[runtimeIndex];
    if (runtimeItem === undefined) continue;
    consumedRuntimeItemIndexes.add(runtimeIndex);
    const base = {
      activityType,
      workflowId: runtimeItem.workflowId,
      executionId: runtimeItem.executionId,
      attempt: Math.max(1, Math.floor(nonnegative(step.attempt) ?? 1)),
      startedAt: step.started_at ?? latestStepObservation([step]),
    };
    if (pdfMember) {
      const job = display.get(pdfMember.job_url);
      projectionItems.push({
        ...base,
        kind: "resolved_job",
        jobKey: step.item_key,
        title: job?.title ?? null,
        company: job?.company ?? null,
        stage: "pdf_render",
      });
    } else if (step.step_kind === "source_family") {
      projectionItems.push({ ...base, kind: "source_family", sourceFamily: safeItemKey(step.item_key) });
    } else {
      projectionItems.push({ ...base, kind: "orchestration", operation: step.step_kind });
    }
  }
  const all = runtimeItems
    .filter((_item, index) => !consumedRuntimeItemIndexes.has(index))
    .concat(projectionItems)
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const items = all.slice(0, 20);
  return {
    items,
    total: telemetry.activeDetailsTotal,
    truncated:
      telemetry.activeDetailsTruncated ||
      telemetry.activeSlots > telemetry.activeDetailsTotal ||
      all.length > items.length,
  };
}

function isExactRuntimeProjectionMatch(
  item: PipelineActiveItem,
  activityType: string,
  selected: SelectedExecution,
  isPdfRender: boolean,
  pdfMember: MembershipRow | undefined,
): boolean {
  if (item.activityType !== activityType) return false;
  if (isPdfRender) {
    const workflowId = pdfMember ? nullableText(pdfMember.preparation_workflow_id) : null;
    // The latest persisted preparation projection is the only canonical
    // workflow-id/run-id identity available for a render activity. A workflow
    // id can repeat across Temporal runs, so do not hydrate it without a run.
    const runId = workflowId ? preparationWorkflowRunId(selected, workflowId) : undefined;
    return workflowId !== null && runId !== undefined && item.workflowId === workflowId && item.executionId === runId;
  }
  return item.workflowId === selected.row.workflow_id && item.executionId === selected.row.temporal_run_id;
}

function preparationWorkflowRunId(selected: SelectedExecution, workflowId: string): string | undefined {
  return selected.current.preparationWorkflowRunIds.get(workflowId) ??
    selected.sweep.preparationWorkflowRunIds.get(workflowId);
}

function loadJobDisplays(db: SqliteDatabase, jobUrls: string[]): Map<string, JobDisplayRow> {
  const result = new Map<string, JobDisplayRow>();
  if (jobUrls.length === 0 || !hasColumns(db, "jobs", ["url", "title", "company"])) return result;
  for (const group of chunks(jobUrls, 500)) {
    const rows = allRows<JobDisplayRow>(
      db,
      `SELECT url, title, company FROM jobs WHERE url IN (${group.map(() => "?").join(", ")})`,
      group,
    );
    for (const row of rows) result.set(row.url, row);
  }
  return result;
}

function buildEtaInput(
  db: SqliteDatabase,
  tenantId: string,
  selected: SelectedExecution,
  currentCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>,
  sweepCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>,
  globalCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>,
  globalRetryability: GlobalRetryability,
  telemetry: WorkerRuntimeTelemetrySnapshot,
  budgetAvailable: boolean,
  generatedAt: string,
  now: Date,
  runtimeAttribution: SelectedRuntimeAttribution,
  projectionCoverage: PipelineProjectionCoverage,
): PipelineEtaEstimatorInput {
  const stages: PipelineEtaStageInput[] = OPERATIONAL_STAGES.filter((stage) => stage !== "reconciliation").map((stage) => ({
      stage,
      remainingCurrentStage: etaRemainingCount(
        currentCounts.get(stage) ?? emptyCounts(),
        retryableRemainingForStage(selected, selected.current, stage, true),
      ),
      primaryEvidence: usesStepProjection(stage)
        ? ("pipeline_step_projection" as const)
        : ("job_stage_state" as const),
      samples: evidenceSamples(db, tenantId, stage, now),
    }));
  const reconciliation = reconciliationComponents(selected.steps);
  stages.push(
    ...(["enrichment_pass", "preparation_fanout"] as const).map((stage) => ({
      stage,
      remainingCurrentStage: etaRemainingCount(
        reconciliation[stage],
        retryablePipelineSteps(
          selected.steps.filter((step) => step.step_kind === stage),
          isTerminalWorkflowStatus(selected.row.status),
        ),
      ),
      primaryEvidence: "pipeline_step_projection" as const,
      samples: pipelineStepHistorySamples(db, tenantId, stage, now),
    })),
  );
  return {
    ...basicEtaInput(
      selected,
      telemetry,
      budgetAvailable,
      generatedAt,
      runtimeAttribution.selectedActivityCount > 0,
    ),
    scope: projectionCoverage.status === "ready" ? "known" as const : "unknown" as const,
    membershipOpen: !selected.membershipClosed,
    blocked: stages.some((stage) => (currentCounts.get(stage.stage as (typeof OPERATIONAL_STAGES)[number])?.blocked ?? 0) > 0),
    stages,
    remainingPaths: remainingPaths(selected.current, selected.steps),
    contention: contention(selected, sweepCounts, globalCounts, globalRetryability, telemetry),
  };
}

function stageEtaInput(
  db: SqliteDatabase,
  tenantId: string,
  stage: (typeof OPERATIONAL_STAGES)[number],
  counts: PipelineStageCounts,
  selected: SelectedExecution,
  telemetry: WorkerRuntimeTelemetrySnapshot,
  budgetAvailable: boolean,
  generatedAt: string,
  now: Date,
  retryableRemaining = 0,
  includeExecutionSteps = true,
  runtimeContext: EtaRuntimeContext = {
    runtimeActiveWork: runtimeStageActiveWork(telemetry, stage),
    scope: "known",
  },
  contentionInput: PipelineEtaEstimatorInput["contention"] = sharedRuntimeContention(telemetry),
): PipelineEtaEstimatorInput {
  const stages =
    stage === "reconciliation" && includeExecutionSteps
      ? (["enrichment_pass", "preparation_fanout"] as const).map((stepKind) => ({
          stage: stepKind,
          remainingCurrentStage: etaRemainingCount(
            reconciliationComponents(selected.steps)[stepKind],
            retryablePipelineSteps(
              selected.steps.filter((step) => step.step_kind === stepKind),
              isTerminalWorkflowStatus(selected.row.status),
            ),
          ),
          primaryEvidence: "pipeline_step_projection" as const,
          samples: pipelineStepHistorySamples(db, tenantId, stepKind, now),
        }))
      : [
          {
            stage,
            remainingCurrentStage: etaRemainingCount(counts, retryableRemaining),
            primaryEvidence: usesStepProjection(stage)
              ? ("pipeline_step_projection" as const)
              : ("job_stage_state" as const),
            samples: evidenceSamples(db, tenantId, stage, now),
          },
        ];
  return {
    ...basicEtaInput(
      selected,
      telemetry,
      budgetAvailable,
      generatedAt,
      runtimeContext.runtimeActiveWork,
    ),
    scope: runtimeContext.scope,
    membershipOpen: false,
    blocked: counts.blocked > 0,
    stages,
    remainingPaths: [],
    contention: contentionInput,
  };
}

function basicEtaInput(
  selected: SelectedExecution,
  telemetry: WorkerRuntimeTelemetrySnapshot,
  budgetAvailable: boolean,
  generatedAt: string,
  runtimeWork = runtimeActiveWork(telemetry),
) {
  return {
    asOf: generatedAt,
    scope: "known" as const,
    membershipOpen: !selected.membershipClosed,
    telemetryFresh: telemetry.status === "available",
    workerAvailable: telemetry.status === "available" && telemetry.configuredSlots > 0,
    budgetAvailable,
    blocked: false,
    dispatchObserved: dispatchObserved(telemetry),
    runtimeActiveWork: runtimeWork,
    configuredSlots: telemetry.status === "available" ? telemetry.configuredSlots : null,
    stages: [],
    remainingPaths: [],
    contention: sharedRuntimeContention(telemetry),
  };
}

function estimateForStage(
  db: SqliteDatabase,
  tenantId: string,
  stage: (typeof OPERATIONAL_STAGES)[number],
  counts: PipelineStageCounts,
  selected: SelectedExecution,
  telemetry: WorkerRuntimeTelemetrySnapshot,
  budgetAvailable: boolean,
  generatedAt: string,
  now: Date,
  retryableRemaining = 0,
  includeExecutionSteps = true,
  runtimeContext: EtaRuntimeContext = {
    runtimeActiveWork: runtimeStageActiveWork(telemetry, stage),
    scope: "known",
  },
  contentionInput: PipelineEtaEstimatorInput["contention"] = sharedRuntimeContention(telemetry),
): PipelineEta {
  return estimatePipelineEta(
    stageEtaInput(
      db,
      tenantId,
      stage,
      counts,
      selected,
      telemetry,
      budgetAvailable,
      generatedAt,
      now,
      retryableRemaining,
      includeExecutionSteps,
      runtimeContext,
      contentionInput,
    ),
  ) as PipelineEta;
}

function evidenceSamples(
  db: SqliteDatabase,
  tenantId: string,
  stage: (typeof OPERATIONAL_STAGES)[number],
  now: Date,
): EtaSample[] {
  const primary = usesStepProjection(stage)
    ? pipelineStepHistorySamples(db, tenantId, stepKindForStage(stage), now)
    : jobStageSamples(db, stage, now);
  // The estimator itself only reads metrics when the owning primary source is empty.
  return primary.length > 0 ? primary : attemptMetricSamples(db, tenantId, stage, now);
}

function jobStageSamples(db: SqliteDatabase, stage: string, now: Date): EtaSample[] {
  if (!tableExists(db, "job_stage_states")) return [];
  const rows = allRows<StageStateRow>(
    db,
    `SELECT job_url, stage, state, duration_ms, finished_at
       FROM job_stage_states
      WHERE stage = ? AND state = 'succeeded' AND duration_ms > 0 AND finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT ?`,
    [stage, ETA_SAMPLE_LIMIT],
  );
  return rows
    .filter((row) => withinEtaWindow(row.finished_at, now))
    .map((row) => ({
      source: "job_stage_state" as const,
      succeeded: true,
      durationMs: nonnegative(row.duration_ms),
      completedAt: row.finished_at!,
    }));
}

function pipelineStepSamples(steps: PipelineStepRow[], stepKind: string, now: Date): EtaSample[] {
  return steps
    .filter(
      (step) =>
        step.step_kind === stepKind &&
        step.state === "succeeded" &&
        nonnegative(step.duration_ms) !== null &&
        nonnegative(step.duration_ms)! > 0 &&
        withinEtaWindow(step.finished_at, now),
    )
    .sort((left, right) => Date.parse(right.finished_at ?? "") - Date.parse(left.finished_at ?? ""))
    .slice(0, ETA_SAMPLE_LIMIT)
    .map((step) => ({
      source: "pipeline_step_projection" as const,
      succeeded: true,
      durationMs: nonnegative(step.duration_ms),
      completedAt: step.finished_at!,
    }));
}

function pipelineStepHistorySamples(
  db: SqliteDatabase,
  tenantId: string,
  stepKind: string,
  now: Date,
): EtaSample[] {
  if (!tableExists(db, "pipeline_step_projections")) return [];
  const rows = allRows<PipelineStepRow>(
    db,
    `SELECT step_kind, item_key, state, attempt, retryable, duration_ms, finished_at,
            started_at, detail_count
       FROM pipeline_step_projections
      WHERE tenant_id = ? AND step_kind = ? AND state = 'succeeded'
        AND duration_ms > 0 AND finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT ?`,
    [tenantId, stepKind, ETA_SAMPLE_LIMIT],
  );
  return pipelineStepSamples(rows, stepKind, now);
}

function attemptMetricSamples(db: SqliteDatabase, tenantId: string, stage: string, now: Date): EtaSample[] {
  if (!tableExists(db, "operational_attempt_metrics")) return [];
  const rows = allRows<MetricRow>(
    db,
    `SELECT stage, outcome, duration_ms, occurred_at
       FROM operational_attempt_metrics
      WHERE tenant_id = ? AND stage = ? AND duration_ms > 0
        AND outcome IN ('succeeded', 'success')
      ORDER BY occurred_at DESC
      LIMIT ?`,
    [tenantId, stageForMetric(stage), ETA_SAMPLE_LIMIT],
  );
  return rows
    .filter((row) => withinEtaWindow(row.occurred_at, now))
    .map((row) => ({
      source: "operational_attempt_metric" as const,
      succeeded: true,
      durationMs: nonnegative(row.duration_ms),
      completedAt: row.occurred_at,
    }));
}

function remainingPaths(
  cohortValue: Cohort,
  pipelineSteps: PipelineStepRow[],
): Array<{ stageIds: string[] }> {
  return cohortValue.members.flatMap((member) => {
    if (member.work_plan_state !== "planned") return [];
    const states = cohortValue.stageStates.get(member.job_url);
    const stageIds = requiredSteps(member).filter((stage) => {
      const terminalOwner = memberPreparationWorkflowFailed(member, cohortValue.preparationWorkflowStatuses);
      if (stage === "pdf") return !isTerminalStepState(pdfStepForMember(member, pipelineSteps), terminalOwner);
      return !isTerminalStageState(states?.get(stage), terminalOwner);
    });
    return stageIds.length > 0 ? [{ stageIds: stageIds.map((stage) => (stage === "pdf" ? "pdf_render" : stage)) }] : [];
  });
}

function contention(
  selected: SelectedExecution,
  sweepCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>,
  globalCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>,
  globalRetryability: GlobalRetryability,
  telemetry: WorkerRuntimeTelemetrySnapshot,
) {
  if (telemetry.status !== "available" || hasUnboundedQueueContention(telemetry)) {
    return { kind: "unknown" as const };
  }
  if (telemetry.activeDetailsTruncated || telemetry.activeSlots > telemetry.activeDetailsTotal) {
    return { kind: "truncated" as const };
  }
  if (globalRetryability.hasUnboundedRetryableDemand) return { kind: "unknown" as const };
  const existingBacklog = [...JOB_STAGES, "pdf_render" as const].map((stage) => ({
    stage,
    count:
      remainingCount(sweepCounts.get(stage) ?? emptyCounts()) +
      remainingCount(globalCounts.get(stage) ?? emptyCounts()),
  })).filter((entry) => entry.count > 0);
  // Global stage-count projections do not retain retryability. Do not inflate
  // queue-ahead demand with terminal failures; sweep membership is exact.
  const retries = [...JOB_STAGES, "pdf_render" as const].map((stage) => ({
    stage,
    count: retryableRemainingForStage(selected, selected.sweep, stage, false),
  })).filter((entry) => entry.count > 0);
  return { kind: "bounded" as const, existingBacklog, retries, queuePresent: queuePresent(telemetry) };
}

function sharedRuntimeContention(telemetry: WorkerRuntimeTelemetrySnapshot) {
  if (telemetry.status !== "available" || hasUnboundedQueueContention(telemetry)) {
    return { kind: "unknown" as const };
  }
  if (telemetry.activeDetailsTruncated || telemetry.activeSlots > telemetry.activeDetailsTotal) {
    return { kind: "truncated" as const };
  }
  return { kind: "bounded" as const, existingBacklog: [], retries: [], queuePresent: false };
}

function currentStageContention(
  selected: SelectedExecution,
  stage: (typeof OPERATIONAL_STAGES)[number],
  sweepCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>,
  globalCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>,
  globalRetryability: GlobalRetryability,
  telemetry: WorkerRuntimeTelemetrySnapshot,
): PipelineEtaEstimatorInput["contention"] {
  if (!isJobStage(stage) && stage !== "pdf_render") {
    return sourceContention(selected, sweepCounts, globalCounts, globalRetryability, telemetry);
  }
  const runtime = sharedRuntimeContention(telemetry);
  if (runtime.kind !== "bounded") return runtime;
  if (globalRetryability.hasUnboundedRetryableDemand) return { kind: "unknown" };
  const sweep = sweepCounts.get(stage) ?? emptyCounts();
  const global = globalCounts.get(stage) ?? emptyCounts();
  const heterogeneousDemand = [...JOB_STAGES, "pdf_render" as const].some((otherStage) => {
    if (otherStage === stage) return false;
    return remainingCount(sweepCounts.get(otherStage) ?? emptyCounts()) > 0 ||
      remainingCount(globalCounts.get(otherStage) ?? emptyCounts()) > 0 ||
      retryableRemainingForStage(selected, selected.sweep, otherStage, false) > 0;
  });
  // The ETA sample only prices this stage. Competing work from another stage
  // shares its slots but has no interchangeable duration evidence, so it
  // cannot be safely bounded as a same-stage queue-ahead count.
  if (heterogeneousDemand) return { kind: "unknown" };
  const externalCount = remainingCount(sweep) + remainingCount(global);
  const retryCount = retryableRemainingForStage(selected, selected.sweep, stage, false);
  return {
    kind: "bounded",
    existingBacklog: externalCount > 0 ? [{ stage, count: externalCount }] : [],
    retries: retryCount > 0 ? [{ stage, count: retryCount }] : [],
    queuePresent: false,
  };
}

function sourceContention(
  selected: SelectedExecution,
  sweepCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>,
  globalCounts: Map<(typeof OPERATIONAL_STAGES)[number], PipelineStageCounts>,
  globalRetryability: GlobalRetryability,
  telemetry: WorkerRuntimeTelemetrySnapshot,
) {
  const runtime = sharedRuntimeContention(telemetry);
  if (runtime.kind !== "bounded") return runtime;
  if (globalRetryability.hasUnboundedRetryableDemand) return { kind: "unknown" as const };
  const competingDomainWork = [...JOB_STAGES, "pdf_render" as const].some(
    (stage) =>
      remainingCount(sweepCounts.get(stage) ?? emptyCounts()) > 0 ||
      remainingCount(globalCounts.get(stage) ?? emptyCounts()) > 0 ||
      retryableRemainingForStage(selected, selected.sweep, stage, false) > 0,
  );
  // Source-family duration evidence cannot price heterogeneous preparation
  // work in the same activity pool, so keep that ETA unavailable rather than
  // pretending the shared slots are reserved for source work.
  return competingDomainWork ? { kind: "unknown" as const } : runtime;
}

function etaRemainingCount(counts: PipelineStageCounts, retryableFailures: number): number {
  return remainingCount(counts) + retryableFailures;
}

function retryableRemainingForStage(
  selected: SelectedExecution,
  cohortValue: Cohort,
  stage: (typeof OPERATIONAL_STAGES)[number],
  includeExecutionSteps: boolean,
): number {
  if (isJobStage(stage)) {
    return cohortValue.members.filter(
      (member) =>
        (stage === "enrich"
          ? member.work_plan_state !== "not_eligible"
          : member.work_plan_state === "planned" && requiredSteps(member).includes(stage)) &&
        retryableStageFailureForMember(cohortValue, member, stage),
    ).length;
  }
  if (stage === "pdf_render") {
    return cohortValue.members.filter(
      (member) =>
        member.work_plan_state === "planned" &&
        requiredSteps(member).includes("pdf") &&
        isRetryableStepFailure(
          pdfStepForMember(member, selected.steps),
          memberPreparationWorkflowFailed(member, cohortValue.preparationWorkflowStatuses),
        ),
    ).length;
  }
  if (!includeExecutionSteps) return 0;
  if (stage === "reconciliation") {
    return retryablePipelineSteps(
      selected.steps.filter(
        (step) => step.step_kind === "enrichment_pass" || step.step_kind === "preparation_fanout",
      ),
      isTerminalWorkflowStatus(selected.row.status),
    );
  }
  return retryablePipelineSteps(
    selected.steps.filter((step) => step.step_kind === stage),
    isTerminalWorkflowStatus(selected.row.status),
  );
}

function retryablePipelineSteps(steps: PipelineStepRow[], terminalOwnerTerminal = false): number {
  return steps.filter((step) => isRetryableStepFailure(step, terminalOwnerTerminal)).length;
}

function retryableStageFailureForMember(
  cohortValue: Cohort,
  member: MembershipRow,
  stage: (typeof JOB_STAGES)[number],
): boolean {
  const state = cohortValue.stageStates.get(member.job_url)?.get(stage);
  return state !== undefined && isRetryableStageFailure(
    state,
    memberPreparationWorkflowFailed(member, cohortValue.preparationWorkflowStatuses),
  );
}

function isRetryableStepFailure(step: PipelineStepRow | undefined, terminalOwnerTerminal = false): boolean {
  return step?.state === "failed" && Number(step.retryable) === 1 && !terminalOwnerTerminal;
}

function memberPreparationWorkflowFailed(
  member: MembershipRow,
  preparationWorkflowStatuses: Map<string, string>,
): boolean {
  const workflowId = nullableText(member.preparation_workflow_id);
  return workflowId !== null && isFailedTerminalWorkflowStatus(preparationWorkflowStatuses.get(workflowId));
}

function isFailedTerminalWorkflowStatus(status: string | undefined): boolean {
  return status === "failed" || status === "canceled" || status === "timed_out" || status === "terminated";
}

function isTerminalWorkflowStatus(status: string | undefined): boolean {
  return isFailedTerminalWorkflowStatus(status) || status === "succeeded" || status === "dry_run_complete";
}

function isJobStage(stage: string): stage is (typeof JOB_STAGES)[number] {
  return (JOB_STAGES as readonly string[]).includes(stage);
}

function isOperationalStage(stage: string): stage is (typeof OPERATIONAL_STAGES)[number] {
  return (OPERATIONAL_STAGES as readonly string[]).includes(stage);
}

function runtimeActiveWork(telemetry: WorkerRuntimeTelemetrySnapshot): boolean {
  return telemetry.status === "available" && telemetry.activeDetailsTotal > 0;
}

function unselectedExecutionCoverageRequired(
  telemetry: WorkerRuntimeTelemetrySnapshot,
): boolean {
  // The absence of a selected execution is only proof of an idle system when
  // fresh worker telemetry also proves that every activity slot is idle.  A
  // stale/missing heartbeat or occupied non-allowlisted slot is unknown scope,
  // not an empty pipeline.
  return telemetry.status !== "available" || telemetry.activeSlots > 0;
}

function runtimeStageActiveWork(
  telemetry: WorkerRuntimeTelemetrySnapshot,
  stage: (typeof OPERATIONAL_STAGES)[number],
): boolean {
  if (telemetry.status !== "available") return false;
  return Object.entries(telemetry.activeCountsByType).some(
    ([activityType, count]) =>
      RUNTIME_ACTIVITY_STAGE[activityType] === stage && typeof count === "number" && count > 0,
  );
}

function selectedRuntimeStageActiveWork(
  attribution: SelectedRuntimeAttribution,
  scope: SelectedRuntimeScope,
  stage: (typeof OPERATIONAL_STAGES)[number],
): boolean {
  const counts = scope === "execution_sweep"
    ? attribution.sweepStageCounts
    : attribution.currentStageCounts;
  return (counts.get(stage) ?? 0) > 0;
}

function usesStepProjection(stage: string): boolean {
  return !isJobStage(stage);
}

function stepKindForStage(stage: string): string {
  return stage;
}

function stageForMetric(stage: string): string {
  return stage === "pdf_render" ? "pdf" : stage === "source_family" ? "discover" : stage;
}

function dispatchObserved(telemetry: WorkerRuntimeTelemetrySnapshot): boolean {
  return (
    (telemetry.status === "available" && telemetry.activeSlots > 0) ||
    (telemetry.taskQueueObservation.status === "available" && telemetry.taskQueueObservation.activity.tasksDispatchRate > 0)
  );
}

function queuePresent(telemetry: WorkerRuntimeTelemetrySnapshot): boolean {
  return telemetry.taskQueueObservation.status === "available" && telemetry.taskQueueObservation.activity.approximateBacklogCount > 0;
}

function hasUnboundedQueueContention(telemetry: WorkerRuntimeTelemetrySnapshot): boolean {
  const observation = telemetry.taskQueueObservation;
  if (observation.status !== "available") return true;
  return (
    observation.workflow.approximateBacklogCount > 0 ||
    observation.activity.approximateBacklogCount > 0
  );
}

function requiredSteps(member: MembershipRow): Array<"score" | "tailor" | "cover" | "pdf"> {
  const parsed = parseJson(member.required_steps_json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (value): value is "score" | "tailor" | "cover" | "pdf" =>
      value === "score" || value === "tailor" || value === "cover" || value === "pdf",
  );
}

function emptyCounts(): PipelineStageCounts {
  return {
    eligible: 0,
    waiting: 0,
    processing: 0,
    succeeded: 0,
    skipped: 0,
    blocked: 0,
    failed: 0,
    exhausted: 0,
    canceled: 0,
    needsVerification: 0,
    stale: 0,
    unknown: 0,
  };
}

function outcomeSum(counts: PipelineStageCounts): number {
  return (
    counts.waiting +
    counts.processing +
    counts.succeeded +
    counts.skipped +
    counts.blocked +
    counts.failed +
    counts.exhausted +
    counts.canceled +
    counts.needsVerification +
    counts.stale +
    counts.unknown
  );
}

function remainingCount(counts: PipelineStageCounts): number {
  return counts.waiting + counts.processing + counts.blocked + counts.needsVerification + counts.stale + counts.unknown;
}

function isTerminalStageState(state: StageStateRow | undefined, terminalOwnerFailed = false): boolean {
  if (!state) return false;
  return (
    ["succeeded", "skipped", "exhausted", "canceled"].includes(state.state ?? "") ||
    isTerminalStageFailure(state, terminalOwnerFailed)
  );
}

function isSuccessfulStageState(state: StageStateRow): boolean {
  return state.state === "succeeded" || state.state === "skipped";
}

function isRetryableStageFailure(state: StageStateRow, terminalOwnerFailed = false): boolean {
  return state.state === "failed" && Number(state.retryable) === 1 && !terminalOwnerFailed;
}

function isTerminalStageFailure(state: StageStateRow, terminalOwnerFailed = false): boolean {
  return state.state === "failed" && (Number(state.retryable) !== 1 || terminalOwnerFailed);
}

function maxDetailCount(rows: PipelineStepRow[]): number | null {
  const values = rows
    .map((row) => nonnegative(row.detail_count))
    .filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

function latestStepObservation(steps: PipelineStepRow[]): string {
  const timestamps = steps
    .flatMap((step) => [step.finished_at, step.started_at])
    .filter((value): value is string => nullableText(value) !== null)
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return timestamps[0] ?? new Date(0).toISOString();
}

function withinEtaWindow(timestamp: string | null, now: Date): boolean {
  if (!timestamp) return false;
  const parsed = Date.parse(timestamp);
  return !Number.isNaN(parsed) && parsed <= now.getTime() && parsed >= now.getTime() - ETA_SAMPLE_WINDOW_MS;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_.:-]{0,79}$/.test(value) ? value : null;
}

function safeItemKey(value: string): string {
  return /^[a-z0-9][a-z0-9_.:-]{0,159}$/.test(value) ? value : "unknown_source_family";
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseRecord(raw: string | null): Record<string, unknown> | null {
  const parsed = parseJson(raw);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function hasColumns(db: SqliteDatabase, tableName: string, columns: string[]): boolean {
  if (!tableExists(db, tableName)) return false;
  const present = new Set(
    db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((row) => String((row as { name: unknown }).name)),
  );
  return columns.every((column) => present.has(column));
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}
