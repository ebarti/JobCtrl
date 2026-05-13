import type {
  ContentDuplicateCandidateDetected,
  EnrichmentFailed,
  JobActiveStateChanged,
  JobEnriched,
  PostingContentSnapshotCaptured,
  PostingContentSnapshotFailed,
} from "@jobhunter/domain-types";

import { dashboardKeys } from "../operations/dashboardKeys.js";
import { discoveryKeys } from "../discovery/queryKeys.js";
import { invalidate, type InvalidationItem } from "../operations/invalidation-router.js";
import { jobsKeys } from "../operations/jobsKeys.js";

export const jobEnrichedHandler = (event: JobEnriched): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const enrichmentFailedHandler = (
  event: EnrichmentFailed,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

// PR3 events ----------------------------------------------------------------

/**
 * A new content snapshot was captured. Invalidate the job detail (so the
 * latest snapshot version, active state, and quarantine flag refresh) and
 * the source-quality projection (snapshot success contributes to the rate).
 */
export const postingContentSnapshotCapturedHandler = (
  event: PostingContentSnapshotCaptured,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(discoveryKeys.sourceQuality(event.tenantId)),
];

/**
 * A snapshot capture failed without producing a snapshot. Invalidate the
 * detail (so the failure surfaces as a retryable banner) and the
 * source-quality projection.
 */
export const postingContentSnapshotFailedHandler = (
  event: PostingContentSnapshotFailed,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(discoveryKeys.sourceQuality(event.tenantId)),
];

/**
 * Active-state changed for a job. Invalidate the list (badges/filters react
 * to active state) and the detail panel.
 */
export const jobActiveStateChangedHandler = (
  event: JobActiveStateChanged,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

/**
 * A content-duplicate candidate was registered. Invalidate the candidate's
 * detail (so the dedupe queue surfaces the new pairing) and the
 * source-quality projection so duplicate-rate updates.
 */
export const contentDuplicateCandidateDetectedHandler = (
  event: ContentDuplicateCandidateDetected,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.candidateJobId)),
  invalidate(discoveryKeys.sourceQuality(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];
