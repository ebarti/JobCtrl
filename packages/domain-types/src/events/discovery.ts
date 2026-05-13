/**
 * Job Discovery domain events.
 *
 * @see ddd-target.md §4.1
 */

import type { TenantId } from "../tenant.js";
import type { SourceKind, SourceState } from "../discovery/source.js";
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
