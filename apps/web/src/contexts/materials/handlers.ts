import type {
  BulletProvenanceRecorded,
  CoverLetterGenerated,
  EmployerAnalyzed,
  InterviewPrepFailed,
  InterviewPrepGenerated,
  MaterialsExhausted,
  PdfRendered,
  ResumeApproved,
  ResumeFailed,
  ResumeTemplateDefaultChanged,
  ResumeTemplateRefreshCompleted,
  ResumeTemplateRefreshFailed,
  ResumeTemplateVersionSaved,
  TailoredArtifactsSuppressed,
  TailorRetailorRequested,
  JobResumeTemplateAssigned,
} from "@jobctrl/domain-types";

import { applyReviewKeys } from "../operations/applyReviewKeys.js";
import { artifactsKeys } from "../operations/artifactsKeys.js";
import { dashboardKeys } from "../operations/dashboardKeys.js";
import {
  invalidate,
  patchQuery,
  type InvalidationItem,
} from "../operations/invalidation-router.js";
import { jobsKeys } from "../operations/jobsKeys.js";
import { patchResumeApproved } from "../operations/realtimePatches.js";
import { profileKeys } from "../profile/queryKeys.js";

export const resumeApprovedHandler = (
  event: ResumeApproved,
): readonly InvalidationItem[] => [
  // Patch only already-registered detail rows. This event does not carry the
  // complete artifact summary needed to insert or refilter an artifact page.
  patchQuery(
    jobsKeys.detail(event.tenantId, event.payload.jobId),
    (current) => patchResumeApproved(current, event.payload),
  ),
  patchQuery(
    artifactsKeys.detail(event.tenantId, event.payload.artifactId),
    (current) => patchResumeApproved(current, event.payload),
  ),
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

export const interviewPrepGeneratedHandler = (
  event: InterviewPrepGenerated,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const interviewPrepFailedHandler = (
  event: InterviewPrepFailed,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
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

export const resumeTemplateVersionSavedHandler = (
  event: ResumeTemplateVersionSaved,
): readonly InvalidationItem[] => [
  invalidate(profileKeys.resumeTemplates(event.tenantId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(artifactsKeys.lists(event.tenantId)),
];

export const resumeTemplateDefaultChangedHandler = (
  event: ResumeTemplateDefaultChanged,
): readonly InvalidationItem[] => [
  invalidate(profileKeys.resumeTemplates(event.tenantId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(artifactsKeys.lists(event.tenantId)),
  invalidate(applyReviewKeys.all(event.tenantId)),
];

export const jobResumeTemplateAssignedHandler = (
  event: JobResumeTemplateAssigned,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(artifactsKeys.lists(event.tenantId)),
  invalidate(applyReviewKeys.all(event.tenantId)),
];

export const resumeTemplateRefreshCompletedHandler = (
  event: ResumeTemplateRefreshCompleted,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(artifactsKeys.lists(event.tenantId)),
  invalidate(applyReviewKeys.all(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];

export const resumeTemplateRefreshFailedHandler = (
  event: ResumeTemplateRefreshFailed,
): readonly InvalidationItem[] => [
  invalidate(jobsKeys.detail(event.tenantId, event.payload.jobId)),
  invalidate(jobsKeys.lists(event.tenantId)),
  invalidate(applyReviewKeys.all(event.tenantId)),
];
