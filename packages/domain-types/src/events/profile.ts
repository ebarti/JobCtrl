/**
 * Candidate Profile domain events.
 *
 * @see docs/architecture/domain-model/tactical.md §4.3
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

// -- ProfileUpdated ---------------------------------------------------------

export interface ProfileUpdatedPayload {
  readonly changedSections: readonly string[];
  readonly updatedAt: string;
}

export type ProfileUpdated = DomainEvent<"ProfileUpdated", ProfileUpdatedPayload>;

export function createProfileUpdated(
  tenantId: TenantId,
  payload: ProfileUpdatedPayload,
): ProfileUpdated {
  return createDomainEvent("ProfileUpdated", tenantId, payload);
}

// -- ProfileImported --------------------------------------------------------

export interface ProfileImportedPayload {
  readonly source: string;
  readonly importedSections: readonly string[];
  readonly importedAt: string;
}

export type ProfileImported = DomainEvent<"ProfileImported", ProfileImportedPayload>;

export function createProfileImported(
  tenantId: TenantId,
  payload: ProfileImportedPayload,
): ProfileImported {
  return createDomainEvent("ProfileImported", tenantId, payload);
}

// -- TailoringPolicyUpdated -------------------------------------------------

export interface TailoringPolicyUpdatedPayload {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly previousPolicyVersion: number | null;
  readonly policyFingerprint: string;
  readonly changedFields: readonly string[];
  readonly updatedAt: string;
  readonly rollbackOfPolicyVersion?: number | null;
}

export type TailoringPolicyUpdated = DomainEvent<"TailoringPolicyUpdated", TailoringPolicyUpdatedPayload>;

export function createTailoringPolicyUpdated(
  tenantId: TenantId,
  payload: TailoringPolicyUpdatedPayload,
): TailoringPolicyUpdated {
  return createDomainEvent("TailoringPolicyUpdated", tenantId, payload);
}
