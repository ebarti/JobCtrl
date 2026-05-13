/**
 * Job Discovery domain events.
 *
 * @see ddd-target.md §4.1
 */

import type { TenantId } from "../tenant.js";
import type { AtsKind, SourceKind, SourceState } from "../discovery/source.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

// -- JobDiscovered ----------------------------------------------------------

export interface JobDiscoveredPayload {
  readonly jobId: string;
  readonly postingUrl: string;
  readonly source: string;
  readonly employer: string;
  readonly metadata: Record<string, unknown>;
  readonly discoveredAt: string;
}

export type JobDiscovered = DomainEvent<"JobDiscovered", JobDiscoveredPayload>;

export function createJobDiscovered(
  tenantId: TenantId,
  payload: JobDiscoveredPayload,
): JobDiscovered {
  return createDomainEvent("JobDiscovered", tenantId, payload);
}

// -- JobUpdated -------------------------------------------------------------

export interface JobUpdatedPayload {
  readonly jobId: string;
  readonly changedFields: Record<string, unknown>;
}

export type JobUpdated = DomainEvent<"JobUpdated", JobUpdatedPayload>;

export function createJobUpdated(
  tenantId: TenantId,
  payload: JobUpdatedPayload,
): JobUpdated {
  return createDomainEvent("JobUpdated", tenantId, payload);
}

// -- JobDeleted -------------------------------------------------------------

export interface JobDeletedPayload {
  readonly jobId: string;
  readonly reason: string;
  readonly deletedAt: string;
}

export type JobDeleted = DomainEvent<"JobDeleted", JobDeletedPayload>;

export function createJobDeleted(
  tenantId: TenantId,
  payload: JobDeletedPayload,
): JobDeleted {
  return createDomainEvent("JobDeleted", tenantId, payload);
}

// -- JobRestored ------------------------------------------------------------

export interface JobRestoredPayload {
  readonly jobId: string;
  readonly restoredAt: string;
}

export type JobRestored = DomainEvent<"JobRestored", JobRestoredPayload>;

export function createJobRestored(
  tenantId: TenantId,
  payload: JobRestoredPayload,
): JobRestored {
  return createDomainEvent("JobRestored", tenantId, payload);
}

// -- SourceLocationCandidateDiscovered -------------------------------------

export interface SourceLocationCandidateDiscoveredPayload {
  readonly candidateId: string;
  readonly candidateUrl: string;
  readonly sourceKind: SourceKind;
  readonly confidence: number;
  readonly evidenceRef: string;
  readonly discoveredAt: string;
}

export type SourceLocationCandidateDiscovered = DomainEvent<
  "SourceLocationCandidateDiscovered",
  SourceLocationCandidateDiscoveredPayload
>;

export function createSourceLocationCandidateDiscovered(
  tenantId: TenantId,
  payload: SourceLocationCandidateDiscoveredPayload,
): SourceLocationCandidateDiscovered {
  return createDomainEvent("SourceLocationCandidateDiscovered", tenantId, payload);
}

// -- SourceLocationCandidatePromoted ---------------------------------------

export interface SourceLocationCandidatePromotedPayload {
  readonly candidateId: string;
  readonly sourceId: string;
  readonly promotedAt: string;
}

export type SourceLocationCandidatePromoted = DomainEvent<
  "SourceLocationCandidatePromoted",
  SourceLocationCandidatePromotedPayload
>;

export function createSourceLocationCandidatePromoted(
  tenantId: TenantId,
  payload: SourceLocationCandidatePromotedPayload,
): SourceLocationCandidatePromoted {
  return createDomainEvent("SourceLocationCandidatePromoted", tenantId, payload);
}

// -- SourceRegistryEntryCreated --------------------------------------------

export interface SourceRegistryEntryCreatedPayload {
  readonly sourceId: string;
  readonly kind: SourceKind;
  readonly policyId: string;
  readonly state: SourceState;
  readonly createdAt: string;
}

export type SourceRegistryEntryCreated = DomainEvent<
  "SourceRegistryEntryCreated",
  SourceRegistryEntryCreatedPayload
>;

export function createSourceRegistryEntryCreated(
  tenantId: TenantId,
  payload: SourceRegistryEntryCreatedPayload,
): SourceRegistryEntryCreated {
  return createDomainEvent("SourceRegistryEntryCreated", tenantId, payload);
}

// -- SourceRegistryEntryUpdated --------------------------------------------

export interface SourceRegistryEntryUpdatedPayload {
  readonly sourceId: string;
  readonly changedFields: readonly string[];
  readonly updatedAt: string;
}

export type SourceRegistryEntryUpdated = DomainEvent<
  "SourceRegistryEntryUpdated",
  SourceRegistryEntryUpdatedPayload
>;

export function createSourceRegistryEntryUpdated(
  tenantId: TenantId,
  payload: SourceRegistryEntryUpdatedPayload,
): SourceRegistryEntryUpdated {
  return createDomainEvent("SourceRegistryEntryUpdated", tenantId, payload);
}

// -- SourceStateChanged -----------------------------------------------------

export interface SourceStateChangedPayload {
  readonly sourceId: string;
  readonly fromState: SourceState;
  readonly toState: SourceState;
  readonly reason: string;
  readonly changedAt: string;
}

