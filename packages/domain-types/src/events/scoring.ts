/**
 * Scoring domain events.
 *
 * @see ddd-target.md §4.4
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

// -- JobScored --------------------------------------------------------------

export interface JobScoredPayload {
  readonly jobId: string;
  readonly fitScore: number;
  readonly breakdown: Record<string, unknown>;
  readonly keywords: readonly string[];
  readonly version: number;
  readonly scoredAt: string;
  readonly fitBand?: string;
  readonly confidence?: string;
  readonly eligibility?: Record<string, unknown>;
}

export type JobScored = DomainEvent<"JobScored", JobScoredPayload>;

export function createJobScored(
  tenantId: TenantId,
  payload: JobScoredPayload,
): JobScored {
  return createDomainEvent("JobScored", tenantId, payload);
}

// -- ScoreCorrected ---------------------------------------------------------

export interface ScoreCorrectedPayload {
  readonly jobId: string;
  readonly originalScore: number;
  readonly correctedScore: number;
  readonly reason: string;
  readonly correctedAt: string;
}

export type ScoreCorrected = DomainEvent<"ScoreCorrected", ScoreCorrectedPayload>;

export function createScoreCorrected(
  tenantId: TenantId,
  payload: ScoreCorrectedPayload,
): ScoreCorrected {
  return createDomainEvent("ScoreCorrected", tenantId, payload);
}

// -- ScoreRescoreRequested --------------------------------------------------

export interface ScoreRescoreRequestedPayload {
  readonly jobId: string;
  readonly staleReason: string;
  readonly oldPolicyVersion: number;
  readonly newPolicyVersion: number;
  readonly nextAction: string;
}

export type ScoreRescoreRequested = DomainEvent<
  "ScoreRescoreRequested",
  ScoreRescoreRequestedPayload
>;

export function createScoreRescoreRequested(
  tenantId: TenantId,
  payload: ScoreRescoreRequestedPayload,
): ScoreRescoreRequested {
  return createDomainEvent("ScoreRescoreRequested", tenantId, payload);
}
