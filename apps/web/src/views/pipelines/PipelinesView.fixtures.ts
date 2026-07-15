import type {
  PipelineCapacity,
  PipelineEta,
  PipelineOperationalStage,
  PipelineOperationsSnapshot,
  PipelineStageCounts,
} from "@jobctrl/contracts";

const AS_OF = "2026-07-14T12:00:00.000Z";

function counts(overrides: Partial<PipelineStageCounts> = {}): PipelineStageCounts {
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
    ...overrides,
  };
}

const etaAvailable: PipelineEta = {
  status: "available",
  lowSeconds: 480,
  highSeconds: 720,
  confidence: "medium",
  basis: "stage_throughput",
  sampleSize: 14,
  asOf: AS_OF,
  caveat: "Estimate excludes unrelated backlog outside this discovery run.",
};

const etaCalibrating: PipelineEta = {
  status: "calibrating",
  completedSamples: 2,
  minimumSamples: 8,
  asOf: AS_OF,
  reason: "insufficient_samples",
};

const etaUnavailable: PipelineEta = {
  status: "unavailable",
  reason: "telemetry_stale",
  asOf: AS_OF,
};

const availableCapacity: PipelineCapacity = {
  status: "available",
  kind: "shared_activity_pool_with_internal_parallelism",
  asOf: AS_OF,
  staleAfterSeconds: 45,
  taskQueue: "jobctrl-default",
  freshWorkerCount: 1,
  staleWorkerCount: 0,
  invalidWorkerCount: 0,
  configuredSlots: 4,
  activeSlots: 2,
  availableSlots: 2,
  executorThreads: 6,
  internalParallelism: 2,
  slotSaturation: 0.5,
  approximateTaskQueue: {
    status: "available",
    observedAt: AS_OF,
    workflow: {
      pollerCount: 1,
      approximateBacklogCount: 0,
      approximateBacklogAgeSeconds: 0,
      tasksAddRate: 0.1,
      tasksDispatchRate: 0.1,
    },
    activity: {
      pollerCount: 1,
      approximateBacklogCount: 2,
      approximateBacklogAgeSeconds: 18,
      tasksAddRate: 0.4,
      tasksDispatchRate: 0.5,
    },
  },
};

function stage(
  stageName: string,
  label: string,
  scope: PipelineOperationalStage["scope"],
  currentExecution: PipelineStageCounts,
  eta: PipelineEta = etaAvailable,
  existingBacklog: PipelineOperationalStage["existingBacklog"] = {
    kind: "domain_jobs",
    counts: counts(),
  },
): PipelineOperationalStage {
  return {
    stage: stageName,
    label,
    scope,
    currentExecution,
    existingBacklog,
    capacity: availableCapacity,
    eta,
    asOf: AS_OF,
  };
}

const discoveringStages: PipelineOperationalStage[] = [
  stage("source_planning", "Plan sources", "current_execution", counts({ eligible: 1, succeeded: 1 })),
  stage("source_family", "Crawl sources", "current_execution", counts({ eligible: 3, processing: 2, succeeded: 1 })),
  stage("reconciliation", "Reconciliation", "current_execution", counts({ eligible: 2, waiting: 2 })),
  stage("enrich", "Enrich", "execution_sweep", counts({ eligible: 9, waiting: 5, processing: 2, succeeded: 2 })),
  stage("score", "Score", "execution_sweep", counts({ eligible: 7, waiting: 4, processing: 1, succeeded: 2 })),
  stage("tailor", "Tailor", "execution_sweep", counts({ eligible: 4, waiting: 4 })),
  stage(
    "score",
    "Score",
    "global_outside_execution",
    counts(),
    etaUnavailable,
    { kind: "domain_jobs", counts: counts({ eligible: 11, waiting: 8, failed: 1, stale: 2 }) },
  ),
  stage(
    "tailor",
    "Tailor",
    "global_outside_execution",
    counts(),
    etaUnavailable,
    { kind: "domain_jobs", counts: counts({ eligible: 6, waiting: 5, needsVerification: 1 }) },
  ),
];

