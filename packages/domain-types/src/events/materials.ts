/**
 * Materials Generation domain events.
 *
 * @see ddd-target.md §4.5
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

// -- ResumeApproved ---------------------------------------------------------

export interface ResumeApprovedPayload {
  readonly jobId: string;
  readonly artifactId: string;
  readonly generation: number;
  readonly approvedAt: string;
}

export type ResumeApproved = DomainEvent<"ResumeApproved", ResumeApprovedPayload>;

export function createResumeApproved(tenantId: TenantId, payload: ResumeApprovedPayload): ResumeApproved {
  return createDomainEvent("ResumeApproved", tenantId, payload);
}

// -- ResumeFailed -----------------------------------------------------------

export interface ResumeFailedPayload {
  readonly jobId: string;
  readonly validationErrors: readonly string[];
  readonly attemptNumber: number;
}

export type ResumeFailed = DomainEvent<"ResumeFailed", ResumeFailedPayload>;

export function createResumeFailed(tenantId: TenantId, payload: ResumeFailedPayload): ResumeFailed {
  return createDomainEvent("ResumeFailed", tenantId, payload);
}

// -- CoverLetterGenerated ---------------------------------------------------

export interface CoverLetterGeneratedPayload {
  readonly jobId: string;
  readonly artifactId: string;
  readonly generatedAt: string;
}

export type CoverLetterGenerated = DomainEvent<"CoverLetterGenerated", CoverLetterGeneratedPayload>;

export function createCoverLetterGenerated(
  tenantId: TenantId,
  payload: CoverLetterGeneratedPayload,
): CoverLetterGenerated {
  return createDomainEvent("CoverLetterGenerated", tenantId, payload);
}

// -- PdfRendered ------------------------------------------------------------

export interface PdfRenderedPayload {
  readonly jobId: string;
  readonly artifactType: string;
  readonly artifactId: string;
  readonly renderedAt: string;
}

export type PdfRendered = DomainEvent<"PdfRendered", PdfRenderedPayload>;

export function createPdfRendered(tenantId: TenantId, payload: PdfRenderedPayload): PdfRendered {
  return createDomainEvent("PdfRendered", tenantId, payload);
}

// -- MaterialsExhausted -----------------------------------------------------

export interface MaterialsExhaustedPayload {
  readonly jobId: string;
  readonly stage: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

export type MaterialsExhausted = DomainEvent<"MaterialsExhausted", MaterialsExhaustedPayload>;

export function createMaterialsExhausted(tenantId: TenantId, payload: MaterialsExhaustedPayload): MaterialsExhausted {
  return createDomainEvent("MaterialsExhausted", tenantId, payload);
}

// -- EmployerAnalyzed -------------------------------------------------------

/**
 * Phase 1 — a canonical employer analysis was persisted for a job.
 *
 * Carries the snapshot+version cache key and the degraded-ensemble signal
 * (`legsSucceeded` / `legsAttempted`) so the read-side and audit trail see a
 * degraded ensemble immediately (D-08).
 */
export interface EmployerAnalyzedPayload {
  readonly jobId: string;
  readonly generation: number;
  readonly snapshotHash: string;
  readonly cacheKey: string;
  readonly legsAttempted: number;
  readonly legsSucceeded: number;
  readonly analyzedAt: string;
  readonly cached: boolean;
}

export type EmployerAnalyzed = DomainEvent<"EmployerAnalyzed", EmployerAnalyzedPayload>;

export function createEmployerAnalyzed(tenantId: TenantId, payload: EmployerAnalyzedPayload): EmployerAnalyzed {
  return createDomainEvent("EmployerAnalyzed", tenantId, payload);
}

// -- BulletProvenanceRecorded ----------------------------------------------

/**
 * Phase 2 — canonical per-bullet provenance was recorded for an artifact.
 *
 * Emitted when an accepted tailored resume's provenance rows are persisted
 * (generation-versioned, bound to the `artifactId` they explain). Carries the
 * bullet count so the read-side projection rebuilds and the inspector refreshes.
 */
export interface BulletProvenanceRecordedPayload {
  readonly jobId: string;
  readonly artifactId: string;
  readonly generation: number;
  readonly bulletCount: number;
  readonly recordedAt: string;
}

export type BulletProvenanceRecorded = DomainEvent<"BulletProvenanceRecorded", BulletProvenanceRecordedPayload>;

export function createBulletProvenanceRecorded(
  tenantId: TenantId,
  payload: BulletProvenanceRecordedPayload,
): BulletProvenanceRecorded {
  return createDomainEvent("BulletProvenanceRecorded", tenantId, payload);
}

// -- TailorRetailorRequested -----------------------------------------------

export const RETAILOR_REQUEST_KINDS = ["single_job", "bulk_current_policy", "policy_update", "repair"] as const;
export type RetailorRequestKind = (typeof RETAILOR_REQUEST_KINDS)[number];

