/**
 * DomainEvent base interface.
 *
 * Every domain event carries the envelope fields (eventType, tenantId,
 * occurredAt) plus a typed payload with context-specific data.
 * Events are immutable facts named in past tense.
 *
 * @see ddd-target.md §2 (Modeling Principles), §6.1 (Integration Backbone)
 */

import type { TenantId } from "../tenant.js";

/** Base interface for all domain events. */
export interface DomainEvent<
  T extends string = string,
  P = Record<string, unknown>,
> {
  readonly eventType: T;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
  readonly payload: P;
}

/** Helper to create a domain event with auto-generated occurredAt. */
export function createDomainEvent<T extends string, P>(
  eventType: T,
  tenantId: TenantId,
  payload: P,
  occurredAt?: string,
): DomainEvent<T, P> {
  return {
    eventType,
    tenantId,
    occurredAt: occurredAt ?? new Date().toISOString(),
    payload,
  };
}
