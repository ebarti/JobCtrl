/**
 * Job Enrichment domain events.
 *
 * @see ddd-target.md §4.2
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
