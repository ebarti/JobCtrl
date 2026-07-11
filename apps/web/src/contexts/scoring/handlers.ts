import type { JobScored, ScoreCorrected, ScoreRescoreRequested } from "@jobctrl/domain-types";

import { dashboardKeys } from "../operations/dashboardKeys.js";
import { applyReviewKeys } from "../operations/applyReviewKeys.js";
import { digestKeys } from "../operations/digestKeys.js";
import { invalidate, type InvalidationItem } from "../operations/invalidation-router.js";
import { jobsKeys } from "../operations/jobsKeys.js";

export const jobScoredHandler = (event: JobScored): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const scoreCorrectedHandler = (event: ScoreCorrected): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(applyReviewKeys.queue(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
  invalidate(digestKeys.all(event.tenantId)),
];

export const scoreRescoreRequestedHandler = (
  event: ScoreRescoreRequested,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];
