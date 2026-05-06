/**
 * Job Discovery domain events.
 *
 * @see ddd-target.md §4.1
 */

import type { TenantId } from "../tenant.js";
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