function snapshot(overrides: Partial<PipelineOperationsSnapshot> = {}): PipelineOperationsSnapshot {
  return {
    generatedAt: AS_OF,
    etaEstimatorVersion: "pipeline-eta-v1",
    freshness: { status: "fresh", asOf: AS_OF, staleAfterSeconds: 45 },
    execution: {
      discoverWorkflowId: "discover-local",
      discoverRunId: "run-discover-20260714",
      selectedAs: "active_or_draining",
      workflowStatus: "in_progress",
      phase: "discovering",
      membershipClosed: false,
      startedAt: "2026-07-14T11:48:00.000Z",
      finishedAt: null,
      errorCode: null,
      currentExecution: { members: 9, planned: 9, notEligible: 0, pending: 6, failedPlan: 0, terminal: 3, remaining: 6 },
      sweptExistingBacklog: { members: 11, planned: 11, notEligible: 0, pending: 8, failedPlan: 0, terminal: 3, remaining: 8 },
    },
    capacity: availableCapacity,
    sourceFamilies: {
      planned: 3,
      counts: counts({ eligible: 3, processing: 2, succeeded: 1 }),
      eta: etaAvailable,
      asOf: AS_OF,
    },
    reconciliation: {
      enrichment: counts({ eligible: 1, waiting: 1 }),
      preparationFanout: counts({ eligible: 1, waiting: 1 }),
      asOf: AS_OF,
    },
    stages: discoveringStages,
    activeItems: [
      {
        kind: "source_family",
        activityType: "discovery_source_family",
        workflowId: "discover-local",
        executionId: "run-discover-20260714",
        attempt: 1,
        startedAt: "2026-07-14T11:50:00.000Z",
        sourceFamily: "JobSpy / LinkedIn",
      },
      {
        kind: "source_family",
        activityType: "discovery_source_family",
        workflowId: "discover-local",
        executionId: "run-discover-20260714",
        attempt: 1,
        startedAt: "2026-07-14T11:51:00.000Z",
        sourceFamily: "Workday careers",
      },
    ],
    activeItemsTotal: 2,
    activeItemsTruncated: false,
    overallEta: etaAvailable,
    ...overrides,
  };
}

export const pipelinesDiscoveringSnapshot = snapshot();

export const pipelinesDrainingSnapshot = snapshot({
  execution: {
    ...pipelinesDiscoveringSnapshot.execution!,
    phase: "draining",
    membershipClosed: true,
    currentExecution: { members: 9, planned: 9, notEligible: 0, pending: 3, failedPlan: 0, terminal: 6, remaining: 3 },
  },
  sourceFamilies: {
    planned: 3,
    counts: counts({ eligible: 3, succeeded: 3 }),
    eta: { status: "unavailable", reason: "no_work", asOf: AS_OF },
    asOf: AS_OF,
  },
  reconciliation: {
    enrichment: counts({ eligible: 1, succeeded: 1 }),
    preparationFanout: counts({ eligible: 1, processing: 1 }),
    asOf: AS_OF,
  },
  activeItems: [
    {
      kind: "orchestration",
      activityType: "discovery_preparation_fanout",
      workflowId: "discover-local",
      executionId: "run-discover-20260714",
      attempt: 1,
      startedAt: "2026-07-14T11:58:00.000Z",
      operation: "Starting preparation workflows",
    },
  ],
  activeItemsTotal: 1,
  overallEta: {
    status: "available",
    lowSeconds: 120,
    highSeconds: 180,
    confidence: "high",
    basis: "cohort_throughput",
    sampleSize: 18,
    asOf: AS_OF,
    caveat: null,
  },
});