export interface TailorRetailorRequestedPayload {
  readonly requestId: string;
  readonly jobId: string;
  readonly requestKind: RetailorRequestKind;
  readonly currentPolicyVersion: number;
  readonly latestArtifactPolicyVersion: number | null;
  readonly reason: string;
  readonly requestedAt: string;
  readonly sourceEventId?: string | null;
}

export type TailorRetailorRequested = DomainEvent<"TailorRetailorRequested", TailorRetailorRequestedPayload>;

export function createTailorRetailorRequested(
  tenantId: TenantId,
  payload: TailorRetailorRequestedPayload,
): TailorRetailorRequested {
  return createDomainEvent("TailorRetailorRequested", tenantId, payload);
}

// -- TailoredArtifactsSuppressed -------------------------------------------

export interface TailoredArtifactsSuppressedPayload {
  readonly jobId: string;
  readonly artifactIds: readonly string[];
  readonly suppressionReason: string;
  readonly suppressedAt: string;
  readonly currentFitScore?: number;
  readonly scoreThreshold?: number;
  readonly currentTailoringPolicyVersion?: number;
}

export type TailoredArtifactsSuppressed = DomainEvent<
  "TailoredArtifactsSuppressed",
  TailoredArtifactsSuppressedPayload
>;

export function createTailoredArtifactsSuppressed(
  tenantId: TenantId,
  payload: TailoredArtifactsSuppressedPayload,
): TailoredArtifactsSuppressed {
  return createDomainEvent("TailoredArtifactsSuppressed", tenantId, payload);
}

// -- ResumeTemplateVersionSaved --------------------------------------------

export interface ResumeTemplateVersionSavedPayload {
  readonly templateId: string;
  readonly templateVersionId: string;
  readonly versionNumber: number;
  readonly displayName: string;
  readonly savedAt: string;
}

export type ResumeTemplateVersionSaved = DomainEvent<
  "ResumeTemplateVersionSaved",
  ResumeTemplateVersionSavedPayload
>;

export function createResumeTemplateVersionSaved(
  tenantId: TenantId,
  payload: ResumeTemplateVersionSavedPayload,
): ResumeTemplateVersionSaved {
  return createDomainEvent("ResumeTemplateVersionSaved", tenantId, payload);
}

// -- ResumeTemplateDefaultChanged ------------------------------------------

export interface ResumeTemplateDefaultChangedPayload {
  readonly templateId: string;
  readonly templateVersionId: string;
  readonly changedAt: string;
}

export type ResumeTemplateDefaultChanged = DomainEvent<
  "ResumeTemplateDefaultChanged",
  ResumeTemplateDefaultChangedPayload
>;

export function createResumeTemplateDefaultChanged(
  tenantId: TenantId,
  payload: ResumeTemplateDefaultChangedPayload,
): ResumeTemplateDefaultChanged {
  return createDomainEvent("ResumeTemplateDefaultChanged", tenantId, payload);
}

// -- JobResumeTemplateAssigned ---------------------------------------------

export interface JobResumeTemplateAssignedPayload {
  readonly jobId: string;
  readonly templateId: string | null;
  readonly templateVersionId: string | null;
  readonly assignedAt: string;
}

export type JobResumeTemplateAssigned = DomainEvent<
  "JobResumeTemplateAssigned",
  JobResumeTemplateAssignedPayload
>;

export function createJobResumeTemplateAssigned(
  tenantId: TenantId,
  payload: JobResumeTemplateAssignedPayload,
): JobResumeTemplateAssigned {
  return createDomainEvent("JobResumeTemplateAssigned", tenantId, payload);
}

// -- ResumeTemplateRefreshCompleted ----------------------------------------

export interface ResumeTemplateRefreshCompletedPayload {
  readonly jobId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly templateId: string;
  readonly templateVersionId: string;
  readonly completedAt: string;
}

export type ResumeTemplateRefreshCompleted = DomainEvent<
  "ResumeTemplateRefreshCompleted",
  ResumeTemplateRefreshCompletedPayload
>;

export function createResumeTemplateRefreshCompleted(
  tenantId: TenantId,
  payload: ResumeTemplateRefreshCompletedPayload,
): ResumeTemplateRefreshCompleted {
  return createDomainEvent("ResumeTemplateRefreshCompleted", tenantId, payload);
}

// -- ResumeTemplateRefreshFailed -------------------------------------------

export interface ResumeTemplateRefreshFailedPayload {
  readonly jobId: string;
  readonly attemptId: string;
  readonly status: "failed" | "unavailable";
  readonly errorMessage: string;
  readonly failedAt: string;
}

export type ResumeTemplateRefreshFailed = DomainEvent<
  "ResumeTemplateRefreshFailed",
  ResumeTemplateRefreshFailedPayload
>;

export function createResumeTemplateRefreshFailed(
  tenantId: TenantId,
  payload: ResumeTemplateRefreshFailedPayload,
): ResumeTemplateRefreshFailed {
  return createDomainEvent("ResumeTemplateRefreshFailed", tenantId, payload);
}
