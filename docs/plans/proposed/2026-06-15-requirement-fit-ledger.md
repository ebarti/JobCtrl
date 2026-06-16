# Requirement Fit Ledger Implementation Plan

> **Status:** Proposed. This plan tracks the migration from separate score
> signals, employer requirements, and artifact coverage into one requirement-led
> audit chain.

> **For agentic workers:** Implement task-by-task. Keep the compatibility read
> model until the requirement fit report is projected everywhere the old score
> breakdown is still consumed.

## Goal

Make each job score explainable as weighted requirement fit, then use the same
requirement-level facts to drive resume tailoring and apply-review coverage.

The product invariant is:

```text
job requirement
  -> requirement importance
  -> candidate evidence or gap
  -> score contribution
  -> tailoring directive
  -> generated resume coverage
```

## Current Problem

The current implementation has three overlapping truths:

- The Scoring context resolves `FitScore` from broad dimensions
  (`technical_fit`, `experience_fit`, `role_fit`) and free-text matched,
  missing, and transferable signals.
- The Materials context owns the richer canonical employer analysis:
  requirements with `tier`, `weight`, `evidence_span`, and linked keywords.
- Apply review computes post-generation requirement coverage from bullet
  provenance, which is useful but has a different lifecycle from pre-tailoring
  candidate fit.

This causes confusing product states: the UI can show weighted job
requirements, score signals, and resume coverage next to each other without one
canonical answer for why the score happened or what the tailor should optimize.

## Ubiquitous Language

**Employer Requirement** (Value Object)
- Definition: A grounded requirement extracted from the job post.
- Source of truth: `EmployerAnalysis.requirements`.
- Invariants: Has a stable requirement ID, tier, weight, and verbatim job
  evidence span.

**Requirement Fit Assessment** (Value Object)
- Definition: The candidate's pre-tailoring fit for one employer requirement.
- Source of truth: Scoring context.
- Invariants: References one employer requirement ID and either profile
  evidence IDs or an explicit missing/blocked/not-assessed reason.

**Requirement Fit Report** (Aggregate Read Model)
- Definition: The complete requirement-level explanation for one score version.
- Source of truth: Scoring context, keyed by job, score version, profile
  snapshot, scoring policy, and employer-analysis generation.
- Invariants: The final score is derived from this report, not from independent
  free-text signals.

**Tailoring Directive** (Value Object)
- Definition: The action the resume tailor should take for a requirement.
- Source of truth: Derived from the requirement fit assessment.
- Invariants: Unsupported missing requirements may not become resume claims.

**Artifact Requirement Coverage** (Value Object)
- Definition: Whether the accepted generated resume represented a requirement.
- Source of truth: Materials provenance rows for the selected artifact.
- Invariants: Computed against generated text with grounded provenance, never
  inferred from the job description.

## Target Flow

```text
enrich job
  -> analyze employer requirements
  -> assess candidate fit per requirement
  -> resolve score from weighted requirement fit
  -> tailor resume from requirement fit directives
  -> compute artifact coverage from accepted generated text
  -> display one requirement matrix across Jobs and Apply Review
```

## Target Data Model

Add shared contract and Python domain types for:

- `RequirementFitReport`
- `RequirementFitAssessment`
- `RequirementFitStatus`
- `RequirementScoreContribution`
- `RequirementTailoringDirective`
- `RequirementArtifactCoverage`

Draft TypeScript shape:

```ts
export interface RequirementFitAssessment {
  requirementId: string;
  requirementText: string;
  tier: "must_have" | "nice_to_have";
  weight: number;
  jobEvidenceSpan: string;
  fit: RequirementFitStatus;
  contribution: RequirementScoreContribution;
  tailoring: RequirementTailoringDirective;
}
```

`ScoreBreakdown.matchedSignals`, `missingSignals`, and
`transferableSignals` stay temporarily, but become derived summaries from the
requirement fit report.

## Scoring Rules

Resolve the score from requirement contributions:

```text
weighted_fit =
  sum(requirement.weight * tier_multiplier * fit_value)
  / sum(requirement.weight * tier_multiplier)

score = 1 + round(9 * weighted_fit)
```

Suggested fit values:

- `matched/direct`: `1.00`
- `matched/strong`: `0.85`
- `transferable`: `0.50` to `0.70`
- `missing`: `0.00`
- `blocked`: score cap or hard ineligible state