export const pipelinesCompletedSnapshot = snapshot({
  execution: {
    ...pipelinesDiscoveringSnapshot.execution!,
    selectedAs: "latest_terminal",
    workflowStatus: "succeeded",
    phase: "completed",
    membershipClosed: true,
    finishedAt: "2026-07-14T12:04:00.000Z",
    currentExecution: { members: 9, planned: 9, notEligible: 0, pending: 0, failedPlan: 0, terminal: 9, remaining: 0 },
    sweptExistingBacklog: { members: 11, planned: 11, notEligible: 0, pending: 0, failedPlan: 0, terminal: 11, remaining: 0 },
  },
  sourceFamilies: {
    planned: 3,
    counts: counts({ eligible: 3, succeeded: 3 }),
    eta: { status: "unavailable", reason: "no_work", asOf: AS_OF },
    asOf: AS_OF,
  },
  reconciliation: {
    enrichment: counts({ eligible: 1, succeeded: 1 }),
    preparationFanout: counts({ eligible: 1, succeeded: 1 }),
    asOf: AS_OF,
  },
  stages: discoveringStages.map((entry) => ({
    ...entry,
    currentExecution: counts({ eligible: entry.currentExecution.eligible, succeeded: entry.currentExecution.eligible }),
    eta: { status: "unavailable", reason: "no_work", asOf: AS_OF },
  })),
  activeItems: [],
  activeItemsTotal: 0,
  activeItemsTruncated: false,
  overallEta: { status: "unavailable", reason: "no_work", asOf: AS_OF },
});

export const pipelinesCompletedWithIssuesSnapshot = snapshot({
  freshness: {
    status: "stale",
    asOf: "2026-07-14T11:45:00.000Z",
    staleAfterSeconds: 45,
    reason: "Worker telemetry is older than the configured freshness threshold.",
  },
  execution: {
    ...pipelinesCompletedSnapshot.execution!,
    phase: "completed_with_issues",
    errorCode: "source_retry_exhausted",
    currentExecution: { members: 9, planned: 9, notEligible: 0, pending: 0, failedPlan: 0, terminal: 9, remaining: 0 },
  },
  sourceFamilies: {
    planned: 3,
    counts: counts({ eligible: 3, succeeded: 2, exhausted: 1 }),
    eta: { status: "stale", reason: "telemetry_stale", asOf: AS_OF },
    asOf: AS_OF,
  },
  reconciliation: {
    enrichment: counts({ eligible: 1, succeeded: 1 }),
    preparationFanout: counts({ eligible: 1, blocked: 1 }),
    asOf: AS_OF,
  },
  stages: discoveringStages.map((entry) => ({
    ...entry,
    eta: { status: "stale", reason: "telemetry_stale", asOf: AS_OF },
  })),
  activeItems: [],
  activeItemsTotal: null,
  activeItemsTruncated: null,
  overallEta: { status: "stale", reason: "telemetry_stale", asOf: AS_OF },
});

export const pipelinesCalibratingSnapshot = snapshot({
  sourceFamilies: {
    planned: 3,
    counts: counts({ eligible: 3, processing: 1, succeeded: 2 }),
    eta: etaCalibrating,
    asOf: AS_OF,
  },
  stages: discoveringStages.map((entry) => ({ ...entry, eta: etaCalibrating })),
  overallEta: etaCalibrating,
});

