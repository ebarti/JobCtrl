import type {
  JobActiveStateChanged,
  JobUpdated,
  ResumeApproved,
  WorkflowCanceled,
  WorkflowCompleted,
  WorkflowFailed,
  WorkflowStarted,
  WorkflowTerminated,
  WorkflowTimedOut,
} from "@jobctrl/domain-types";

import type {
  ArtifactsListInput,
  DashboardSummary,
  JobsListInput,
  PaginatedResponse,
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

function isPage<T>(current: unknown): current is PaginatedResponse<T> {
  return isRecord(current) && Array.isArray(current.items)
    && isRecord(current.pagination) && isRecord(current.sort) && isRecord(current.filter);
}

const CLOSED_STATES = new Set(["closed", "expired", "removed", "location_incompatible"]);
const ACTIVE_STATES = new Set(["unknown", "active", ...CLOSED_STATES]);

export function reconcileJobActiveStatePage(
  current: unknown,
  input: JobsListInput,
  payload: JobActiveStateChanged["payload"],
): unknown {
  if (!isPage<JobSummary>(current) || !ACTIVE_STATES.has(payload.activeState)
    || !ACTIVE_STATES.has(payload.previousState)) return undefined;
  const queue = input.deleted ?? "active";
  if ((queue === "active" || queue === "closed")
    && CLOSED_STATES.has(payload.previousState) !== CLOSED_STATES.has(payload.activeState)) {
    return undefined;
  }
  return patchPageRows(current, (job) => job.jobKey === payload.jobId
    ? { ...job, activeState: payload.activeState } : job);
}

// Match the canonical jobs -> job_list_projections -> summary mapping.
// Other changed fields can affect derived labels, ranking or eligibility.
function jobDisplayPatch(payload: JobUpdated["payload"]): Partial<JobSummary> | undefined {
  if (!isRecord(payload.changedFields) || Object.keys(payload.changedFields).length === 0) return undefined;
  const patch: Partial<JobSummary> = {};
  for (const [field, value] of Object.entries(payload.changedFields)) {
    if (typeof value !== "string") return undefined;
    if (field === "title") patch.title = value || "Untitled";
    else if (field === "company") patch.company = value.trim() || "Unknown company";
    else return undefined;
  }
  return patch;
}

function patchPageRows<T>(page: PaginatedResponse<T>, patch: (row: T) => T): PaginatedResponse<T> {
  let changed = false;
  const items = page.items.map((row) => {
    const next = patch(row);
    changed ||= next !== row;
    return next;
  });
  return changed ? { ...page, items } : page;
}

export function reconcileJobUpdatedPage(
  current: unknown,
  input: JobsListInput,
  payload: JobUpdated["payload"],
): unknown {
  const patch = jobDisplayPatch(payload);
  if (!isPage<JobSummary>(current) || !patch || input.q
    || (patch.title !== undefined && input.sort === "title")
    || (patch.company !== undefined && (input.sort === "company" || input.company))) return undefined;
  return patchPageRows(current, (job) => job.jobKey === payload.jobId ? { ...job, ...patch } : job);
}

export function reconcileResumeApprovedPage(
  current: unknown,
  input: ArtifactsListInput,
  payload: ResumeApproved["payload"],
): unknown {
  if (!isPage<ArtifactSummary>(current) || input.q || input.status || input.sort === "status") return undefined;
  const artifact = current.items.find((row) => row.artifactId === payload.artifactId
    && row.jobKey === payload.jobId);
  // Approval can register a newly generated artifact or unsuppress one. Neither
  // page membership, total nor boundary can be reconstructed from this event.
  if (!artifact || !["candidate", "approved"].includes(artifact.status)) return undefined;
  return patchPageRows(current, (row) => row === artifact ? approveArtifact(row, payload.artifactId) : row);
}

export function patchDashboardJobLabels(current: unknown, payload: JobUpdated["payload"]): unknown {
  const patch = jobDisplayPatch(payload);
  if (!patch || !isRecord(current) || !isRecord(current.work)
    || !Array.isArray(current.work.stuckItems) || !Array.isArray(current.activity)
  ) return current;
  const summary = current as unknown as DashboardSummary;
  const patchRow = <T extends { jobKey: string | null }>(row: T): T =>
    row.jobKey === payload.jobId ? { ...row, ...patch } : row;
  return {
    ...summary,
    work: { ...summary.work, stuckItems: summary.work.stuckItems.map(patchRow) },
    activity: summary.activity.map(patchRow),
  };
}