export type SourceStateChanged = DomainEvent<"SourceStateChanged", SourceStateChangedPayload>;

export function createSourceStateChanged(
  tenantId: TenantId,
  payload: SourceStateChangedPayload,
): SourceStateChanged {
  return createDomainEvent("SourceStateChanged", tenantId, payload);
}

// -- JobSourceObserved ------------------------------------------------------

export interface JobSourceObservedPayload {
  readonly jobId: string;
  readonly sourceObservationId: string;
  readonly sourceId: string;
  readonly sourceNativeId: string;
  readonly observedUrl: string;
  readonly runId: string;
  readonly observedAt: string;
}

export type JobSourceObserved = DomainEvent<"JobSourceObserved", JobSourceObservedPayload>;

export function createJobSourceObserved(
  tenantId: TenantId,
  payload: JobSourceObservedPayload,
): JobSourceObserved {
  return createDomainEvent("JobSourceObserved", tenantId, payload);
}

// -- DiscoveryRunStarted ----------------------------------------------------

export interface DiscoveryRunStartedPayload {
  readonly runId: string;
  readonly sourceIds: readonly string[];
  readonly profileSnapshotId: string | null;
  readonly startedAt: string;
}

export type DiscoveryRunStarted = DomainEvent<
  "DiscoveryRunStarted",
  DiscoveryRunStartedPayload
>;

export function createDiscoveryRunStarted(
  tenantId: TenantId,
  payload: DiscoveryRunStartedPayload,
): DiscoveryRunStarted {
  return createDomainEvent("DiscoveryRunStarted", tenantId, payload);
}

// -- DiscoveryRunCompleted --------------------------------------------------

export interface DiscoveryRunCounts {
  readonly total: number;
  readonly newJobs: number;
  readonly existingJobs: number;
  readonly observedJobs: number;
  readonly duplicateJobs: number;
  readonly rejectedDuplicates: number;
}

export interface DiscoveryRunCompletedPayload {
  readonly runId: string;
  readonly counts: DiscoveryRunCounts;
  readonly errorClasses: readonly string[];
  readonly completedAt: string;
}

export type DiscoveryRunCompleted = DomainEvent<
  "DiscoveryRunCompleted",
  DiscoveryRunCompletedPayload
>;

export function createDiscoveryRunCompleted(
  tenantId: TenantId,
  payload: DiscoveryRunCompletedPayload,
): DiscoveryRunCompleted {
  return createDomainEvent("DiscoveryRunCompleted", tenantId, payload);
}

// -- DiscoveryRunFailed -----------------------------------------------------

export interface DiscoveryRunFailedPayload {
  readonly runId: string;
  readonly sourceId: string;
  readonly errorClass: string;
  readonly retryable: boolean;
  readonly failedAt: string;
}

export type DiscoveryRunFailed = DomainEvent<
  "DiscoveryRunFailed",
  DiscoveryRunFailedPayload
>;

export function createDiscoveryRunFailed(
  tenantId: TenantId,
  payload: DiscoveryRunFailedPayload,
): DiscoveryRunFailed {
  return createDomainEvent("DiscoveryRunFailed", tenantId, payload);
}

// -- CanonicalJobIdentityResolved ------------------------------------------

export interface CanonicalJobIdentityResolvedPayload {
  readonly jobId: string;
  readonly canonicalUrl: string;
  readonly atsKind: AtsKind;
  readonly sourceNativeId: string;
  readonly confidence: number;
}

export type CanonicalJobIdentityResolved = DomainEvent<
  "CanonicalJobIdentityResolved",
  CanonicalJobIdentityResolvedPayload
>;

export function createCanonicalJobIdentityResolved(
  tenantId: TenantId,
  payload: CanonicalJobIdentityResolvedPayload,
): CanonicalJobIdentityResolved {
  return createDomainEvent("CanonicalJobIdentityResolved", tenantId, payload);
}

// -- DuplicateJobLinked -----------------------------------------------------

export interface DuplicateJobLinkedPayload {
  readonly duplicateLinkId: string;
  readonly survivingJobId: string;
  readonly supersededJobOrObservationId: string;
  readonly reason: string;
  readonly confidence: number;
}

export type DuplicateJobLinked = DomainEvent<"DuplicateJobLinked", DuplicateJobLinkedPayload>;

export function createDuplicateJobLinked(
  tenantId: TenantId,
  payload: DuplicateJobLinkedPayload,
): DuplicateJobLinked {
  return createDomainEvent("DuplicateJobLinked", tenantId, payload);
}

// -- DuplicateJobLinkRejected ----------------------------------------------

export interface DuplicateJobLinkRejectedPayload {
  readonly duplicateLinkId: string;
  readonly candidateIds: readonly string[];
  readonly reason: string;
  readonly rejectedAt: string;
}

export type DuplicateJobLinkRejected = DomainEvent<
  "DuplicateJobLinkRejected",
  DuplicateJobLinkRejectedPayload
>;

export function createDuplicateJobLinkRejected(
  tenantId: TenantId,
  payload: DuplicateJobLinkRejectedPayload,
): DuplicateJobLinkRejected {
  return createDomainEvent("DuplicateJobLinkRejected", tenantId, payload);
}
