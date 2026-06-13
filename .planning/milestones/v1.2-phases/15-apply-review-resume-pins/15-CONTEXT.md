---
phase: 15-apply-review-resume-pins
status: ready_for_planning
created: 2026-06-11
---

# Phase 15 Context: Apply Review Resume Pins

## Phase Boundary

Phase 15 updates the existing Apply Review surface so the rendered resume/material is the primary review object and source-to-tailored audit facts are inspectable at claim/row level.

This phase does not redesign scoring or tailoring policy. It displays canonical artifact audit data already exposed through artifact detail read models.

## User Stories

- As a technical job seeker, I can inspect what changed from my source profile/resume to the tailored artifact.
- As a technical job seeker, I can see what evidence and requirement each generated resume claim is grounded in.
- As a technical job seeker, I can tell whether a generated claim is grounded, risky, unsupported, or missing audit data.
- As a technical job seeker, I can keep readiness/blocker context visible while deciding whether the job is ready for apply review.

## Decisions

- The rendered resume stays above detached audit sections in the Application Materials pane.
- Claim pins are derived from `ArtifactTailoringExplanation.bulletProvenance` and `annotatedChanges`.
- The pin detail panel shows source text, tailored text, transform, controls, evidence IDs, requirement IDs, matched keywords/signals, rationale, and artifact-level risk/audit status.
- The existing full `ArtifactTailoringInspector` remains available below the resume-centered pin surface for deeper audit inspection.
- Missing PDF, missing artifact detail, missing provenance, and missing source text render explicit states.

## Deferred

- PDF coordinate overlays are deferred unless stable coordinates are later persisted.
- Reviewer comments attached to pins are deferred.
- Exportable audit packets are deferred.

