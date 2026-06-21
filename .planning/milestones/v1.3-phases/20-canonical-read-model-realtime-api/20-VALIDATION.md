---
phase: 20-canonical-read-model-realtime-api
type: validation
status: passed
validated: 2026-06-19
plans:
  - 20-01
  - 20-02
requirements:
  - EST-05
  - API-01
  - API-02
  - API-03
  - API-04
  - API-05
---

# Phase 20 Validation

| Gate | Command | Status |
| --- | --- | --- |
| Projection parity | `corepack pnpm --filter @jobhunter/api exec vitest run test/projections.test.ts -t "compensation"` | passed |
| Python projections and repos | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_market_compensation_repository.py -q` | passed |
| Python lint | `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py workers/automation/src/jobhunter/infrastructure/projections/sqlite_projection_store.py workers/automation/src/jobhunter/domain/operations/projections.py workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py workers/automation/src/jobhunter/infrastructure/compensation/sqlite_market_repository.py workers/automation/tests/test_projection_builder.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_market_compensation_repository.py` | passed |
| Contracts | `corepack pnpm --filter @jobhunter/contracts check` | passed |
| API client | `corepack pnpm --filter @jobhunter/api-client check` | passed |
| Domain events | `corepack pnpm --filter @jobhunter/domain-types test` | passed |
| Web typecheck | `corepack pnpm web:check` | passed |
| Web build | `corepack pnpm web:build` | passed |
| Web invalidation | `corepack pnpm --filter @jobhunter/web exec vitest run src/contexts/operations/every-event-has-handler.test.ts src/contexts/operations/invalidation-router.test.ts` | passed |
| API focused | `corepack pnpm --filter @jobhunter/api exec vitest run test/server.test.ts -t "compensation boundary"` | passed |
| API typecheck | `corepack pnpm api:check` | passed |
| API suite | `corepack pnpm api:test` | passed |
| Diff whitespace | `git diff --check origin/phase/19-europe-public-market-estimates...HEAD` | passed |

## Manual QA

Phase 20 does not add visible Jobs UI. Product-path browser QA is deferred to Phase 21/22, where the structured fields are rendered in the Jobs list and drawer. Phase 20 QA focuses on API/read-model responses and SSE invalidation tests.

## Validation Notes

- A full API-suite failure exposed an outdated parity fixture schema that omitted the existing canonical `jobs.salary` compatibility column. The fixture was updated, and `corepack pnpm api:test` then passed.
- README was not updated because Phase 20 does not add a user-facing CLI command, runtime requirement, top-level product workflow, or visible Jobs UI behavior. The owning docs for API, architecture, and QA were updated.
