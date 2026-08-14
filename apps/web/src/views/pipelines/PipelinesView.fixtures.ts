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

const sourceEtaAvailable: PipelineEta = {
  status: "available",
  lowSeconds: 1_200,
  highSeconds: 1_260,
  confidence: "low",
  basis: "source_rate",
  sampleSize: 5,
  asOf: AS_OF,
  caveat:
    "Provider total is unavailable; range uses recent whole-family duration and bounded live capacity.",
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

const availableCapacity = {
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
} satisfies PipelineCapacity;

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
  stage(
    "source_family",
    "Crawl sources",
    "current_execution",
    counts({ eligible: 3, processing: 2, succeeded: 1 }),
    sourceEtaAvailable,
  ),
  stage("reconciliation", "Enrichment reconciliation", "current_execution", counts({ eligible: 2, waiting: 2 })),
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
      eta: sourceEtaAvailable,
      asOf: AS_OF,
      providerProgress: {
        site: "indeed",
        phase: "search",
        unit: "page",
        completedUnits: 3,
        totalUnits: null,
        rawItemsSeen: 42,
        jobsEmitted: 9,
        hasMore: true,
      },
    },
    reconciliation: {
      enrichment: counts({ eligible: 1, waiting: 1 }),
      preparationFanout: counts({ eligible: 1, waiting: 1 }),
      asOf: AS_OF,
    },
    projectionCoverage: {
      status: "ready",
      mode: "native",
      decoderVersion: 1,
      historyEventId: 89,
      membershipCount: 20,
      stepCount: 8,
      updatedAt: AS_OF,
    },
    stages: discoveringStages,
    activeStageCounts: [{ stage: "source_family", count: 2 }],
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

export const pipelinesIdleSnapshot = snapshot({
  execution: null,
  capacity: {
    ...availableCapacity,
    activeSlots: 0,
    availableSlots: availableCapacity.configuredSlots,
    slotSaturation: 0,
    approximateTaskQueue: {
      status: "available",
      observedAt: AS_OF,
      workflow: {
        pollerCount: 1,
        approximateBacklogCount: 0,
        approximateBacklogAgeSeconds: 0,
        tasksAddRate: 0,
        tasksDispatchRate: 0,
      },
      activity: {
        pollerCount: 1,
        approximateBacklogCount: 0,
        approximateBacklogAgeSeconds: 0,
        tasksAddRate: 0,
        tasksDispatchRate: 0,
      },
    },
  },
  sourceFamilies: null,
  reconciliation: null,
  projectionCoverage: null,
  stages: [],
  activeStageCounts: [],
  activeItems: [],
  activeItemsTotal: 0,
  activeItemsTruncated: false,
  overallEta: { status: "unavailable", reason: "no_work", asOf: AS_OF },
});

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
  activeStageCounts: [{ stage: "reconciliation", count: 1 }],
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
  activeStageCounts: [],
  activeItemsTotal: 0,
  activeItemsTruncated: false,
  overallEta: { status: "unavailable", reason: "no_work", asOf: AS_OF },
});

export const pipelinesFailedHistorySnapshot = snapshot({
  execution: {
    ...pipelinesDiscoveringSnapshot.execution!,
    selectedAs: "latest_terminal",
    workflowStatus: "terminated",
    phase: "failed",
    membershipClosed: false,
    finishedAt: "2026-07-14T12:04:00.000Z",
    errorCode: "reconciled_not_found",
    currentExecution: {
      members: 9,
      planned: 9,
      notEligible: 0,
      pending: 9,
      failedPlan: 0,
      terminal: 0,
      remaining: 9,
    },
    sweptExistingBacklog: {
      members: 11,
      planned: 11,
      notEligible: 0,
      pending: 11,
      failedPlan: 0,
      terminal: 0,
      remaining: 11,
    },
  },
  capacity: {
    ...availableCapacity,
    activeSlots: 0,
    availableSlots: 4,
    slotSaturation: 0,
  },
  stages: discoveringStages.map((entry) => ({
    ...entry,
    currentExecution: counts(),
    capacity: {
      ...availableCapacity,
      activeSlots: 0,
      availableSlots: 4,
      slotSaturation: 0,
    },
    eta: { status: "unavailable", reason: "no_work", asOf: AS_OF },
  })),
  activeItems: [],
  activeStageCounts: [],
  activeItemsTotal: 0,
  activeItemsTruncated: false,
  overallEta: { status: "unavailable", reason: "no_work", asOf: AS_OF },
});

