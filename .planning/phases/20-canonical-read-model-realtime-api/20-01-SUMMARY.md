---
phase: 20-canonical-read-model-realtime-api
plan: 20-01
status: completed
completed: 2026-06-19
requirements-completed:
  - EST-05
  - API-01
  - API-02
  - API-04
  - API-05
key-files:
  created: []
  modified:
    - apps/api/src/projections.ts
    - apps/api/test/audit-projection-parity.test.ts
    - apps/api/test/projections.test.ts
    - workers/automation/src/jobhunter/domain/operations/projections.py
    - workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py
    - workers/automation/src/jobhunter/infrastructure/projections/sqlite_projection_store.py
    - workers/automation/tests/test_projection_builder.py
---

# Phase 20 Plan 20-01: Compensation Projection Parity Summary

## Completed

- Added `compensation_summary_json` to job list projections.
- Added `compensation_summary_json` and `compensation_audit_json` to job detail projections.
- Added idempotent TypeScript projection schema upgrades and matching Python projection store schema.
- Extended Python projection dataclasses with compensation summary and audit fields.
- Built posted and market compensation projection sections from canonical persisted rows, keeping posted salary facts and reported company-role estimates separate.
- Preserved raw `jobs.salary` as compatibility fallback only; no read-time parsing was added to the list/detail API path.
- Added TypeScript and Python projection regressions for parsed posted salary plus Levels.fyi/Glassdoor reported company-role estimate rows.
- Updated the shared audit parity fixture schema to include the existing canonical `jobs.salary` compatibility column now required by the compensation projection refresh.

## Verification

- `corepack pnpm --filter @jobhunter/api exec vitest run test/projections.test.ts -t "compensation"` - passed, 1 test.
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_market_compensation_repository.py -q` - passed, 24 tests.
- `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py workers/automation/src/jobhunter/infrastructure/projections/sqlite_projection_store.py workers/automation/src/jobhunter/domain/operations/projections.py workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py workers/automation/src/jobhunter/infrastructure/compensation/sqlite_market_repository.py workers/automation/tests/test_projection_builder.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_market_compensation_repository.py` - passed.
- `corepack pnpm api:test` - passed, 14 files and 243 tests.

## Deviations from Plan

None. The parity fixture update was a required test-harness alignment after compensation projections made the pre-existing raw salary compatibility column part of the projection refresh path.

## Self-Check: PASSED

Plan 20-01 satisfies the canonical projection parity scope. Compensation summaries and audits are persisted projection data, not client-side or read-time parsing.
