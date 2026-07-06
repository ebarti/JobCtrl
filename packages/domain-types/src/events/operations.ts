/**
 * Operations / Read-Side domain events.
 *
 * @see docs/architecture/domain-model/tactical.md §4.8
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

// -- DigestReviewed ---------------------------------------------------------

export interface DigestReviewedPayload {
  readonly acknowledgedAt: string;
  readonly reviewedAt: string;
  readonly previousAcknowledgedAt: string | null;
}

export type DigestReviewed = DomainEvent<"DigestReviewed", DigestReviewedPayload>;

export function createDigestReviewed(
  tenantId: TenantId,
  payload: DigestReviewedPayload,
): DigestReviewed {
  return createDomainEvent("DigestReviewed", tenantId, payload);
}