Hard blockers still cap the final score independently of the weighted average.
User calibration anchors may adjust the resolved score only after the
requirement-led raw score has been recorded.

## Tailoring Rules

The tailor should consume requirement directives, not raw keyword lists:

- High-weight matched requirement: emphasize direct profile evidence.
- High-weight transferable requirement: bridge from adjacent evidence with
  honest wording.
- High-weight missing requirement: do not fabricate; optionally surface as a
  cover-letter risk or user-review note.
- Low-weight nice-to-have: include only when profile evidence already supports
  it.

The tailoring quality plan should include requirement IDs, allowed evidence IDs,
target keywords, prohibited claims, and the action selected for each important
requirement.

## UI Rules

The job drawer should show the score explanation as one requirement matrix:

| Requirement | Importance | Candidate fit | Score impact | Tailoring action |
| --- | --- | --- | --- | --- |

Apply Review should extend the same matrix with post-generation coverage:

| Requirement | Candidate fit | Tailoring action | Resume coverage |
| --- | --- | --- | --- |

Lifecycle labels must be explicit:

- Candidate fit before tailoring
- Selected resume coverage after tailoring

## Implementation Phases

### Phase 1: Contracts And Domain Types

- [x] Add TypeScript contract types for the requirement fit report.
- [x] Add Python scoring value objects with `to_dict` and `from_dict`.
- [x] Add focused serialization tests.
- [x] Keep old score breakdown fields readable.

### Phase 2: Persistence

- [x] Add canonical tables for requirement fit reports and items.
- [x] Store score version, employer-analysis generation, profile snapshot
      version, scoring policy version, and scoring formula version.
- [x] Persist item-level status, evidence IDs, contribution, and tailoring
      directive.

### Phase 3: Scoring V2

- [x] Add the pure deterministic requirement-fit resolver and legacy signal
      derivation helper.
- [x] Add backward-compatible parser and schema support for requirement-level
      fit rows without accepting uncited matched claims.
- [ ] Ensure employer analysis exists before scoring.
- [ ] Update the scoring prompt/schema to classify fit per requirement.
- [ ] Resolve `FitScore` deterministically from requirement contributions.
- [ ] Derive legacy matched/missing/transferable signals from requirement fit
      rows.
- [ ] Add fixtures proving high-weight missing requirements reduce the score.

### Phase 4: Projections And API

- [ ] Project `RequirementFitReport` onto job detail.
- [ ] Expose the report in API contracts and read-model responses.
- [ ] Preserve old fields until UI migration is complete.
- [ ] Add Python/TypeScript projection parity coverage.

### Phase 5: Tailoring Integration

- [ ] Replace keyword-only plan selection with requirement directives.
- [ ] Select required evidence from directive evidence IDs.
- [ ] Keep current no-fabrication and verified-metric gates.
- [ ] Treat unsupported missing requirements as prohibited claims.

### Phase 6: Artifact Coverage Integration

- [ ] Keep provenance as the post-generation source of truth.
- [ ] Map artifact coverage back to requirement fit rows by requirement ID.
- [ ] Show missing-from-profile separately from missing-from-resume.

### Phase 7: UI Migration

- [ ] Replace the heuristic requirement/signal matcher in the job drawer with
      the projected requirement fit report.
- [ ] Replace separate matched/missing chips as the primary explanation.
- [ ] Update Apply Review to show pre-tailor fit beside selected-artifact
      coverage.
- [ ] Add visual regression and browser QA for the job drawer and apply review.

### Phase 8: Backfill And Cleanup

- [ ] For old jobs without reports, show `not_assessed` and a re-score path.
- [ ] Remove heuristic matching once the report is available everywhere.
- [ ] Update canonical docs and delivered notes when behavior lands.

## Verification Plan

- Python unit tests for requirement fit serialization, score formula, blocker
  caps, and tailoring directives.
- Python scoring fixtures for matched, transferable, missing, and blocked
  requirements.
- API tests for projection/read-model compatibility.
- Web tests for the job drawer requirement matrix and apply-review lifecycle
  labels.
- Browser QA on a scored and tailored job showing the same requirement IDs
  across score explanation, tailoring audit, and apply review.

## Rollout Notes

Ship this behind additive read-model fields first. Existing jobs keep their
legacy score breakdown until they are re-scored. During migration, the UI should
prefer the requirement fit report when present and display an explicit
`not_assessed` state when it is absent.
