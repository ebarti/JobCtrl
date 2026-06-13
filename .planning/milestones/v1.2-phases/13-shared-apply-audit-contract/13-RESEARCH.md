---
phase: 13-shared-apply-audit-contract
status: completed
researched_at: 2026-06-11
---

# Phase 13 Research

## Scope

Phase 13 establishes the shared apply-audit contract and only minimally updates Apply Review to consume it. The Jobs drawer visual redesign remains Phase 14.

## Current Source Facts

- `packages/contracts/src/schemas.ts` owns wire types for `ApplyReviewQueueItem`, `JobDetail`, `ScoreBreakdown`, `Stage`, and `StageState`.
- `apps/api/src/application-feedback.ts` builds apply-review queue items from `job_list_projections`, latest review decision, latest apply run, score breakdown JSON, material flags, and material preview artifacts.
- `apps/api/src/read-model.ts` builds `JobDetail` from `job_list_projections`, `job_detail_projections`, stage summaries, artifact projections, and audit history.
- `apps/web/src/views/apply-review/ApplyReviewView.tsx` currently derives readiness locally via `materialStatus`, `repairStatus`, `firstRepairReason`, current stage state, legacy blockers, and latest apply run.
- Web fixtures in `apps/web/src/test/fixtures/projections.ts` back both Apply Review and Jobs drawer tests and must be updated when contract fields become required.

## Findings

1. The readiness bug class comes from split derivation: API serves `materials`, `blockers`, stage state, latest run, and the web recombines them independently.
2. Both queue rows and job detail rows have enough shared inputs for a single DTO: application target, material booleans, stage state/error, latest apply run when present, and score eligibility.
3. `JobDetail` currently lacks latest apply-run context in the direct detail payload, but the read model can query `apply_run_projections` the same way the queue query does.
4. Score eligibility parsing already handles snake_case and camelCase in `read-model.ts`; `application-feedback.ts` should be brought in line for `hard_blockers`.
5. A compact fact model is sufficient for Phase 13. Deep material validation, artifact pinning, judge response, and claim-risk proof belong to Phases 15+.

## Design Research

Modern web guidance was checked for React status and detail-panel ergonomics. Relevant constraints for this phase:

- Avoid layout shifts from dynamic status text by keeping existing tag/list patterns compact.
- Do not add a new UI dependency for status panels.
- Keep Phase 13 UI changes as source-fact display and formatting; larger drawer layout treatment belongs to Phase 14.

## Risks

- **Contract drift:** If queue and job detail use separate helpers, they can disagree again.
- **Compatibility:** Existing consumers may still read `materials` and `blockers`; keep these fields additive and compatible.
- **Overclaiming:** Missing score/material validation data must be labeled as unknown or missing where it affects readiness.
- **Scope creep:** Do not implement resume pins or the Jobs drawer redesign in Phase 13.

## Recommended Implementation

- Add `ApplyAudit` types to `@jobhunter/contracts`.
- Add one API helper that accepts normalized source facts and returns `ApplyAudit`.
- Use the helper from both `reviewQueueItemFromRow` and `getJobDetail`.
- Update Apply Review to display `item.applyAudit` for queue tags, header status, counts, and blocker/source explanations.
- Keep legacy `materials` and `blockers` fields as compatibility fields.