export const pipelinesUnavailableTelemetrySnapshot = snapshot({
  freshness: {
    status: "unavailable",
    asOf: AS_OF,
    staleAfterSeconds: 45,
    reason: "No worker runtime telemetry has been recorded for this task queue.",
  },
  capacity: {
    status: "unavailable",
    asOf: AS_OF,
    staleAfterSeconds: 45,
    taskQueue: "jobctrl-default",
    reason: "No worker runtime telemetry has been recorded for this task queue.",
    approximateTaskQueue: { status: "unavailable", observedAt: AS_OF, reasonCode: "runtime_telemetry_missing" },
  },
  sourceFamilies: {
    planned: 3,
    counts: counts({ eligible: 3, processing: 1, succeeded: 2 }),
    eta: etaUnavailable,
    asOf: AS_OF,
  },
  stages: discoveringStages.map((entry) => ({ ...entry, capacity: {
    status: "unavailable",
    asOf: AS_OF,
    staleAfterSeconds: 45,
    taskQueue: "jobctrl-default",
    reason: "No worker runtime telemetry has been recorded for this task queue.",
    approximateTaskQueue: { status: "unavailable", observedAt: AS_OF, reasonCode: "runtime_telemetry_missing" },
  }, eta: etaUnavailable })),
  activeItems: [],
  activeItemsTotal: null,
  activeItemsTruncated: null,
  overallEta: etaUnavailable,
});

export const pipelinesMultiWorkerCapacitySnapshot = snapshot({
  capacity: {
    ...availableCapacity,
    freshWorkerCount: 3,
    configuredSlots: 12,
    activeSlots: 9,
    availableSlots: 3,
    executorThreads: 18,
    internalParallelism: 3,
    slotSaturation: 0.75,
  },
  stages: discoveringStages.map((entry) => ({ ...entry, capacity: {
    ...availableCapacity,
    freshWorkerCount: 3,
    configuredSlots: 12,
    activeSlots: 9,
    availableSlots: 3,
    executorThreads: 18,
    internalParallelism: 3,
    slotSaturation: 0.75,
  } })),
  activeItems: [
    ...pipelinesDiscoveringSnapshot.activeItems,
    {
      kind: "resolved_job",
      activityType: "score_job",
      workflowId: "prepare-job-8",
      executionId: "run-prepare-job-8",
      attempt: 2,
      startedAt: "2026-07-14T11:56:00.000Z",
      jobKey: "job-8",
      title: "Staff Platform Engineer",
      company: "Northstar",
      stage: "score",
    },
    {
      kind: "unresolved_runtime_activity",
      activityType: "workflow_activity",
      workflowId: "discover-local",
      executionId: "run-discover-20260714",
      attempt: 3,
      startedAt: "2026-07-14T11:57:00.000Z",
      opaqueId: "activity-opaque-17",
    },
  ],
  activeItemsTotal: 9,
  activeItemsTruncated: true,
});

/**
 * Guards the original topology: three source-family activities are not the
 * two one-off reconciliation activities. The view must never total them as
 * five source families or describe the reconciliation pair as a sixth source.
 */
export const pipelinesThreeSourceSixStepSnapshot = snapshot({
  sourceFamilies: {
    planned: 3,
    counts: counts({ eligible: 3, succeeded: 3 }),
    eta: { status: "unavailable", reason: "no_work", asOf: AS_OF },
    asOf: AS_OF,
  },
  reconciliation: {
    enrichment: counts({ eligible: 1, succeeded: 1 }),
    preparationFanout: counts({ eligible: 1, succeeded: 1 }),
    asOf: AS_OF,
  },
  stages: [
    stage("source_planning", "Plan sources", "current_execution", counts({ eligible: 1, succeeded: 1 })),
    stage("source_family", "Crawl sources", "current_execution", counts({ eligible: 3, succeeded: 3 })),
    stage("reconciliation", "Reconciliation", "current_execution", counts({ eligible: 2, succeeded: 2 })),
    stage("enrich", "Enrich", "execution_sweep", counts({ eligible: 1, succeeded: 1 })),
    stage("score", "Score", "execution_sweep", counts({ eligible: 1, succeeded: 1 })),
    stage("tailor", "Tailor", "execution_sweep", counts({ eligible: 1, succeeded: 1 })),
  ],
  activeItems: [],
  activeItemsTotal: 0,
  activeItemsTruncated: false,
  overallEta: { status: "unavailable", reason: "no_work", asOf: AS_OF },
});
