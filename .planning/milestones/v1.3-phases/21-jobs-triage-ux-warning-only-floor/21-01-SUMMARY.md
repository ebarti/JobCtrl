---
phase: 21-jobs-triage-ux-warning-only-floor
plan: "01"
subsystem: api
tags: [typescript, api, projections, compensation, tdd]

requires:
  - phase: 20-canonical-read-model-realtime-api
    provides: projection-backed compensation summary/audit JSON and warning-only API boundary
provides:
  - Safe JobCompensationFloorComparison DTOs on compensation summary and audit payloads
  - TypeScript projection-owned floor comparison from numeric profile compensation minimum
  - API boundary tests proving floor warnings do not change sort/filter/apply behavior
affects: [phase-21-jobs-triage-ux, compensation-read-model, jobs-api]

tech-stack:
  added: []
  patterns:
    - Projection-owned warning-only DTO derived from canonical profile and compensation rows
    - TDD RED/GREEN commits for API contract changes

key-files:
  created:
    - .planning/phases/21-jobs-triage-ux-warning-only-floor/21-01-SUMMARY.md
  modified:
    - packages/contracts/src/schemas.ts
    - apps/api/src/projections.ts
    - apps/api/test/projections.test.ts
    - apps/api/test/server.test.ts
    - docs/local-ts-api.md

key-decisions:
  - "Profile-floor comparison is computed in the TypeScript projection layer from numeric compensation_salary_range_min only."
  - "Floor comparison contributes at most one compensation warning and never changes sort, filter, fit-score, apply readiness, blockers, or dispatch behavior."

patterns-established:
  - "Floor comparison DTO keeps posted and market arms separate while exposing an explicit basis label."
  - "Unsafe profile text and provider payloads stay out of floor comparison JSON."

requirements-completed: [UI-03, UI-04]

duration: 3 min
completed: 2026-06-20
---

# Phase 21 Plan 01: Warning-Only Floor Comparison Contract Summary

**Projection-owned profile-floor comparison added to compensation summary/audit JSON without changing Jobs ranking, filtering, or apply behavior.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-06-20T22:25:04Z
- **Completed:** 2026-06-20T22:28:19Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Added RED tests for floor basis states, floor warning-count contribution, non-numeric profile-floor behavior, and API boundary safety.
- Added `JobCompensationFloorComparison` contract fields to both `JobCompensationSummary` and `JobCompensationAudit`.
- Implemented TypeScript projection helpers `buildCompensationFloorComparison`, `parseNumericProfileCompensationMinimum`, and `compareCompensationRangeToFloor`.
- Updated `docs/local-ts-api.md` with the additive floor comparison fields and warning-only boundary.

## Task Commits

1. **Task 1: Lock the floor comparison contract with failing tests** - `a3deabb` (test)
2. **Task 2: Implement TypeScript projection-owned floor comparison** - `1c9ee1b` (feat)

## Files Created/Modified

- `packages/contracts/src/schemas.ts` - Adds floor basis/state types and `floorComparison` fields.
- `apps/api/src/projections.ts` - Computes floor comparison from numeric profile minimum and structured posted/market ranges.
- `apps/api/test/projections.test.ts` - Covers floor warning basis, both-source comparisons, non-numeric floor, and unsafe payload exclusion.
- `apps/api/test/server.test.ts` - Proves floor warnings remain compensation-only and out of sort/filter/apply behavior.
- `docs/local-ts-api.md` - Documents the additive read-model fields and warning-only constraints.
- `.planning/phases/21-jobs-triage-ux-warning-only-floor/21-01-SUMMARY.md` - Execution summary.

## Verification

- RED: `corepack pnpm --filter @jobhunter/api exec vitest run test/projections.test.ts -t "compensation"` failed before implementation because `floorComparison` was missing and warning count stayed at 3.
- RED: `corepack pnpm --filter @jobhunter/api exec vitest run test/server.test.ts -t "compensation boundary"` failed before implementation because the API response lacked `floorComparison` and warning count stayed at 0.
- GREEN: `corepack pnpm --filter @jobhunter/contracts check` passed.
- GREEN: `corepack pnpm api:check` passed.
- GREEN: `corepack pnpm --filter @jobhunter/api exec vitest run test/projections.test.ts -t "compensation"` passed.
- GREEN: `corepack pnpm --filter @jobhunter/api exec vitest run test/server.test.ts -t "compensation boundary"` passed.
- Boundary diff: `git diff -- packages/contracts/src/schemas.ts apps/api/src/projections.ts` showed additive compensation DTO/projection changes only, with no sort/filter/apply dispatch wiring.

## Decisions Made

- Used only `candidate_profiles.compensation_salary_range_min` plus profile currency for floor comparison; free-text salary expectation is ignored.
- A below-floor result contributes one compensation warning regardless of whether posted, market, or both sources are below floor.
- `floor_not_configured` and `no_comparable_compensation_basis` are explicit states so the UI can distinguish missing profile floor from incomparable compensation rows.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Initial GREEN run exposed an `exactOptionalPropertyTypes` issue for optional annualized fields in the projection helper. Fixed before the GREEN commit by omitting optional fields when absent.
- Initial GREEN run exposed a basis-label mismatch: the DTO basis is the below-floor warning basis, while posted/market arms carry the comparable-source details. Fixed before the GREEN commit.

## Known Stubs

None.

## Authentication Gates

None.

## Next Phase Readiness

Plan 21-02 can add Python projection parity against the TypeScript floor comparison semantics. UI plans can consume `compensationSummary.floorComparison` and `compensationAudit.floorComparison` without React-side profile parsing.

## Self-Check: PASSED

- Found modified files on disk: `packages/contracts/src/schemas.ts`, `apps/api/src/projections.ts`, `apps/api/test/projections.test.ts`, `apps/api/test/server.test.ts`, `docs/local-ts-api.md`.
- Found task commits: `a3deabb`, `1c9ee1b`.
- TDD gate compliance: RED `test(21-01)` commit precedes GREEN `feat(21-01)` commit.

---
*Phase: 21-jobs-triage-ux-warning-only-floor*
*Completed: 2026-06-20*
