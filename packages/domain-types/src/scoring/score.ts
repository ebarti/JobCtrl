/**
 * JobScore aggregate + value objects — TypeScript mirror.
 *
 * See ddd-target.md §4.4. The Python ``JobScore`` aggregate
 * (``workers/automation/src/jobhunter/domain/scoring/aggregate.py``) is the
 * source of truth; both languages must stay structurally compatible.
 *
 * Wire format invariants enforced here at the type level:
 *
 *   * ``FitScore`` is a 1..10 integer (encoded as a literal union).
 *   * ``ScoreBreakdown`` carries a fixed-dimensional set of components plus
 *     a free-text reasoning field.
 *   * ``MatchedKeywords`` is an immutable list of strings.
 *   * ``ScoreCorrection`` records who corrected the score, when, and why.
 *   * ``JobScore.version`` is monotonically increasing per (tenantId, jobId).
 */

import type { TenantId } from "../tenant.js";
import type { JobId } from "../identifiers.js";

// ---------------------------------------------------------------------------
// FitScore
// ---------------------------------------------------------------------------

/** Allowed fit-score literals. Mirrors ``FitScore`` validation in Python. */
export const FIT_SCORE_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type FitScoreValue = (typeof FIT_SCORE_VALUES)[number];

export interface FitScore {
  readonly value: FitScoreValue;
}

/** Validating constructor — throws when ``value`` is outside [1, 10]. */
export function createFitScore(value: number): FitScore {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new RangeError(`FitScore.value must be an integer in [1, 10], got ${value}`);
  }
  return { value: value as FitScoreValue };
}

// ---------------------------------------------------------------------------
// ScoreBreakdown
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  readonly technicalFit: number;
  readonly experienceFit: number;
  readonly roleFit: number;
  readonly reasoning: string;
}

// ---------------------------------------------------------------------------
// MatchedKeywords
// ---------------------------------------------------------------------------

export interface MatchedKeywords {
  readonly values: readonly string[];
}

// ---------------------------------------------------------------------------
// ScoreCorrection
// ---------------------------------------------------------------------------

export interface ScoreCorrection {
  readonly correctedFitScore: FitScore;
  readonly rationale: string;
  readonly correctedBy: TenantId;
  readonly correctedAt: string;
}

// ---------------------------------------------------------------------------
// ScoringCriteria
// ---------------------------------------------------------------------------

export interface ScoringCriteria {
  readonly minFitScore: number;
  readonly criteriaText: string;
}

// ---------------------------------------------------------------------------
// JobScore aggregate
// ---------------------------------------------------------------------------

export interface JobScore {
  readonly tenantId: TenantId;
  readonly jobId: JobId;
  readonly version: number;
  readonly fitScore: FitScore;
  readonly breakdown: ScoreBreakdown;
  readonly matchedKeywords: MatchedKeywords;
  readonly scoredAt: string;
  readonly correction: ScoreCorrection | null;
}
