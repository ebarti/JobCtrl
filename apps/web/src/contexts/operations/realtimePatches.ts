import type {
  WorkflowCanceled,
  WorkflowCompleted,
  WorkflowFailed,
  WorkflowStarted,
  WorkflowTerminated,
  WorkflowTimedOut,
} from "@jobctrl/domain-types";

import type {
  ArtifactDetail,
  ArtifactSummary,
  JobDetail,
  JobSummary,
  WorkflowRunDetail,
} from "./types.js";

export type WorkflowLifecycleEvent =
  | WorkflowStarted
  | WorkflowCompleted
  | WorkflowFailed
  | WorkflowCanceled
  | WorkflowTimedOut
  | WorkflowTerminated;

const ACTIVE_WORKFLOW_STATUSES = new Set(["starting", "in_progress"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patchJobDetail(
  current: unknown,
  jobId: string,
  patch: (job: JobSummary) => JobSummary,
): unknown {
  if (isRecord(current) && isRecord(current.job) && typeof current.job.jobKey === "string") {
    const detail = current as unknown as JobDetail;
    if (detail.job.jobKey !== jobId) {
      return current;
    }
    return {
      ...detail,
      job: patch(detail.job),
    };
  }
  return current;
}

export function patchJobActiveState(
  current: unknown,
  payload: { readonly jobId: string; readonly activeState: JobSummary["activeState"] },
): unknown {
  return patchJobDetail(current, payload.jobId, (job) => ({
    ...job,
    activeState: payload.activeState,
  }));
}

function approveArtifact(artifact: ArtifactSummary, artifactId: string): ArtifactSummary {
  return artifact.artifactId === artifactId ? { ...artifact, status: "approved" } : artifact;
}

export function patchResumeApproved(
  current: unknown,
  payload: { readonly jobId: string; readonly artifactId: string },
): unknown {
  if (isRecord(current) && isRecord(current.artifact)) {
    const detail = current as unknown as ArtifactDetail;
    const artifact = approveArtifact(detail.artifact, payload.artifactId);
    if (artifact === detail.artifact) {
      return current;
    }
    return {
      ...detail,
      artifact,
    };
  }
  if (
    isRecord(current)
    && isRecord(current.job)
    && current.job.jobKey === payload.jobId
    && Array.isArray(current.artifacts)
  ) {
    const detail = current as unknown as JobDetail;
    let changed = false;
    const artifacts = detail.artifacts.map((artifact) => {
      const next = approveArtifact(artifact, payload.artifactId);
      changed ||= next !== artifact;
      return next;
    });
    return changed ? { ...detail, artifacts } : current;
  }
  return current;
}

function workflowEventTimestamp(event: WorkflowLifecycleEvent): string | null {
  if (typeof event.occurredAt === "string" && event.occurredAt.length > 0) {
    return event.occurredAt;
  }
  return event.eventType === "WorkflowStarted"
    ? event.payload.startedAt
    : event.payload.finishedAt;
}

function workflowEventMessage(event: WorkflowLifecycleEvent): string | null {
  if (event.eventType === "WorkflowCompleted" || event.eventType === "WorkflowStarted") {
    return null;
  }
  return event.payload.errorMessage || null;
}

export function patchWorkflowRunDetail(
  current: unknown,
  event: WorkflowLifecycleEvent,
): unknown {
  if (!isRecord(current) || current.workflowId !== event.payload.workflowId) {
    return current;
  }
  const detail = current as unknown as WorkflowRunDetail;
  const occurredAt = workflowEventTimestamp(event);
  const message = workflowEventMessage(event);
  const timelineEvent = {
    eventType: event.eventType,
    occurredAt,
    status: event.payload.status,
    message,
  };
  const duplicate = detail.events.some(
    (entry) =>
      entry.eventType === timelineEvent.eventType
      && entry.occurredAt === timelineEvent.occurredAt
      && entry.status === timelineEvent.status
      && entry.message === timelineEvent.message,
  );
  const base = {
    ...detail,
    workflowType: event.payload.workflowType,
    status: event.payload.status,
    temporalRunId: event.payload.temporalRunId,
    events: duplicate ? detail.events : [...detail.events, timelineEvent],
  };
  if (!event.payload.temporalRunId) {
    return { ...detail, events: base.events };
  }
  if (event.eventType === "WorkflowStarted") {
    const recoveredMissingHistory =
      detail.status === "terminated"
      && detail.errorCode === "reconciled_not_found"
      && event.payload.recoveredFromMissingHistory === true
      && Boolean(event.payload.temporalRunId)
      && event.payload.temporalRunId === detail.temporalRunId;
    const startsNewExecution =
      Boolean(event.payload.temporalRunId)
      && Boolean(detail.temporalRunId)
      && event.payload.temporalRunId !== detail.temporalRunId;
    if (
      !ACTIVE_WORKFLOW_STATUSES.has(detail.status)
      && !recoveredMissingHistory
      && !startsNewExecution
    ) {
      return { ...detail, events: base.events };
    }
    return {
      ...base,
      inputSummary: event.payload.inputSummary,
      startedAt: event.payload.startedAt ?? occurredAt ?? detail.startedAt,
      finishedAt: null,
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      result: null,
    };
  }
  const executionMismatch =
    !detail.temporalRunId
    || event.payload.temporalRunId !== detail.temporalRunId;
  if (!ACTIVE_WORKFLOW_STATUSES.has(detail.status) || executionMismatch) {
    return { ...detail, events: base.events };
  }
  if (event.eventType === "WorkflowCompleted") {
    return {
      ...base,
      finishedAt: event.payload.finishedAt ?? occurredAt ?? detail.finishedAt,
      durationMs: event.payload.durationMs ?? detail.durationMs,
      errorCode: null,
      errorMessage: null,
      retryable: false,
    };
  }
  return {
    ...base,
    finishedAt: event.payload.finishedAt ?? occurredAt ?? detail.finishedAt,
    durationMs: event.payload.durationMs ?? detail.durationMs,
    errorCode: event.payload.errorCode || null,
    errorMessage: event.payload.errorMessage || null,
    retryable: event.eventType === "WorkflowFailed" ? event.payload.retryable : false,
  };
}