export const pipelinesMixedFailureSnapshot = snapshot({
  stages: discoveringStages.map((entry) =>
    entry.stage === "source_family" && entry.scope === "current_execution"
      ? {
          ...entry,
          currentExecution: counts({
            eligible: 8,
            waiting: 1,
            processing: 1,
            succeeded: 2,
            blocked: 1,
            failed: 1,
            canceled: 1,
            needsVerification: 1,
          }),
        }
      : entry,
  ),
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
  activeStageCounts: null,
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
  activeStageCounts: null,
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
      stage: null,
    },
  ],
  activeItemsTotal: 9,
  activeItemsTruncated: true,
  activeStageCounts: [
    { stage: "source_family", count: 2 },
    { stage: "score", count: 7 },
  ],
});

export const pipelinesRecoveringProjectionSnapshot = snapshot({
  execution: {
    ...pipelinesDiscoveringSnapshot.execution!,
    currentExecution: {
      members: 0,
      planned: 0,
      notEligible: 0,
      pending: 0,
      failedPlan: 0,
      terminal: 0,
      remaining: 0,
    },
    sweptExistingBacklog: {
      members: 0,
      planned: 0,
      notEligible: 0,
      pending: 0,
      failedPlan: 0,
      terminal: 0,
      remaining: 0,
    },
  },
  capacity: {
    ...availableCapacity,
    activeSlots: 4,
    availableSlots: 0,
    slotSaturation: 1,
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
        approximateBacklogCount: 41,
        approximateBacklogAgeSeconds: 126,
        tasksAddRate: 1.2,
        tasksDispatchRate: 0.4,
      },
    },
  },
  sourceFamilies: {
    planned: 0,
    counts: counts(),
    eta: { status: "unavailable", reason: "contention_unbounded", asOf: AS_OF },
    asOf: AS_OF,
  },
  reconciliation: {
    enrichment: counts(),
    preparationFanout: counts(),
    asOf: AS_OF,
  },
  projectionCoverage: {
    status: "recovering",
    mode: "reconstructed",
    decoderVersion: 1,
    historyEventId: 89,
    expectedMembershipCount: 72,
    persistedMembershipCount: 15,
    expectedStepCount: 8,
    persistedStepCount: 3,
    updatedAt: AS_OF,
  },
  stages: discoveringStages.map((entry) => ({
    ...entry,
    currentExecution: counts(),
    eta: { status: "unavailable", reason: "contention_unbounded", asOf: AS_OF },
  })),
  activeStageCounts: [
    { stage: "source_family", count: 1 },
    { stage: "tailor", count: 3 },
  ],
  activeItems: [
    {
      kind: "unresolved_runtime_activity",
      activityType: "discovery_source_family",
      workflowId: "discover-local",
      executionId: "run-discover-20260714",
      attempt: 1,
      startedAt: "2026-07-14T11:50:00.000Z",
      opaqueId: "source-family-runtime-1",
      stage: "source_family",
    },
    ...[1, 2, 3].map((index) => ({
      kind: "unresolved_runtime_activity" as const,
      activityType: "tailor_job",
      workflowId: null,
      executionId: null,
      attempt: 1,
      startedAt: `2026-07-14T11:5${index}:00.000Z`,
      opaqueId: `tailor-runtime-${index}`,
      stage: "tailor",
    })),
  ],
  activeItemsTotal: 4,
  activeItemsTruncated: false,
  overallEta: {
    status: "unavailable",
    reason: "contention_unbounded",
    asOf: AS_OF,
  },
});

export const pipelinesRetryingProjectionSnapshot: PipelineOperationsSnapshot = {
  ...pipelinesRecoveringProjectionSnapshot,
  projectionCoverage: {
    status: "retrying",
    mode: "reconstructed",
    decoderVersion: 1,
    historyEventId: 89,
    expectedMembershipCount: 72,
    persistedMembershipCount: 15,
    expectedStepCount: 8,
    persistedStepCount: 3,
    errorCode: "recovery_manifest_set_mismatch",
    updatedAt: AS_OF,
  },
};

