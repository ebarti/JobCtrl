import type {
  StageBlocked,
  StageCanceled,
  StageCompleted,
  StageExhausted,
  StageFailed,
  StageReset,
  StageSkipped,
  StageStarted,
  PreparationWorkItemCompleted,
  PreparationWorkItemFailed,
  PreparationWorkItemQueued,
  PreparationWorkItemStarted,
  PipelineStepCompleted,
  PipelineStepFailed,
  PipelineStepQueued,
  PipelineStepStarted,
  TenantId,
  WorkflowStarted,
  WorkflowCompleted,
  WorkflowFailed,
  WorkflowCanceled,
  WorkflowTimedOut,
  WorkflowTerminated,
} from "@jobctrl/domain-types";

import { artifactsKeys } from "../operations/artifactsKeys.js";
import { applyReviewKeys } from "../operations/applyReviewKeys.js";
import { dashboardKeys } from "../operations/dashboardKeys.js";
import { digestKeys } from "../operations/digestKeys.js";
import { invalidate, type InvalidationItem } from "../operations/invalidation-router.js";
import { jobsKeys } from "../operations/jobsKeys.js";
import { workflowRunsKeys } from "../operations/workflowRunsKeys.js";
import { pipelineKeys } from "./queryKeys.js";

const pipelineOperationsInvalidation = (tenantId: TenantId): InvalidationItem =>
  invalidate(pipelineKeys.operations(tenantId));

export const stageStartedHandler = (event: StageStarted): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
  pipelineOperationsInvalidation(event.tenantId),
];

export const stageCompletedHandler = (
  event: StageCompleted,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
  pipelineOperationsInvalidation(event.tenantId),
];

export const stageFailedHandler = (event: StageFailed): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
  pipelineOperationsInvalidation(event.tenantId),
];

export const stageExhaustedHandler = (
  event: StageExhausted,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
  pipelineOperationsInvalidation(event.tenantId),
];

export const stageResetHandler = (event: StageReset): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  pipelineOperationsInvalidation(event.tenantId),
];

export const stageBlockedHandler = (event: StageBlocked): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
  pipelineOperationsInvalidation(event.tenantId),
];

export const stageSkippedHandler = (event: StageSkipped): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(applyReviewKeys.queue(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
  invalidate(digestKeys.all(event.tenantId)),
  pipelineOperationsInvalidation(event.tenantId),
];

export const stageCanceledHandler = (
  event: StageCanceled,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(applyReviewKeys.queue(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
  invalidate(digestKeys.all(event.tenantId)),
  pipelineOperationsInvalidation(event.tenantId),
];

type PreparationWorkItemEvent =
  | PreparationWorkItemQueued
  | PreparationWorkItemStarted
  | PreparationWorkItemCompleted
  | PreparationWorkItemFailed;

const preparationWorkItemHandler = (
  event: PreparationWorkItemEvent,
): readonly InvalidationItem[] => {
  const invalidations = [
    invalidate(jobsKeys.lists(event.tenantId)),
    invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
    pipelineOperationsInvalidation(event.tenantId),
  ];
  if (
    event.eventType === "PreparationWorkItemCompleted" &&
    event.payload.kind === "suppress_tailored_artifacts"
  ) {
    invalidations.push(invalidate(artifactsKeys.lists(event.tenantId)));
  }
  invalidations.push(invalidate(dashboardKeys.summary(event.tenantId)));
  return invalidations;
};

export const preparationWorkItemQueuedHandler = preparationWorkItemHandler;
export const preparationWorkItemStartedHandler = preparationWorkItemHandler;
export const preparationWorkItemCompletedHandler = preparationWorkItemHandler;
export const preparationWorkItemFailedHandler = preparationWorkItemHandler;

type PipelineStepLifecycleEvent =
  | PipelineStepQueued
  | PipelineStepStarted
  | PipelineStepCompleted
  | PipelineStepFailed;

// The global activity-list invalidation is appended by dispatch.
const pipelineStepLifecycleHandler = (
  event: PipelineStepLifecycleEvent,
): readonly InvalidationItem[] => [
  invalidate(workflowRunsKeys.lists(event.tenantId)),
  invalidate(
    workflowRunsKeys.detail(event.tenantId, event.payload.execution.workflowId),
  ),
  pipelineOperationsInvalidation(event.tenantId),
];

export const pipelineStepQueuedHandler = pipelineStepLifecycleHandler;
export const pipelineStepStartedHandler = pipelineStepLifecycleHandler;
export const pipelineStepCompletedHandler = pipelineStepLifecycleHandler;
export const pipelineStepFailedHandler = pipelineStepLifecycleHandler;

// Temporal workflow lifecycle (P0 loop closure). Every start marker and
// terminal event refreshes the Workflow Runs list + the run's detail drawer
// so a failed / canceled / terminated run terminalizes in-app without a
// manual refresh. All six events carry `workflowId`, so one handler serves
// the whole family.
type WorkflowLifecycleEvent =
  | WorkflowStarted
  | WorkflowCompleted
  | WorkflowFailed
  | WorkflowCanceled
  | WorkflowTimedOut
  | WorkflowTerminated;

const workflowLifecycleHandler = (
  event: WorkflowLifecycleEvent,
): readonly InvalidationItem[] => [
  invalidate(workflowRunsKeys.lists(event.tenantId)),
  invalidate(workflowRunsKeys.detail(event.tenantId, event.payload.workflowId)),
  pipelineOperationsInvalidation(event.tenantId),
];

export const workflowStartedHandler = workflowLifecycleHandler;
export const workflowCompletedHandler = workflowLifecycleHandler;
export const workflowFailedHandler = workflowLifecycleHandler;
export const workflowCanceledHandler = (
  event: WorkflowCanceled,
): readonly InvalidationItem[] => [
  ...workflowLifecycleHandler(event),
  invalidate(applyReviewKeys.queue(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];
export const workflowTimedOutHandler = workflowLifecycleHandler;
export const workflowTerminatedHandler = workflowLifecycleHandler;
