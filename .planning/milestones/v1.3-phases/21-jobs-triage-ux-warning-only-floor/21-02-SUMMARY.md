---
phase: 21-jobs-triage-ux-warning-only-floor
plan: "02"
subsystem: projections
tags: [python, projections, compensation, tdd, parity]

requires:
  - phase: 21-jobs-triage-ux-warning-only-floor
    provides: TypeScript floorComparison contract from Plan 21-01
  - phase: 20-canonical-read-model-realtime-api
    provides: Python compensation summary/audit projection baseline
provides:
  - Python projection-owned floorComparison JSON matching the TypeScript contract
  - Numeric profile-floor parsing from candidate_profiles.compensation_salary_range_min
  - Parity tests for posted, posted-plus-market, unconfigured, and no-comparable floor states
affects: [phase-21-jobs-triage-ux, python-projections, compensation-read-model]

tech-stack:
  added: []
  patterns:
    - Python projection parity helpers mirror TypeScript floorComparison semantics
    - TDD RED/GREEN commits for cross-language read-model parity

key-files:
  created:
    - .planning/phases/21-jobs-triage-ux-warning-only-floor/21-02-SUMMARY.md
  modified:
    - workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py
    - workers/automation/tests/test_projection_builder.py

key-decisions:
  - "Python floor comparison reads only numeric candidate_profiles.compensation_salary_range_min and ignores free-text salary expectations."
  - "Legacy raw jobs.salary remains compatibility data and is not used as a floor comparison basis."
  - "Floor comparison contributes at most one compensation warning and stays out of provider, workflow, apply, ranking, and dispatch paths."

patterns-established:
  - "Python build_compensation_floor_comparison returns the same basis/state/warningLabels contract as TypeScript."
  - "Projection tests assert floorComparison excludes profile free text, provider identifiers, credentials, and local paths."

requirements-completed: [UI-03, UI-04]

duration: 3m25s
completed: 2026-06-20
---

# Phase 21 Plan 02: Python Projection Parity for Floor Comparison Summary

**Python compensation projections now emit TypeScript-compatible warning-only floorComparison JSON from safe numeric profile floor data.**

## Performance

- **Duration:** 3m25s
- **Started:** 2026-06-20T22:30:41Z
- **Completed:** 2026-06-20T22:34:06Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added RED Python projection tests for below-floor posted compensation, both posted and market below floor, non-numeric profile floor, and no comparable structured compensation basis.
- Implemented Python helpers `build_compensation_floor_comparison`, `parse_numeric_profile_compensation_minimum`, and `compare_compensation_range_to_floor`.
- Added `floorComparison` to both Python compensation summary and audit projection JSON.
- Preserved the warning-only boundary: floor warnings affect only compensation warning counts and do not touch apply, provider, workflow, ranking, filtering, or dispatch code paths.

## Task Commits

1. **Task 1: Add Python parity tests for floor comparison** - `556b15b` (test)
2. **Task 2: Implement Python floor comparison parity** - `4e86ea7` (feat)

## Files Created/Modified

- `workers/automation/tests/test_projection_builder.py` - Adds synthetic safe parity fixtures and floorComparison assertions.
- `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py` - Builds floorComparison summary/audit JSON from numeric profile floor plus structured posted/market ranges.
- `.planning/phases/21-jobs-triage-ux-warning-only-floor/21-02-SUMMARY.md` - Execution summary.

## Verification

- RED: `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py -q` failed before implementation because Python projections lacked `floorComparison` and did not add the floor warning count.
- GREEN focused: `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py -q` passed, 13 tests.
- GREEN plan command: `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_projection_builder.py workers/automation/tests/test_posted_compensation_repository.py workers/automation/tests/test_market_compensation_repository.py -q && uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py workers/automation/tests/test_projection_builder.py` passed, 29 tests and Ruff clean.
- Boundary check: `git show --name-only --oneline 4e86ea7` showed only `projection_builder.py` and `test_projection_builder.py`; no workflow, apply, provider, network, or dispatch files changed.

## Decisions Made

- Mirrored the TypeScript basis values exactly: `posted_salary_basis`, `market_estimate_basis`, `both_posted_and_market`, `no_comparable_compensation_basis`, and `floor_not_configured`.
- Treated missing/non-numeric profile floor as `floor_not_configured` with zero floor warning count.
- Treated absent or incompatible structured posted/market ranges as `no_comparable_compensation_basis` and did not parse or compare legacy raw salary text.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The initial RED fixture insert failed because `candidate_profiles.updated_at` is required. The test helper was corrected before the RED commit so the suite failed on the intended missing floorComparison behavior.
- The Python synthetic fixture uses existing canonical component labels (`unknown` for the posted parser and `total_compensation` for market estimates), while the TypeScript fixture used `base`. Assertions were adjusted to verify the Python canonical rows while preserving the shared floorComparison field names and states.

## Known Stubs

None. Stub scan found only existing SQL placeholder helper names, not UI/runtime stubs.

## Threat Flags

None. No new network endpoints, auth paths, file access patterns, schema changes, provider access, or apply dispatch surfaces were introduced.

## Authentication Gates

None.

## Next Phase Readiness

Plan 21-03 can consume `compensationSummary.floorComparison` from Python-refreshed projections with TypeScript/Python parity preserved. Profile-floor comparison remains warning-only and safe for Jobs triage display.

## Self-Check: PASSED

- Found modified files on disk: `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `workers/automation/tests/test_projection_builder.py`.
- Found task commits: `556b15b`, `4e86ea7`.
- TDD gate compliance: RED `test(21-02)` commit precedes GREEN `feat(21-02)` commit.

---
*Phase: 21-jobs-triage-ux-warning-only-floor*
*Completed: 2026-06-20*
