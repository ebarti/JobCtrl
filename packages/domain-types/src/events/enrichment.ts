/**
 * Job Enrichment domain events.
 *
 * @see docs/architecture/domain-model/tactical.md §4.2
 *
 * PR3 additions: PostingContentSnapshotCaptured, PostingContentSnapshotFailed,
 * JobActiveStateChanged, ContentDuplicateCandidateDetected. Each event shape
 * mirrors the §"Domain Events" table in
 * docs/plans/implemented/2026-05-12-job-search-discovery-rfc.md.
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

// -- JobEnriched ------------------------------------------------------------

export interface JobEnrichedPayload {
  readonly jobId: string;
  readonly fullDescription: string;
  readonly applicationUrl: string;
  readonly extractionTier: string;
  readonly enrichedAt: string;
}

export type JobEnriched = DomainEvent<"JobEnriched", JobEnrichedPayload>;

export function createJobEnriched(
  tenantId: TenantId,
  payload: JobEnrichedPayload,
): JobEnriched {
  return createDomainEvent("JobEnriched", tenantId, payload);
}

// -- EnrichmentFailed -------------------------------------------------------

export interface EnrichmentFailedPayload {
  readonly jobId: string;
  readonly error: string;
  readonly attemptNumber: number;
}

export type EnrichmentFailed = DomainEvent<"EnrichmentFailed", EnrichmentFailedPayload>;

export function createEnrichmentFailed(
  tenantId: TenantId,
  payload: EnrichmentFailedPayload,
): EnrichmentFailed {
  return createDomainEvent("EnrichmentFailed", tenantId, payload);
}

// -- ActiveState ------------------------------------------------------------
// Mirrors workers/automation/src/jobhunter/domain/enrichment/snapshot_value_objects.py
// `ActiveState`. Kept as a string-literal union so JSON-RPC payloads can carry
// the same shape without a separate enum import path.

export type ActiveStateValue =
  | "unknown"
  | "active"
  | "closed"
  | "expired"
  | "removed"
  | "location_incompatible";

// -- DuplicateEvidenceKind --------------------------------------------------
// Mirrors workers/automation/src/jobhunter/domain/enrichment/snapshot_value_objects.py
// `DuplicateEvidenceKind` so the SSE payload shape matches the Python writer.

export type DuplicateEvidenceKindValue =
  | "description_hash_match"
  | "apply_url_match"
  | "high_confidence_content_similarity";

// -- DuplicateEvidence on the wire -----------------------------------------

export interface DuplicateEvidenceOnWire {
  readonly kind: DuplicateEvidenceKindValue;
  readonly matchedValue: string;
  readonly confidence: number;
}

// -- PostingContentSnapshotCaptured ----------------------------------------

export interface PostingContentSnapshotCapturedPayload {
  readonly jobId: string;
  readonly snapshotVersion: number;
  readonly snapshotRef: string;
  readonly sourceId: string;
  readonly extractionTier: string;
  readonly capturedAt: string;
}

export type PostingContentSnapshotCaptured = DomainEvent<
  "PostingContentSnapshotCaptured",
  PostingContentSnapshotCapturedPayload
>;

export function createPostingContentSnapshotCaptured(
  tenantId: TenantId,
  payload: PostingContentSnapshotCapturedPayload,
): PostingContentSnapshotCaptured {
  return createDomainEvent("PostingContentSnapshotCaptured", tenantId, payload);
}

// -- PostingContentSnapshotFailed ------------------------------------------

export interface PostingContentSnapshotFailedPayload {
  readonly jobId: string;
  readonly sourceId: string;
  readonly errorClass: string;
  readonly retryable: boolean;
  readonly failedAt: string;
}

export type PostingContentSnapshotFailed = DomainEvent<
  "PostingContentSnapshotFailed",
  PostingContentSnapshotFailedPayload
>;

export function createPostingContentSnapshotFailed(
  tenantId: TenantId,
  payload: PostingContentSnapshotFailedPayload,
): PostingContentSnapshotFailed {
  return createDomainEvent("PostingContentSnapshotFailed", tenantId, payload);
}

// -- JobActiveStateChanged --------------------------------------------------

export interface JobActiveStateChangedPayload {
  readonly jobId: string;
  readonly activeState: ActiveStateValue;
  readonly previousState: ActiveStateValue;
  readonly verificationMethod: string;
  readonly verifiedAt: string;
}

export type JobActiveStateChanged = DomainEvent<
  "JobActiveStateChanged",
  JobActiveStateChangedPayload
>;

export function createJobActiveStateChanged(
  tenantId: TenantId,
  payload: JobActiveStateChangedPayload,
): JobActiveStateChanged {
  return createDomainEvent("JobActiveStateChanged", tenantId, payload);
}

// -- ContentDuplicateCandidateDetected -------------------------------------

export interface ContentDuplicateCandidateDetectedPayload {
  readonly jobId: string;
  readonly candidateJobId: string;
  readonly evidence: readonly DuplicateEvidenceOnWire[];
  readonly confidence: number;
  readonly detectedAt: string;
}

export type ContentDuplicateCandidateDetected = DomainEvent<
  "ContentDuplicateCandidateDetected",
  ContentDuplicateCandidateDetectedPayload
>;

export function createContentDuplicateCandidateDetected(
  tenantId: TenantId,
  payload: ContentDuplicateCandidateDetectedPayload,
): ContentDuplicateCandidateDetected {
  return createDomainEvent("ContentDuplicateCandidateDetected", tenantId, payload);
}
