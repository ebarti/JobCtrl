---
phase: 20-canonical-read-model-realtime-api
plan: 20-02
status: completed
completed: 2026-06-19
requirements-completed:
  - EST-05
  - API-01
  - API-03
  - API-04
  - API-05
key-files:
  created:
    - packages/domain-types/src/events/compensation.ts
  modified:
    - packages/contracts/src/schemas.ts
    - packages/domain-types/src/events/index.ts
    - packages/domain-types/test/events.test.ts
    - apps/api/src/read-model.ts
    - apps/api/test/server.test.ts
    - apps/web/src/contexts/enrichment/handlers.ts
    - apps/web/src/contexts/operations/invalidation-router.ts
    - apps/web/src/contexts/operations/invalidation-router.test.ts
    - apps/web/src/test/fixtures/events.ts
    - apps/web/src/test/fixtures/projections.ts
    - workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py
    - workers/automation/src/jobhunter/infrastructure/compensation/sqlite_market_repository.py
    - workers/automation/tests/test_posted_compensation_repository.py
    - workers/automation/tests/test_market_compensation_repository.py
    - docs/local-ts-api.md
    - docs/architecture.md
    - docs/local-reliability-qa.md
---

# Phase 20 Plan 20-02: Additive API Contract And Realtime Invalidation Summary

## Completed

- Added shared contract types for `JobCompensationSummary` and `JobCompensationAudit`.
- Exposed `compensationSummary` on job list and detail `job` payloads, sourced from projection JSON.
- Exposed top-level `compensationAudit` on job detail payloads, sourced from projection JSON.
- Kept raw `JobSummary.salary` present and unchanged for compatibility.
- Added safe `CompensationFactsUpdated` domain event payloads containing only job id, changed sections, state markers, and timestamp.
- Emitted compensation update events after posted compensation fact saves and market compensation estimate saves.
- Routed `CompensationFactsUpdated` through the existing Operations invalidation router to refresh job list and detail queries.
- Updated API boundary tests so compensation fields are present while ranking, filtering, apply readiness, and apply dispatch stay unchanged.
- Updated local API, architecture, and reliability QA docs for projection-backed compensation fields, safe realtime invalidation, and the warning-only boundary.
- Updated web fixtures to satisfy the stricter contract shape.

## Verification

- `corepack pnpm --filter @jobhunter/contracts check` - passed.
- `corepack pnpm --filter @jobhunter/api-client check` - passed.
- `corepack pnpm api:check` - passed.
- `corepack pnpm web:check` - passed.
- `corepack pnpm web:build` - passed, with the existing large-chunk warning.
- `corepack pnpm --filter @jobhunter/domain-types test` - passed, 12 files and 170 tests.
- `corepack pnpm --filter @jobhunter/web exec vitest run src/contexts/operations/every-event-has-handler.test.ts src/contexts/operations/invalidation-router.test.ts` - passed, 2 files and 171 tests.
- `corepack pnpm --filter @jobhunter/api exec vitest run test/server.test.ts -t "compensation boundary"` - passed, 2 tests.
- `corepack pnpm api:test` - passed, 14 files and 243 tests.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_market_compensation_repository.py -q` - passed, 24 tests.
- `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py workers/automation/src/jobhunter/infrastructure/projections/sqlite_projection_store.py workers/automation/src/jobhunter/domain/operations/projections.py workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py workers/automation/src/jobhunter/infrastructure/compensation/sqlite_market_repository.py workers/automation/tests/test_projection_builder.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_market_compensation_repository.py` - passed.

## Deviations from Plan

- Used `vitest exec run` for the focused web invalidation tests instead of the package script filter form, because it targets the exact two Operations tests without invoking unrelated web unit tests.
- README was not updated because Phase 20 changes API/read-model and architecture behavior only; no user-facing CLI command, runtime requirement, top-level product workflow, or visible Jobs UI behavior changed.

## Self-Check: PASSED

Plan 20-02 satisfies the additive API and realtime invalidation scope. Compensation events are safe markers only, and the existing warning-only product boundary remains intact.
