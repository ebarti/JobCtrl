import type {
  ApplicationFailed,
  ApplicationSubmitted,
  ApplyRunEventRecorded,
  ApplyRunStarted,
} from "@jobhunter/domain-types";

import { applyRunsKeys } from "../operations/applyRunsKeys.js";
import { dashboardKeys } from "../operations/dashboardKeys.js";
import {
  invalidate,
  patchApplyRunEvent,
  type InvalidationItem,
} from "../operations/invalidation-router.js";
import { jobsKeys } from "../operations/jobsKeys.js";
import { workflowRunsKeys } from "../operations/workflowRunsKeys.js";

export const applyRunStartedHandler = (
  event: ApplyRunStarted,
): readonly InvalidationItem[] => [
  invalidate(applyRunsKeys.lists(event.tenantId)),
  invalidate(workflowRunsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

// Per target §7.5 / §8.4: high-frequency apply-run timeline events
// patch the cached projection in place rather than triggering a refetch
// per per-second tick.  The patch is a no-op when the apply-run drawer
// is closed (no cache entry yet); reopen re-fetches and reconciles.
export const applyRunEventRecordedHandler = (
  event: ApplyRunEventRecorded,
): readonly InvalidationItem[] => [
  patchApplyRunEvent(event.tenantId, event.payload.runId, event),
];

export const applicationSubmittedHandler = (
  event: ApplicationSubmitted,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(applyRunsKeys.lists(event.tenantId)),
  invalidate(applyRunsKeys.detail(event.tenantId, event.payload.runId)),
  invalidate(workflowRunsKeys.lists(event.tenantId)),
  invalidate(workflowRunsKeys.detail(event.tenantId, event.payload.runId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const applicationFailedHandler = (
  event: ApplicationFailed,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(applyRunsKeys.lists(event.tenantId)),
  invalidate(applyRunsKeys.detail(event.tenantId, event.payload.runId)),
  invalidate(workflowRunsKeys.lists(event.tenantId)),
  invalidate(workflowRunsKeys.detail(event.tenantId, event.payload.runId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];
