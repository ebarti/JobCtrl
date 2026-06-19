/**
 * Compensation domain events.
 *
 * Payloads intentionally carry only safe state markers. Source excerpts,
 * profile compensation preferences, raw benchmark payloads, credentials, and
 * local paths stay in canonical stores/API responses where the owning safety
 * mappers can sanitize them.
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

export type CompensationChangedSection = "posted" | "market";
export type CompensationPostedRecordStatus = "recorded" | "not_recorded";
export type CompensationPostedParseState = "missing" | "unparseable" | "ambiguous" | "parsed_range" | null;
export type CompensationMarketRecordStatus = "recorded" | "not_requested";
export type CompensationMarketEstimateState =
  | "not_requested"
  | "unsupported"
  | "source_unavailable"
  | "insufficient_evidence"
  | "estimated_range"
  | null;

export interface CompensationFactsUpdatedPayload {
  readonly jobId: string;
  readonly changedSections: readonly CompensationChangedSection[];
  readonly postedRecordStatus: CompensationPostedRecordStatus | null;
  readonly postedParseState: CompensationPostedParseState;
  readonly marketRecordStatus: CompensationMarketRecordStatus | null;
  readonly marketEstimateState: CompensationMarketEstimateState;
  readonly updatedAt: string;
}

export type CompensationFactsUpdated = DomainEvent<
  "CompensationFactsUpdated",
  CompensationFactsUpdatedPayload
>;

export function createCompensationFactsUpdated(
  tenantId: TenantId,
  payload: CompensationFactsUpdatedPayload,
): CompensationFactsUpdated {
  return createDomainEvent("CompensationFactsUpdated", tenantId, payload);
}
