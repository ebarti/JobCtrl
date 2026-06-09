import type {
  BulletProvenanceRecorded,
  CoverLetterGenerated,
  EmployerAnalyzed,
  MaterialsExhausted,
  PdfRendered,
  ResumeApproved,
  ResumeFailed,
  TailoredArtifactsSuppressed,
  TailorRetailorRequested,
} from "@jobhunter/domain-types";

import { artifactsKeys } from "../operations/artifactsKeys.js";
import { dashboardKeys } from "../operations/dashboardKeys.js";
import { invalidate, type InvalidationItem } from "../operations/invalidation-router.js";
import { jobsKeys } from "../operations/jobsKeys.js";

export const resumeApprovedHandler = (
  event: ResumeApproved,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(artifactsKeys.lists(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const resumeFailedHandler = (event: ResumeFailed): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const coverLetterGeneratedHandler = (
  event: CoverLetterGenerated,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(artifactsKeys.lists(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const pdfRenderedHandler = (event: PdfRendered): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(artifactsKeys.lists(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const materialsExhaustedHandler = (
  event: MaterialsExhausted,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const employerAnalyzedHandler = (
  event: EmployerAnalyzed,
): readonly InvalidationItem[] => [
  // The canonical employer analysis is served on the job detail; refresh it so
  // the inspector (Phase 5) shows the latest generation.
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
];

export const bulletProvenanceRecordedHandler = (
  event: BulletProvenanceRecorded,
): readonly InvalidationItem[] => [
  // Per-bullet provenance is served on the artifact's tailoring explanation
  // (Phase 2) and surfaces in the job detail; refresh both so the inspector
  // (Phase 5) shows the latest generation's provenance.
  invalidate(artifactsKeys.detail(event.tenantId, event.payload.artifactId)),
  invalidate(artifactsKeys.lists(event.tenantId)),
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
];

export const tailorRetailorRequestedHandler = (
  event: TailorRetailorRequested,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const tailoredArtifactsSuppressedHandler = (
  event: TailoredArtifactsSuppressed,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(artifactsKeys.lists(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];
