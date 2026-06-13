# Phase 13: Shared Apply Audit Contract - Context

**Gathered:** 2026-06-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 13 creates the shared apply audit/readiness contract that both Jobs drawer and Apply Review consume. It owns contract shape, API/read-model derivation, tests, and minimal Apply Review consumption of canonical readiness facts. It does not redesign the Jobs drawer; Phase 14 follows immediately in the same autonomous run for that UI work.

</domain>

<decisions>
## Implementation Decisions

### Shared Contract Shape
- Add an additive canonical apply audit DTO in `packages/contracts/src/schemas.ts`, exposed on both `ApplyReviewQueueItem` and `JobDetail`.
- Use a compact status vocabulary aligned with current product states: `ready`, `preparing`, `blocked`, and `repair`.
- Represent details as typed arrays of facts for missing prerequisites, blockers, eligibility concerns, and sources; avoid string-only or deeply nested audit trees.
- Keep existing `materials` and `blockers` fields for compatibility during this phase; `applyAudit` becomes the source-of-truth field for new consumers.

### Source Ownership And Derivation
- Derive apply audit facts in API/read-model helpers, not in web views.
- Source precedence is application URL/material availability, current stage/state/error, latest apply run, score eligibility, and material validation/audit data where present.
- Missing source data should produce explicit inspectable states where it affects readiness.
- Cover derivation with API tests and consumption/formatting with web tests.

### Phase 13/14 Execution Boundary
- Execute Phase 13 and Phase 14 back-to-back in this sitting.
- Keep artifacts and commits phase-separated so GSD status, review, and verification remain auditable.
- Phase 13 may minimally wire Apply Review status/header/queue counts to `applyAudit`.
- Jobs drawer rank/readiness UI redesign belongs to Phase 14.

### the agent's Discretion
- Exact type names, fact IDs, labels, and helper locations may follow local code patterns as long as both DTO consumers share the same source facts.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/contracts/src/schemas.ts` defines `ApplyReviewQueueItem`, `JobDetail`, `ScoreBreakdown`, and score eligibility shapes.
- `apps/api/src/application-feedback.ts` already maps `ApplyReviewQueueItem`, including materials, latest apply run, score evidence, and blockers.
- `apps/api/src/read-model.ts` maps `JobDetail` and already has access to `JobSummary.scoreBreakdown`, stages, artifacts, and audit history.
- `apps/web/src/views/apply-review/ApplyReviewView.tsx` currently owns local `materialStatus`, `repairStatus`, and blocker label derivation that should become formatting-only.
- `apps/api/test/application-feedback.test.ts` and `apps/web/src/views/apply-review/ApplyReviewView.test.tsx` already cover the relevant surfaces.

### Established Patterns
- Shared DTOs live in `packages/contracts/src/schemas.ts` and are imported through app-local contract re-exports.
- API read helpers bound/clean free-text arrays before serving them.
- Frontend views compose context/operation data and should not call API clients directly.
- Tests are colocated or in the existing API test files.

### Integration Points
- `reviewQueueItemFromRow` in `apps/api/src/application-feedback.ts` should populate queue item `applyAudit`.
- `getJobDetail` in `apps/api/src/read-model.ts` should populate job detail `applyAudit` using the same helper/logic.
- `ApplyReviewView` should consume `item.applyAudit` for selected status, queue labels, status counts, and blocker explanations.
- Fixtures in `apps/web/src/test/fixtures/projections.ts` must include the additive DTO.

</code_context>

<specifics>
## Specific Ideas

- Prefer a helper that can build the same audit shape from the queue row and from job detail/read-model inputs to prevent drift.
- Keep existing `materials.ready` compatible but derive it from canonical readiness where practical.
- Use explicit source IDs/kinds such as `application_url`, `materials.resume`, `materials.pdf`, `stage_state`, `apply_run`, and `score_eligibility`.

</specifics>

<deferred>
## Deferred Ideas

- Jobs drawer audit panel and layout treatment are Phase 14.
- Resume pins and claim-level material proof are Phase 15.

</deferred>
