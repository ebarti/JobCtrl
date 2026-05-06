/**
 * Candidate Profile domain events.
 *
 * @see ddd-target.md §4.3
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