export const pipelinesTerminalRecoveringProjectionSnapshot: PipelineOperationsSnapshot = {
  ...pipelinesRecoveringProjectionSnapshot,
  execution: {
    ...pipelinesCompletedWithIssuesSnapshot.execution!,
    currentExecution: {
      members: 9,
      planned: 9,
      notEligible: 0,
      pending: 6,
      failedPlan: 0,
      terminal: 3,
      remaining: 6,
    },
    sweptExistingBacklog: {
      members: 11,
      planned: 11,
      notEligible: 0,
      pending: 7,
      failedPlan: 0,
      terminal: 4,
      remaining: 7,
    },
  },
  sourceFamilies: pipelinesCompletedWithIssuesSnapshot.sourceFamilies,
  reconciliation: pipelinesCompletedWithIssuesSnapshot.reconciliation,
  stages: pipelinesCompletedWithIssuesSnapshot.stages,
  activeStageCounts: [],
  activeItems: [],
  activeItemsTotal: 0,
  activeItemsTruncated: false,
  overallEta: etaAvailable,
  projectionCoverage: {
    status: "recovering",
    mode: "reconstructed",
    decoderVersion: 1,
    historyEventId: 89,
    expectedMembershipCount: 20,
    persistedMembershipCount: 7,
    expectedStepCount: 8,
    persistedStepCount: 3,
    updatedAt: AS_OF,
  },
};

export const pipelinesIncompleteProjectionSnapshot: PipelineOperationsSnapshot = {
  ...pipelinesTerminalRecoveringProjectionSnapshot,
  capacity: {
    ...availableCapacity,
    activeSlots: 0,
    availableSlots: 4,
    slotSaturation: 0,
  },
  execution: {
    ...pipelinesCompletedWithIssuesSnapshot.execution!,
    phase: "failed",
    workflowStatus: "failed",
    errorCode: "legacy-fanout-terminal-failed",
  },
  projectionCoverage: {
    status: "incomplete",
    mode: "reconstructed",
    decoderVersion: 2,
    historyEventId: 119,
    expectedMembershipCount: null,
    persistedMembershipCount: 7,
    expectedStepCount: null,
    persistedStepCount: 4,
    errorCode: "legacy-fanout-terminal-failed",
    updatedAt: AS_OF,
  },
};

export const pipelinesPartialSweepRecoveringSnapshot: PipelineOperationsSnapshot = {
  ...pipelinesRecoveringProjectionSnapshot,
  execution: {
    ...pipelinesDiscoveringSnapshot.execution!,
    phase: "draining",
    membershipClosed: true,
    currentExecution: {
      members: 59,
      planned: 59,
      notEligible: 0,
      pending: 41,
      failedPlan: 0,
      terminal: 18,
      remaining: 41,
    },
    sweptExistingBacklog: {
      members: 97,
      planned: 97,
      notEligible: 0,
      pending: 83,
      failedPlan: 0,
      terminal: 14,
      remaining: 83,
    },
  },
  sourceFamilies: {
    planned: 47,
    counts: counts({ eligible: 47, processing: 4, succeeded: 43 }),
    eta: etaAvailable,
    asOf: AS_OF,
  },
  reconciliation: {
    enrichment: counts({ eligible: 31, waiting: 29, succeeded: 2 }),
    preparationFanout: counts({ eligible: 23, waiting: 19, succeeded: 4 }),
    asOf: AS_OF,
  },
  stages: discoveringStages.map((entry) => ({
    ...entry,
    currentExecution:
      entry.scope === "execution_sweep"
        ? counts({ eligible: 97, waiting: 83, succeeded: 14 })
        : entry.scope === "current_execution"
          ? counts({ eligible: 59, waiting: 41, succeeded: 18 })
          : entry.currentExecution,
    eta: etaAvailable,
  })),
  overallEta: etaAvailable,
  projectionCoverage: {
    status: "recovering",
    mode: "reconstructed",
    decoderVersion: 1,
    historyEventId: 89,
    expectedMembershipCount: 156,
    persistedMembershipCount: 53,
    expectedStepCount: 47,
    persistedStepCount: 18,
    updatedAt: AS_OF,
  },
};

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
    stage("reconciliation", "Enrichment reconciliation", "current_execution", counts({ eligible: 2, succeeded: 2 })),
    stage("enrich", "Enrich", "execution_sweep", counts({ eligible: 1, succeeded: 1 })),
    stage("score", "Score", "execution_sweep", counts({ eligible: 1, succeeded: 1 })),
    stage("tailor", "Tailor", "execution_sweep", counts({ eligible: 1, succeeded: 1 })),
  ],
  activeItems: [],
  activeStageCounts: [],
  activeItemsTotal: 0,
  activeItemsTruncated: false,
  overallEta: { status: "unavailable", reason: "no_work", asOf: AS_OF },
});
