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
  readonly fitBand: "excellent" | "strong" | "plausible" | "stretch" | "poor";
  readonly confidence: "high" | "medium" | "low";
  readonly eligibility: ScoreEligibility;
  readonly matchedSignals: readonly string[];
  readonly missingSignals: readonly string[];
  readonly transferableSignals: readonly string[];
}

export interface ScoreEligibility {
  readonly status: "eligible" | "warning" | "blocked" | "unknown";
  readonly hardBlockers: readonly string[];
  readonly warnings: readonly string[];
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
  readonly targetCriteria: string;
  readonly profilePreferences: Readonly<Record<string, unknown>>;
  readonly criteriaVersion: string;
}

export interface ScoreTrace {
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly model: string;
  readonly criteriaVersion: string;
  readonly profileSnapshotVersion: number;
  readonly parserWarnings: readonly string[];
  readonly correctionHistory: readonly ScoreCorrection[];
}

// ---------------------------------------------------------------------------
// RequirementFitReport
// ---------------------------------------------------------------------------

export type RequirementFitStatus =
  | {
      readonly kind: "matched";
      readonly evidenceIds: readonly string[];
      readonly strength: "direct" | "strong";
    }
  | {
      readonly kind: "transferable";
      readonly evidenceIds: readonly string[];
      readonly gap: string;
      readonly bridge: string;
    }
  | {
      readonly kind: "missing";
      readonly reason: string;
    }
  | {
      readonly kind: "blocked";
      readonly blocker: string;
    }
  | {
      readonly kind: "not_assessed";
      readonly reason: string;
    };

export interface RequirementScoreContribution {
  readonly maxPoints: number;
  readonly awardedPoints: number;
  readonly weightedImpact: number;
  readonly rationale: string;
}

export interface RequirementTailoringDirective {
  readonly action: "double_down" | "bridge_gap" | "avoid_claim" | "low_priority";
  readonly priority: number;
  readonly allowedEvidenceIds: readonly string[];
  readonly targetKeywords: readonly string[];
  readonly prohibitedClaims: readonly string[];
  readonly instruction: string;
}

export interface RequirementArtifactCoverage {
  readonly state:
    | "covered"
    | "missing_from_resume"
    | "missing_from_profile"
    | "not_covered"
    | "not_recorded";
  readonly source: "tailored_resume_bullet_provenance";
  readonly bulletCount: number;
  readonly examples: readonly string[];
}

export interface RequirementFitAssessment {
  readonly requirementId: string;
  readonly requirementText: string;
  readonly tier: "must_have" | "nice_to_have";
  readonly weight: number;
  readonly jobEvidenceSpan: string;
  readonly fit: RequirementFitStatus;
  readonly contribution: RequirementScoreContribution;
  readonly tailoring: RequirementTailoringDirective;
  readonly artifactCoverage: RequirementArtifactCoverage | null;
}

export interface RequirementFitSummary {
  readonly weightedFit: number;
  readonly mustHaveCoverage: number;
  readonly blockerCount: number;
  readonly missingHighWeightCount: number;
}

export interface RequirementFitReport {
  readonly jobKey: string;
  readonly scoreVersion: number;
  readonly employerAnalysisGeneration: number;
  readonly profileSnapshotVersion: number;
  readonly scoringPolicyVersion: number;
  readonly formulaVersion: string;
  readonly resolvedFitScore: number | null;
  readonly fitBand: "excellent" | "strong" | "plausible" | "stretch" | "poor";
  readonly confidence: "high" | "medium" | "low";
  readonly summary: RequirementFitSummary;
  readonly assessments: readonly RequirementFitAssessment[];
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
  readonly criteria: ScoringCriteria;
  readonly trace: ScoreTrace;
  readonly correction: ScoreCorrection | null;
}
