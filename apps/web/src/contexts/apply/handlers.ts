import type {
  ApplicationEmailFeedbackIngested,
  ApplicationFailed,
  ApplicationOutcomeRecorded,
  ApplicationSubmitted,
  ApplyReviewDecisionRecorded,
  ApplyRunEventRecorded,
  ApplyRunStarted,
  ApplySubmitIntended,
  EmailApplicationCandidateRecorded,
  OutcomeSuggestionDecided,
} from "@jobctrl/domain-types";

import { analyticsKeys } from "../operations/analyticsKeys.js";
import { applyRunsKeys } from "../operations/applyRunsKeys.js";
import { applyReviewKeys } from "../operations/applyReviewKeys.js";
import { dashboardKeys } from "../operations/dashboardKeys.js";
import { digestKeys } from "../operations/digestKeys.js";
import {
  invalidate,
  patchApplyRunEvent,
  type InvalidationItem,
} from "../operations/invalidation-router.js";
import { jobsKeys } from "../operations/jobsKeys.js";
import { outcomesKeys } from "../operations/outcomesKeys.js";
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

export const applySubmitIntendedHandler = (
  event: ApplySubmitIntended,
): readonly InvalidationItem[] => [
  invalidate(applyRunsKeys.lists(event.tenantId)),
  invalidate(applyRunsKeys.detail(event.tenantId, event.payload.runId)),
  invalidate(applyReviewKeys.queue(event.tenantId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobKey)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const applicationEmailFeedbackIngestedHandler = (
  event: ApplicationEmailFeedbackIngested,
): readonly InvalidationItem[] => [
  invalidate(outcomesKeys.lists(event.tenantId)),
  invalidate(outcomesKeys.detail(event.tenantId, event.payload.jobKey)),
  invalidate(applyReviewKeys.queue(event.tenantId)),
  invalidate(analyticsKeys.all(event.tenantId)),
];

export const applyReviewDecisionRecordedHandler = (
  event: ApplyReviewDecisionRecorded,
): readonly InvalidationItem[] => [
  invalidate(applyReviewKeys.queue(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobKey)),
  invalidate(dashboardKeys.summary(event.tenantId)),
  invalidate(digestKeys.all(event.tenantId)),
];

type ApplicationOutcomeEvent = ApplicationOutcomeRecorded | OutcomeSuggestionDecided;

const applicationOutcomeHandler = (
  event: ApplicationOutcomeEvent,
): readonly InvalidationItem[] => [
  invalidate(outcomesKeys.lists(event.tenantId)),
  invalidate(outcomesKeys.detail(event.tenantId, event.payload.jobKey)),
  invalidate(analyticsKeys.all(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobKey)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const applicationOutcomeRecordedHandler = applicationOutcomeHandler;
export const outcomeSuggestionDecidedHandler = applicationOutcomeHandler;

export const emailApplicationCandidateRecordedHandler = (
  event: EmailApplicationCandidateRecorded,
): readonly InvalidationItem[] => [
  invalidate(applyReviewKeys.queue(event.tenantId)),
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
  invalidate(analyticsKeys.all(event.tenantId)),
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
  invalidate(analyticsKeys.all(event.tenantId)),
];
